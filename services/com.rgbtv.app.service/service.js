/* RGBTv webOS JS Service — authenticated helper for Stalker and phone pairing.
 * fetch is intentionally limited to HTTP(S), safe methods, safe headers and bounded bodies. */
var Service = require('webos-service');
var http = require('http'), https = require('https'), url = require('url'), os = require('os'), crypto = require('crypto'), zlib = require('zlib');
var service = new Service('com.rgbtv.app.service');
/* Provider M3U/XMLTV exports commonly reach 5–40 MiB. Keep a bounded 64 MiB
   response ceiling while allowing the client-facing 120-second playlist timeout. */
var MAX_REQUEST_BODY = 1024 * 1024, MAX_RESPONSE_BODY = 64 * 1024 * 1024, MAX_TIMEOUT = 120000;
var DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
  'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'keep-alive'
};
var ALLOWED_HEADERS = { 'accept': 1, 'accept-language': 1, 'authorization': 1, 'content-type': 1, 'cookie': 1, 'referer': 1, 'user-agent': 1, 'x-user-agent': 1 };
/* A Stalker login is several small, authenticated requests. Reusing a bounded
   connection pool prevents a new TCP connection for every handshake/profile call,
   which is a common trigger for anti-flood rules on older portals. */
var httpAgent = new http.Agent({ keepAlive: true, maxSockets: 4 });
var httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 4 });
/* HTTP 429 is a server instruction to slow down, not an alternate-endpoint error.
   Keep this state service-wide so Retry cannot create a second request storm. */
var rateLimits = {}, MAX_RATE_RETRIES = 3, MIN_RATE_DELAY = 2500, MAX_RATE_DELAY = 60000;

function copy(o) { var r = {}, k; for (k in o || {}) if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k]; return r; }
function clampTimeout(n) { n = Number(n) || 20000; return Math.max(1000, Math.min(MAX_TIMEOUT, n)); }
function validHttpUrl(raw) { var u = url.parse(String(raw || '')); return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname ? u : null; }
/* The proxy is for IPTV panels, never the TV's own loopback / link-local services. Keep RFC1918 LAN
   addresses usable: many installations deliberately host their portal on a home receiver or NAS. */
function unsafeTarget(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host === 'localhost.localdomain' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /(^|:)ffff:127\./.test(host) || /^fe[89ab][0-9a-f]*:/.test(host)) return true;
  var m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    /* Reject octal-looking segments too: older Node URL parsers can read 0177.0.0.1 as loopback. */
    if (m.slice(1).some(function (x) { return x.length > 1 && x.charAt(0) === '0'; })) return true;
    return Number(m[1]) === 127 || Number(m[1]) === 0 || (Number(m[1]) === 169 && Number(m[2]) === 254);
  }
  /* Reject non-canonical numeric hosts: Node accepts one-, two-, three-part, octal and hex IPv4 forms. */
  if (/^\d+(?:\.\d+){1,3}$/.test(host) || /^(?:0x[0-9a-f]+|\d+(?:\.\d+){0,2})$/i.test(host)) return true;
  return false;
}
function safeHeaders(input) {
  var out = copy(DEFAULT_HEADERS), k, low, v;
  for (k in input || {}) if (Object.prototype.hasOwnProperty.call(input, k)) {
    low = String(k).toLowerCase();
    if (!ALLOWED_HEADERS[low]) continue;
    v = String(input[k]);
    if (v.length <= 8192 && !/[\r\n]/.test(v)) out[k] = v;
  }
  return out;
}
function withoutCredentials(input) {
  var out = {}, k;
  for (k in input || {}) if (Object.prototype.hasOwnProperty.call(input, k) && String(k).toLowerCase() !== 'authorization' && String(k).toLowerCase() !== 'cookie') out[k] = input[k];
  return out;
}
function sameOrigin(a, b) {
  return a.protocol === b.protocol && String(a.hostname).toLowerCase() === String(b.hostname).toLowerCase() && String(a.port || '') === String(b.port || '');
}
/* Some playlist portals set a short session cookie before redirecting to the
   actual get.php URL. Retain only name=value pairs and only across same-origin
   redirects; authorization/cookies are still stripped on cross-origin jumps. */
function redirectCookies(current, incoming) {
  var map = {}, order = [];
  function put(raw) {
    raw = String(raw || '').split(';')[0]; var p = raw.indexOf('='); if (p < 1) return;
    var name = raw.slice(0, p).trim(); if (!name) return;
    if (!Object.prototype.hasOwnProperty.call(map, name)) order.push(name);
    map[name] = name + '=' + raw.slice(p + 1).trim();
  }
  String(current || '').split(';').forEach(put);
  (Array.isArray(incoming) ? incoming : incoming ? [incoming] : []).forEach(put);
  return order.map(function (k) { return map[k]; }).join('; ');
}
function decodeResponse(body, encoding, cb) {
  encoding = String(encoding || '').toLowerCase().split(',')[0].trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') { zlib.gunzip(body, cb); return; }
  if (encoding === 'deflate') { zlib.inflate(body, cb); return; }
  cb(null, body);
}
function originKey(u) { return String(u.protocol || '').toLowerCase() + '//' + String(u.hostname || '').toLowerCase() + ':' + String(u.port || (u.protocol === 'https:' ? 443 : 80)); }
function retryDelay(headers, attempt) {
  var raw = headers && headers['retry-after'], delay = 0, n, at;
  if (raw != null) {
    n = Number(raw);
    if (isFinite(n) && n >= 0) delay = Math.round(n * 1000);
    else { at = Date.parse(raw); if (!isNaN(at)) delay = Math.max(0, at - Date.now()); }
  }
  /* A provider that omits Retry-After still gets a calm exponential backoff. */
  if (!delay) delay = MIN_RATE_DELAY * Math.pow(2, attempt || 0);
  return Math.max(MIN_RATE_DELAY, Math.min(MAX_RATE_DELAY, delay));
}
function rateError(delay) { var e = new Error('HTTP 429 rate limited — retry in ' + Math.max(1, Math.ceil(delay / 1000)) + ' seconds'); e.status = 429; e.retryAfter = delay; return e; }

function doFetch(opts, cb, redirects, rateRetries, startedAt, skipRateGate) {
  redirects = redirects || 0; rateRetries = rateRetries || 0; startedAt = startedAt || Date.now();
  var u = validHttpUrl(opts.url), body = opts.body == null ? null : String(opts.body), finished = false;
  if (!u) { cb(new Error('Only absolute HTTP(S) URLs are allowed')); return; }
  if (unsafeTarget(u.hostname)) { cb(new Error('Loopback and link-local proxy targets are blocked')); return; }
  if (['GET', 'HEAD', 'POST'].indexOf(String(opts.method || 'GET').toUpperCase()) < 0) { cb(new Error('HTTP method not allowed')); return; }
  if (body && Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY) { cb(new Error('Request body too large')); return; }
  var timeout = clampTimeout(opts.timeout), origin = originKey(u), cooldown = Number(rateLimits[origin]) || 0, wait = cooldown - Date.now();
  /* A second UI request during a Retry-After window joins the cooldown instead of
     hitting the portal again. Never wait past the caller's own timeout. */
  if (!skipRateGate && wait > 0) {
    if (Date.now() - startedAt + wait >= timeout) { cb(rateError(wait)); return; }
    setTimeout(function () { doFetch(opts, cb, redirects, rateRetries, startedAt, true); }, wait);
    return;
  }
  function finish(err, result) { if (finished) return; finished = true; cb(err, result); }
  var mod = u.protocol === 'https:' ? https : http;
  var req = mod.request({
    hostname: u.hostname, port: u.port, path: u.path || '/', method: String(opts.method || 'GET').toUpperCase(),
    headers: safeHeaders(opts.headers), rejectUnauthorized: opts.insecureTls !== true, timeout: timeout,
    agent: u.protocol === 'https:' ? httpsAgent : httpAgent
  }, function (res) {
    /* Do not let the endpoint discovery code turn one 429 into seven rapid requests.
       Retry only idempotent reads, on the same endpoint, after the provider's delay. */
    if (res.statusCode === 429) {
      var delay = retryDelay(res.headers, rateRetries), elapsed = Date.now() - startedAt;
      rateLimits[origin] = Math.max(Number(rateLimits[origin]) || 0, Date.now() + delay);
      res.resume();
      if (rateRetries >= MAX_RATE_RETRIES || elapsed + delay >= timeout) { finish(rateError(delay)); return; }
      setTimeout(function () { doFetch(opts, finish, redirects, rateRetries + 1, startedAt, true); }, delay);
      return;
    }
    if (rateLimits[origin] && rateLimits[origin] <= Date.now()) delete rateLimits[origin];
    if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && redirects < 5) {
      var nextUrl = url.resolve(opts.url, res.headers.location), next = validHttpUrl(nextUrl);
      res.resume();
      if (!next) { finish(new Error('Redirect URL is not HTTP(S)')); return; }
      var nextOpts = copy(opts); nextOpts.url = nextUrl;
      if (!sameOrigin(u, next)) nextOpts.headers = withoutCredentials(opts.headers);
      else {
        nextOpts.headers = copy(opts.headers);
        var cookies = redirectCookies(nextOpts.headers.Cookie || nextOpts.headers.cookie, res.headers['set-cookie']);
        if (cookies) nextOpts.headers.Cookie = cookies;
      }
      if (res.statusCode === 303) { nextOpts.method = 'GET'; nextOpts.body = null; }
      doFetch(nextOpts, finish, redirects + 1, rateRetries, startedAt); return;
    }
    var chunks = [], size = 0;
    res.on('data', function (c) {
      if (finished) return;
      size += c.length;
      if (size > MAX_RESPONSE_BODY) { try { req.abort(); } catch (e) { } finish(new Error('Response body too large')); return; }
      chunks.push(c);
    });
    res.on('end', function () {
      if (finished) return;
      decodeResponse(Buffer.concat(chunks), res.headers['content-encoding'], function (err, bodyOut) {
        if (err) { finish(new Error('Could not decode server response')); return; }
        if (bodyOut.length > MAX_RESPONSE_BODY) { finish(new Error('Response body too large')); return; }
        finish(null, { status: res.statusCode, headers: res.headers, body: bodyOut.toString('utf8') });
      });
    });
    res.on('error', function (e) { finish(e); });
  });
  req.on('timeout', function () { try { req.abort(); } catch (e) { } finish(new Error('Timeout')); });
  req.on('error', function (e) { finish(e); });
  if (body) req.write(body);
  req.end();
}

service.register('fetch', function (message) {
  var p = message.payload || {};
  if (!p.url) { message.respond({ returnValue: false, errorText: 'url required' }); return; }
  doFetch(p, function (err, r) {
    if (err) message.respond({ returnValue: false, errorText: String(err.message || err), status: Number(err.status || 0), retryAfter: Number(err.retryAfter || 0) });
    else message.respond({ returnValue: true, status: r.status, headers: r.headers, body: r.body });
  });
});
service.register('ping', function (message) { message.respond({ returnValue: true, pong: true, time: Date.now() }); });

/* Add from phone: a short-lived, token-protected LAN listener. */
var PAIR_PORT = 8765, pairActivity = null, pairServer = null, pairQueue = [], pairToken = null, pairKeepAlive = null;
function lanIPs() {
  var out = [], ifs = os.networkInterfaces();
  Object.keys(ifs).forEach(function (n) { (ifs[n] || []).forEach(function (a) { if (a.family === 'IPv4' && !a.internal) out.push(a.address); }); });
  return out;
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function safeText(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }
function validPairProfile(raw) {
  var d = raw || {}, type = safeText(d.type, 16), name = safeText(d.name, 40), serverUrl = safeText(d.url, 2048), mac;
  if (!/^(xtream|stalker|m3u)$/.test(type) || !name || !validHttpUrl(serverUrl)) return null;
  var out = { type: type, name: name, url: serverUrl, pin: /^\d{4}$/.test(String(d.pin || '')) ? String(d.pin) : '' };
  if (type === 'xtream') { out.username = safeText(d.username, 256); out.password = safeText(d.password, 512); if (!out.username || !out.password) return null; }
  if (type === 'stalker') { mac = safeText(d.mac, 17).toUpperCase().replace(/-/g, ':'); if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return null; out.mac = mac; }
  if (type === 'm3u') out.epg = safeText(d.epg, 2048);
  return out;
}
function pairPage(lang, token) {
  var ar = lang === 'ar';
  var t = ar ? { title: 'إضافة سيرفر إلى RGBTv', sub: 'امسح رمز QR الظاهر على التلفاز، ثم أرسل البيانات. هذه الصفحة مؤمّنة برمز مؤقت.', name: 'اسم البروفايل', type: 'نوع السيرفر', url: 'رابط السيرفر', user: 'اسم المستخدم', pass: 'كلمة المرور', mac: 'عنوان MAC', epg: 'رابط EPG (اختياري)', pin: 'رمز PIN (اختياري، 4 أرقام)', send: 'إرسال إلى التلفاز', ok: 'تم الإرسال ✓ — أكّد العملية على التلفاز', err: 'تعذر الإرسال، تحقق من البيانات وحاول مجددًا', m3uHint: 'أو ألصق رابط get.php الكامل هنا', dir: 'rtl' }
             : { title: 'Add a server to RGBTv', sub: 'Scan the QR code displayed on the TV, then send the details. This page is protected by a temporary code.', name: 'Profile name', type: 'Server type', url: 'Server URL', user: 'Username', pass: 'Password', mac: 'MAC address', epg: 'EPG URL (optional)', pin: 'PIN (optional, 4 digits)', send: 'Send to TV', ok: 'Sent ✓ — confirm on the TV', err: 'Could not send. Check the details and try again.', m3uHint: 'or paste a full get.php link here', dir: 'ltr' };
  return '<!DOCTYPE html><html lang="' + (ar ? 'ar' : 'en') + '" dir="' + t.dir + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + t.title + '</title><style>' +
    'body{margin:0;background:#0a0e1a;color:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:20px}h1{font-size:22px;margin:0 0 6px}h1 span{background:linear-gradient(90deg,#ef4444,#22c55e,#3b82f6);-webkit-background-clip:text;color:transparent}p{color:#9aa3b2;font-size:14px;margin:0 0 18px}label{display:block;font-size:13px;color:#9aa3b2;margin:12px 0 4px}input,select{width:100%;box-sizing:border-box;padding:13px 14px;border-radius:10px;border:1px solid #2a3350;background:#141b30;color:#fff;font-size:16px}.tabs{display:flex;gap:8px;margin-top:8px}.tabs button{flex:1;padding:12px;border-radius:10px;border:1px solid #2a3350;background:#141b30;color:#9aa3b2;font-size:14px}.tabs button.on{background:#6d5dfc;color:#fff;border-color:#6d5dfc}.f{display:none}.f.on{display:block}button.send{width:100%;margin-top:22px;padding:16px;border:0;border-radius:12px;background:#6d5dfc;color:#fff;font-size:17px;font-weight:700}#msg{margin-top:14px;font-size:15px;text-align:center;min-height:20px}.ok{color:#4ade80}.bad{color:#f87171}small{color:#6b7280}</style></head><body><h1>RGB<span>Tv</span> · ' + t.title + '</h1><p>' + t.sub + '</p>' +
    '<form id="f" onsubmit="return send()"><input type="hidden" name="token" value="' + token + '"><label>' + t.name + '</label><input name="name" required placeholder="Living room">' +
    '<label>' + t.type + '</label><div class="tabs"><button type="button" class="on" data-t="xtream">Xtream Codes</button><button type="button" data-t="stalker">Stalker</button><button type="button" data-t="m3u">M3U</button></div><input type="hidden" name="type" value="xtream">' +
    '<label>' + t.url + '</label><input name="url" required placeholder="http://host:port" inputmode="url" autocapitalize="off"><small id="hint">' + t.m3uHint + '</small>' +
    '<div class="f on" data-f="xtream"><label>' + t.user + '</label><input name="username" autocapitalize="off" required><label>' + t.pass + '</label><input name="password" type="password" autocapitalize="off" required></div>' +
    '<div class="f" data-f="stalker"><label>' + t.mac + '</label><input name="mac" placeholder="00:1A:79:XX:XX:XX" autocapitalize="characters"></div><div class="f" data-f="m3u"><label>' + t.epg + '</label><input name="epg" inputmode="url" autocapitalize="off"></div>' +
    '<label>' + t.pin + '</label><input name="pin" maxlength="4" inputmode="numeric" pattern="\\d{4}"><button class="send" type="submit">' + t.send + '</button><div id="msg"></div></form>' +
    '<script>var tabs=document.querySelectorAll(".tabs button");for(var i=0;i<tabs.length;i++)tabs[i].onclick=function(){for(var j=0;j<tabs.length;j++)tabs[j].className="";this.className="on";var t=this.getAttribute("data-t");document.querySelector("[name=type]").value=t;var fs=document.querySelectorAll(".f");for(var k=0;k<fs.length;k++)fs[k].className="f"+(fs[k].getAttribute("data-f")===t?" on":"");document.getElementById("hint").style.display=t==="xtream"?"":"none";document.querySelector("[name=username]").required=t==="xtream";document.querySelector("[name=password]").required=t==="xtream";};function send(){var f=document.getElementById("f"),d={},els=f.elements;for(var i=0;i<els.length;i++)if(els[i].name)d[els[i].name]=els[i].value;var x=new XMLHttpRequest();x.open("POST","/add",true);x.setRequestHeader("Content-Type","application/json");x.onload=function(){var m=document.getElementById("msg");if(x.status===200){m.className="ok";m.textContent="' + t.ok + '";f.reset();}else{m.className="bad";m.textContent="' + t.err + '";}};x.onerror=function(){document.getElementById("msg").className="bad";document.getElementById("msg").textContent="' + t.err + '";};x.send(JSON.stringify(d));return false;}</script></body></html>';
}
function startPairServer(lang, cb) {
  if (pairServer) { cb(null); return; }
  pairToken = newToken();
  pairServer = http.createServer(function (req, res) {
    var u = url.parse(req.url, true);
    if ((req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) && u.query.token === pairToken) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' }); res.end(pairPage(u.query.lang === 'ar' ? 'ar' : lang, pairToken)); return;
    }
    if (req.method === 'POST' && u.pathname === '/add') {
      var chunks = [], size = 0, rejected = false;
      req.on('data', function (c) { size += c.length; if (size > 20000) { rejected = true; } else chunks.push(c); });
      req.on('end', function () {
        var raw, d;
        try { if (rejected) throw new Error('large'); raw = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (!raw || raw.token !== pairToken) throw new Error('token'); d = validPairProfile(raw); if (!d) throw new Error('bad'); if (pairQueue.length >= 5) throw new Error('full'); d.at = Date.now(); pairQueue.push(d); res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"ok":true}'); }
        catch (e) { res.writeHead(rejected ? 413 : 400, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); }
      });
      return;
    }
    res.writeHead((u.pathname === '/' || u.pathname === '/index.html') ? 403 : 404); res.end();
  });
  pairServer.on('error', function (e) { pairServer = null; pairToken = null; cb(e); });
  pairServer.listen(PAIR_PORT, '0.0.0.0', function () { cb(null); });
}
function stopPairServer() {
  if (pairServer) { try { pairServer.close(); } catch (e) { } pairServer = null; }
  pairQueue = []; pairToken = null;
  if (pairKeepAlive) { clearTimeout(pairKeepAlive); pairKeepAlive = null; }
  if (pairActivity && service.activityManager && service.activityManager.complete) { try { service.activityManager.complete(pairActivity, function () { }); } catch (e) { } pairActivity = null; }
}
service.register('pairStart', function (message) {
  var p = message.payload || {};
  startPairServer(p.lang === 'ar' ? 'ar' : 'en', function (err) {
    if (err) { message.respond({ returnValue: false, errorText: String(err.message || err) }); return; }
    if (pairKeepAlive) clearTimeout(pairKeepAlive);
    if (!pairActivity && service.activityManager && service.activityManager.create) { try { service.activityManager.create('rgbtv-pair', function (a) { pairActivity = a; }); } catch (e) { } }
    pairKeepAlive = setTimeout(stopPairServer, 10 * 60000);
    message.respond({ returnValue: true, ips: lanIPs(), port: PAIR_PORT, token: pairToken });
  });
});
service.register('pairPoll', function (message) {
  var q = pairQueue; pairQueue = [];
  if (pairKeepAlive) { clearTimeout(pairKeepAlive); pairKeepAlive = setTimeout(stopPairServer, 10 * 60000); }
  message.respond({ returnValue: true, items: q, running: !!pairServer });
});
service.register('pairStop', function (message) { stopPairServer(); message.respond({ returnValue: true }); });
