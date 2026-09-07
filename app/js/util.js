/* RGBTv — utilities */
var U = (function () {
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec); var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  }
  function clock(d) { d = d || new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function hm(ts) { var d = new Date(ts * 1000); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function b64dec(s) { try { return decodeURIComponent(escape(window.atob(s))); } catch (e) { try { return window.atob(s); } catch (e2) { return s || ''; } } }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function qs(obj) { return Object.keys(obj).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(obj[k]); }).join('&'); }
  function uuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function randomMac() { var h = '0123456789ABCDEF', s = '00:1A:79'; for (var i = 0; i < 3; i++) s += ':' + h[Math.random() * 16 | 0] + h[Math.random() * 16 | 0]; return s; }
  function normUrl(u) { u = (u || '').trim(); if (!/^https?:\/\//i.test(u)) u = 'http://' + u; return u.replace(/\/+$/, ''); }
  function isAdult(name) { return /adult|xxx|porn|18\+|erotic|for adults/i.test(name || ''); }

  /* Luna service bridge (webOS only). Lets us send Cookie/Authorization headers that XHR forbids. */
  var lunaAvailable = null;
  function luna(method, params) {
    return new Promise(function (resolve, reject) {
      if (typeof window.PalmServiceBridge === 'undefined') { reject(new Error('no luna')); return; }
      var b = new window.PalmServiceBridge(), t = setTimeout(function () { reject(new Error('Luna timeout')); }, (params.timeout || 20000) + 3000);
      b.onservicecallback = function (msg) { clearTimeout(t); try { var r = JSON.parse(msg); if (r.returnValue === false) reject(new Error(r.errorText || 'service error')); else resolve(r); } catch (e) { reject(e); } };
      b.call('luna://com.rgbtv.app.service/' + method, JSON.stringify(params));
    });
  }
  function lunaFetch(url, opt) {
    return luna('fetch', { url: url, method: opt.method || 'GET', headers: opt.headers || {}, body: opt.body || null, timeout: opt.timeout || 20000 }).then(function (r) {
      if (r.status >= 200 && r.status < 300) { if (opt.json) { try { return JSON.parse(r.body); } catch (e) { throw new Error('Invalid JSON from server'); } } return r.body; }
      throw new Error('HTTP ' + r.status);
    });
  }

  /* HTTP with timeout — plain XHR keeps webOS 3+ compatibility.
   * Requests that carry restricted headers (Cookie/Authorization) go through the Luna service on TV. */
  function http(url, opt) {
    opt = opt || {};
    if (window.RGBTvHost && RGBTvHost.fetchAsync && /^https?:/i.test(url)) return hostFetch(url, opt);
    var needsService = opt.headers && (opt.headers.Cookie || opt.headers.Authorization) && typeof window.PalmServiceBridge !== 'undefined' && lunaAvailable !== false;
    if (needsService) {
      return lunaFetch(url, opt).then(function (r) { lunaAvailable = true; return r; }).catch(function (e) {
        if (lunaAvailable === null && /no luna|Luna timeout|service error|Unknown service|not exist/i.test(e.message)) { lunaAvailable = false; return http(url, opt); }
        throw e;
      });
    }
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest(), done = false;
      x.open(opt.method || 'GET', url, true);
      x.timeout = opt.timeout || 20000;
      if (opt.headers) Object.keys(opt.headers).forEach(function (k) { try { x.setRequestHeader(k, opt.headers[k]); } catch (e) { } });
      x.onreadystatechange = function () {
        if (x.readyState !== 4 || done) return; done = true;
        if (x.status >= 200 && x.status < 300 || (x.status === 0 && x.responseText)) {
          if (opt.json) { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(new Error('Invalid JSON from server')); } }
          else resolve(x.responseText);
        } else reject(new Error('HTTP ' + x.status + (x.status === 0 ? ' (network/CORS)' : '')));
      };
      x.ontimeout = function () { if (!done) { done = true; reject(new Error('Timeout')); } };
      x.onerror = function () { if (!done) { done = true; reject(new Error('Network error')); } };
      x.send(opt.body || null);
    });
  }
  /* Android shell: native HttpURLConnection — custom headers OK, no CORS, media-player User-Agent (panels block WebView UAs with 512/403) */
  var hostCbs = {}, hostSeq = 0;
  window.RGBTvHostCb = function (id, json) { var cb = hostCbs[id]; delete hostCbs[id]; if (cb) cb(json); };
  function hostFetch(url, opt) {
    return new Promise(function (resolve, reject) {
      var id = ++hostSeq;
      hostCbs[id] = function (json) {
        var r; try { r = JSON.parse(json); } catch (e) { reject(new Error('Network error')); return; }
        if (r.status >= 200 && r.status < 300) { if (opt.json) { try { resolve(JSON.parse(r.body)); } catch (e) { reject(new Error('Invalid JSON from server')); } } else resolve(r.body); }
        else reject(new Error(r.status ? 'HTTP ' + r.status : (r.error && /timed? ?out/i.test(r.error) ? 'Timeout' : 'Network error')));
      };
      try { RGBTvHost.fetchAsync(id, url, opt.method || 'GET', JSON.stringify(opt.headers || {}), opt.body || '', opt.timeout || 20000); }
      catch (e) { delete hostCbs[id]; reject(new Error('Network error')); }
    });
  }
  function getJSON(url, headers) { return http(url, { json: true, headers: headers }); }

  /* SHA-1 (used for Stalker device signatures) */
  function sha1(msg) {
    function rotl(n, s) { return (n << s) | (n >>> (32 - s)); }
    function toHex(v) { var s = ''; for (var i = 7; i >= 0; i--) s += ((v >>> (i * 4)) & 0xf).toString(16); return s; }
    msg = unescape(encodeURIComponent(msg));
    var H = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    var ml = msg.length, words = [], i, j;
    for (i = 0; i < ml - 3; i += 4) words.push(msg.charCodeAt(i) << 24 | msg.charCodeAt(i + 1) << 16 | msg.charCodeAt(i + 2) << 8 | msg.charCodeAt(i + 3));
    var rem = ml % 4, last = 0x80 << 24;
    if (rem === 1) last = msg.charCodeAt(ml - 1) << 24 | 0x80 << 16;
    else if (rem === 2) last = msg.charCodeAt(ml - 2) << 24 | msg.charCodeAt(ml - 1) << 16 | 0x80 << 8;
    else if (rem === 3) last = msg.charCodeAt(ml - 3) << 24 | msg.charCodeAt(ml - 2) << 16 | msg.charCodeAt(ml - 1) << 8 | 0x80;
    words.push(last);
    while (words.length % 16 !== 14) words.push(0);
    words.push(ml >>> 29); words.push((ml << 3) & 0xffffffff);
    for (i = 0; i < words.length; i += 16) {
      var W = words.slice(i, i + 16), a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f, k, t;
      for (j = 16; j < 80; j++) W[j] = rotl(W[j - 3] ^ W[j - 8] ^ W[j - 14] ^ W[j - 16], 1);
      for (j = 0; j < 80; j++) {
        if (j < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (j < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        t = (rotl(a, 5) + f + e + k + W[j]) & 0xffffffff; e = d; d = c; c = rotl(b, 30); b = a; a = t;
      }
      H[0] = (H[0] + a) & 0xffffffff; H[1] = (H[1] + b) & 0xffffffff; H[2] = (H[2] + c) & 0xffffffff; H[3] = (H[3] + d) & 0xffffffff; H[4] = (H[4] + e) & 0xffffffff;
    }
    return H.map(toHex).join('').toUpperCase();
  }

  /* Scale the fixed 1920x1080 stage to fill whatever viewport the TV gives us (720p, 1080p, 4K…) */
  function fitScreen() {
    var app = document.getElementById('app'); if (!app) return 1;
    var w = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0) || 1920, h = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0) || 1080;
    if (window.screen && (!window.innerWidth || w < 640)) { w = screen.width || w; h = screen.height || h; }
    var mobile = document.body && document.body.classList.contains('mobile');
    if (mobile) {
      /* phone/tablet (landscape): fit by height like the TV, but widen the stage to the real aspect ratio
         (18:9 … 21:9) so there are no black side bars — layouts anchor left/right/center so they simply stretch */
      var s2 = Math.min(h / 1080, w / 1920), stageW = Math.max(1920, Math.round(w / s2));
      document.documentElement.style.setProperty('--stage-w', stageW + 'px');
      app.style.width = stageW + 'px'; app.style.height = '1080px';
      app.style.webkitTransform = app.style.transform = 'scale(' + s2 + ')'; app.style.top = Math.round((h - 1080 * s2) / 2) + 'px'; app.style.left = Math.round((w - stageW * s2) / 2) + 'px';
      U.scale = s2; U.stageW = stageW; return s2;
    }
    var s = Math.min(w / 1920, h / 1080);
    app.style.webkitTransform = app.style.transform = 'scale(' + s + ')';
    app.style.left = Math.round((w - 1920 * s) / 2) + 'px';
    app.style.top = Math.round((h - 1080 * s) / 2) + 'px';
    U.scale = s; return s;
  }
  window.addEventListener('resize', function () { fitScreen(); });
  window.addEventListener('orientationchange', function () { fitScreen(); });

  return { luna: luna, fitScreen: fitScreen, scale: 1, $: $, $$: $$, el: el, esc: esc, pad: pad, fmtTime: fmtTime, clock: clock, hm: hm, b64dec: b64dec, clamp: clamp, debounce: debounce, qs: qs, uuid: uuid, randomMac: randomMac, normUrl: normUrl, isAdult: isAdult, http: http, getJSON: getJSON, sha1: sha1 };
})();
