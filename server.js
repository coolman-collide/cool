// UltraProx server - zero dependencies, needs Node 18+
const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { Readable } = require('stream');

const PORT = process.env.PORT || 8080;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const jar = new Map(); // hostname -> Map(cookieName -> value)

const SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;
function px(u, base) {
  if (!u) return u;
  u = u.trim();
  if (SKIP.test(u)) return u;
  try {
    const a = new URL(u, base);
    return /^https?:$/.test(a.protocol) ? '/p/' + a.href : u;
  } catch { return u; }
}
const unamp = s => s.replace(/&amp;/g, '&');

function rewriteCSS(css, base) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => `url(${q}${px(u, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${px(u, base)}${q}`);
}

function rewriteHTML(html, base) {
  html = html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|refresh)[^>]*>/gi, '')
    .replace(/\s(integrity|nonce|crossorigin)=("[^"]*"|'[^']*')/gi, '');
  html = html.replace(/(\s(?:href|src|action|poster|data-src|data-href)\s*=\s*)(["'])(.*?)\2/gi,
    (m, a, q, v) => a + q + px(unamp(v), base) + q);
  html = html.replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, v) =>
    a + q + v.split(',').map(s => {
      const p = s.trim().split(/\s+/);
      p[0] = px(unamp(p[0]), base);
      return p.join(' ');
    }).join(', ') + q);
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, m => rewriteCSS(m, base));
  html = html.replace(/(\sstyle\s*=\s*)(["'])(.*?)\2/gi, (m, a, q, v) => a + q + rewriteCSS(v, base) + q);
  const inject = `<script>window.__UP=${JSON.stringify(base)};</script><script src="/__shim.js"></script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : inject + html;
}

// Runs inside proxied pages: routes dynamic requests back through the proxy
const SHIM = `(function(){
var UP=window.__UP,attrs=['src','href','action','poster'];
function px(u){try{u=String(u);if(/^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(u))return u;
if(u.indexOf('/p/http')===0||u.indexOf(location.origin+'/p/')===0)return u;
var a=new URL(u,UP);if(!/^https?:$/.test(a.protocol))return u;return '/p/'+a.href}catch(e){return u}}
var of=window.fetch;window.fetch=function(i,o){if(typeof i==='string'||i instanceof URL)i=px(i);else if(i&&i.url)i=new Request(px(i.url),i);return of.call(this,i,o)};
var ox=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=px(u);return ox.apply(this,arguments)};
var wo=window.open;window.open=function(u){if(u)arguments[0]=px(u);return wo.apply(this,arguments)};
['pushState','replaceState'].forEach(function(k){var f=history[k];history[k]=function(s,t,u){if(u)arguments[2]=px(u);return f.apply(this,arguments)}});
var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){if(attrs.indexOf(String(n).toLowerCase())>-1&&typeof v==='string')v=px(v);return sa.call(this,n,v)};
[[HTMLImageElement,'src'],[HTMLScriptElement,'src'],[HTMLLinkElement,'href'],[HTMLAnchorElement,'href'],[HTMLIFrameElement,'src'],[HTMLSourceElement,'src'],[HTMLMediaElement,'src']].forEach(function(p){
var d=Object.getOwnPropertyDescriptor(p[0].prototype,p[1]);if(d&&d.set)Object.defineProperty(p[0].prototype,p[1],{get:d.get,set:function(v){d.set.call(this,px(v))},configurable:true})});
function fix(el){attrs.forEach(function(a){var v=el.getAttribute&&el.getAttribute(a);if(v&&!/^\\/p\\//.test(v)&&!SKIPRE.test(v)){var n=px(v);if(n!==v)sa.call(el,a,n)}})}
var SKIPRE=/^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i;
new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType===1){fix(n);n.querySelectorAll('[src],[href],[action]').forEach(fix)}})})}).observe(document,{childList:true,subtree:true});
})();`;

function isPrivate(ip) {
  if (ip.includes(':')) return /^(::1?$|fe80|fc|fd)/i.test(ip) || /^::ffff:(127|10|0|192\.168|169\.254|172\.(1[6-9]|2\d|3[01]))\./i.test(ip);
  return /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
}
function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type });
  res.end(body);
}
function errPage(res, code, msg) {
  const esc = String(msg).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  send(res, code, 'text/html; charset=utf-8',
    `<body style="font-family:system-ui;background:#0a0b14;color:#f1f2ff;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h2>Couldn't load that page</h2><p style="color:#9aa0c8;max-width:480px">${esc}</p></div></body>`);
}
function readBody(req) {
  return new Promise((ok, bad) => {
    const c = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > 15e6) { bad(new Error('Body too large')); req.destroy(); } else c.push(d); });
    req.on('end', () => ok(Buffer.concat(c)));
    req.on('error', bad);
  });
}
const cookieFor = h => { const j = jar.get(h); return j ? [...j].map(([k, v]) => k + '=' + v).join('; ') : ''; };

async function proxy(req, res) {
  const target = req.url.slice(3).replace(/^(https?):\/(?!\/)/, '$1://');
  let u;
  try { u = new URL(target); } catch { return errPage(res, 400, 'That address is not valid.'); }
  if (!/^https?:$/.test(u.protocol)) return errPage(res, 400, 'Only http and https addresses are supported.');
  try {
    const { address } = await dns.lookup(u.hostname);
    if (isPrivate(address)) return errPage(res, 403, 'Local and private addresses are blocked.');
  } catch { return errPage(res, 502, 'Could not find that website (DNS lookup failed).'); }

  const h = {
    'user-agent': UA,
    accept: req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    referer: u.origin + '/'
  };
  if (req.headers.range) h.range = req.headers.range;
  const ck = cookieFor(u.hostname); if (ck) h.cookie = ck;
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readBody(req);
    h['content-type'] = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    h.origin = u.origin;
  }

  let r;
  try { r = await fetch(u.href, { method: req.method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(30000) }); }
  catch (e) { return errPage(res, 502, 'The site did not respond: ' + (e.cause && e.cause.code || e.message)); }

  for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    if (i > 0) { if (!jar.has(u.hostname)) jar.set(u.hostname, new Map()); jar.get(u.hostname).set(kv.slice(0, i).trim(), kv.slice(i + 1)); }
  }
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc) {
    res.writeHead(r.status, { location: px(loc, u.href) });
    return res.end();
  }
  const hd = {};
  for (const k of ['content-type', 'content-range', 'accept-ranges', 'content-disposition', 'last-modified']) {
    const v = r.headers.get(k); if (v) hd[k] = v;
  }
  const ct = hd['content-type'] || '';
  const isHTML = /text\/html/i.test(ct), isCSS = /text\/css/i.test(ct);
  if (isHTML || isCSS) {
    const buf = Buffer.from(await r.arrayBuffer());
    const cs = (ct.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
    let t; try { t = new TextDecoder(cs).decode(buf); } catch { t = buf.toString('utf8'); }
    t = isHTML ? rewriteHTML(t, u.href) : rewriteCSS(t, u.href);
    hd['content-type'] = (isHTML ? 'text/html' : 'text/css') + '; charset=utf-8';
    res.writeHead(r.status, hd);
    return res.end(t);
  }
  res.writeHead(r.status, hd);
  if (!r.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const p = req.url.split('?')[0];
    if (p === '/' || p === '/index.html') return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'ui.html')));
    if (p === '/__shim.js') return send(res, 200, 'application/javascript', SHIM);
    if (req.url.startsWith('/p/')) return await proxy(req, res);
    // Root-relative request from a proxied page: send it to the same site
    const m = (req.headers.referer || '').match(/\/p\/(https?:\/\/[^\/?#]+)/);
    if (m) { res.writeHead(307, { location: '/p/' + m[1] + req.url }); return res.end(); }
    send(res, 404, 'text/plain', 'Not found');
  } catch (e) {
    if (!res.headersSent) errPage(res, 500, e.message); else res.destroy();
  }
}).listen(PORT, () => console.log('\n  UltraProx is running -> http://localhost:' + PORT + '\n'));
