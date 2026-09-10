/* RGBTv — M3U / M3U8 playlist provider with XMLTV EPG support.
 * XMLTV is loaded in the background so a slow guide never blocks opening the playlist. */
/* IPTV panels sometimes inspect the HTTP client before they return the list.
   The automatic profile covers webOS, native Android/VU-compatible and VLC requests.
   A provider-supplied custom User-Agent always wins and is never overwritten. */
var M3U_CLIENT_PROFILES = {
  auto: [
    /* Try the working-player compatibility identity first to avoid provoking a panel's
       rate limiter with several rejected requests before reaching this profile. */
    { 'User-Agent': 'VU IPTV Player/1.2.4', 'Accept': '*/*' },
    { 'User-Agent': 'okhttp/4.12.0', 'Accept': '*/*' },
    { 'User-Agent': 'Dart/3.3 (dart:io)', 'Accept': '*/*' },
    { 'User-Agent': 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) WebAppManager', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    { 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Accept': '*/*' }
  ],
  vu: [
    { 'User-Agent': 'VU IPTV Player/1.2.4', 'Accept': '*/*' },
    { 'User-Agent': 'okhttp/4.12.0', 'Accept': '*/*' },
    { 'User-Agent': 'Dart/3.3 (dart:io)', 'Accept': '*/*' }
  ],
  webos: [{ 'User-Agent': 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) WebAppManager', 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9' }],
  android: [{ 'User-Agent': 'okhttp/4.12.0', 'Accept': '*/*' }, { 'User-Agent': 'Dart/3.3 (dart:io)', 'Accept': '*/*' }],
  vlc: [{ 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Accept': '*/*' }]
};
function m3uCopy(obj) { var out = {}, k; for (k in obj || {}) if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]; return out; }
function m3uDecode(s) { try { return decodeURIComponent(String(s || '').replace(/\+/g, '%20')); } catch (e) { return String(s || ''); } }
/* Supports the familiar URL|User-Agent=...&Referer=... form. The suffix is removed
   before playlist parsing, so relative channel URLs remain correct. */
function m3uSource(raw) {
  raw = String(raw || '').trim();
  var pos = raw.indexOf('|'), out = { url: raw, headers: {} }, parts, i, pair, eq, key, val;
  if (pos < 1) return out;
  out.url = raw.slice(0, pos).trim(); parts = raw.slice(pos + 1).split('&');
  for (i = 0; i < parts.length; i++) {
    pair = parts[i]; eq = pair.indexOf('='); if (eq < 1) continue;
    key = m3uDecode(pair.slice(0, eq)).toLowerCase().replace(/[_\s]/g, '-'); val = m3uDecode(pair.slice(eq + 1)).trim();
    if (key === 'user-agent' && val.length <= 512) out.headers['User-Agent'] = val;
    else if ((key === 'referer' || key === 'referrer') && /^https?:\/\//i.test(val) && val.length <= 2048) out.headers.Referer = val;
  }
  return out;
}
function M3UProvider(acc) {
  var src = m3uSource(acc.url || '');
  this.acc = acc; this.type = 'm3u'; this.url = U.normUrl(src.url);
  this.items = null; this.epg = {}; this.epgUrl = (acc.epg || '').trim(); this._epgPending = null; this._epgTimer = null;
  this.profile = Object.prototype.hasOwnProperty.call(M3U_CLIENT_PROFILES, acc.m3uProfile) ? acc.m3uProfile : 'auto';
  this.requestHeaders = src.headers;
  if (String(acc.m3uUserAgent || '').trim()) this.requestHeaders['User-Agent'] = String(acc.m3uUserAgent).trim().slice(0, 512);
  if (/^https?:\/\//i.test(String(acc.m3uReferer || '').trim())) this.requestHeaders.Referer = String(acc.m3uReferer).trim().slice(0, 2048);
}
M3UProvider.prototype = {
  _clients: function () {
    var custom = this.requestHeaders, profiles = M3U_CLIENT_PROFILES[this.profile] || M3U_CLIENT_PROFILES.auto, out = [], i, h;
    if (custom['User-Agent']) return [m3uCopy(custom)];
    for (i = 0; i < profiles.length; i++) {
      h = m3uCopy(profiles[i]);
      if (custom.Referer) h.Referer = custom.Referer;
      out.push(h);
    }
    return out;
  },
  _fetch: function (target, timeout) {
    var clients = this._clients(), attempt = 0, last, saw444 = false;
    function next() {
      var opt = { timeout: timeout || 18000, proxy: true, headers: clients[attempt] };
      return U.http(target, opt).catch(function (err) {
        last = err;
        /* Rejections are normally fast. Do not multiply a real network timeout by
           every possible client profile. */
        if (/HTTP 444/.test(String(err && err.message))) saw444 = true;
        if (attempt < clients.length - 1 && /HTTP (?:403|406|429|444)/i.test(String(err && err.message))) { attempt++; return next(); }
        if (saw444) throw new Error(I18n.t('provider.http444'));
        throw last;
      });
    }
    return next();
  },
  login: function () {
    var self = this, cached = Store.cacheGet(this.acc.id, 'm3u_items', 6 * 3600e3), cachedEpg = Store.cacheGet(this.acc.id, 'm3u_epg', 12 * 3600e3);
    if (cachedEpg) this.epg = cachedEpg;
    if (cached) {
      this.items = cached; this._scheduleEpg(this.epgUrl);
      return Promise.resolve({ status: 'Loaded (cache)', expires: null, count: cached.length });
    }
    /* Luna proxy avoids CORS failures on playlists hosted by IPTV panels. A short timeout
       fails a dead source quickly instead of leaving the profile on the connecting screen. */
    return this._fetch(this.url, 18000).then(function (txt) {
      /* A 200 response can still be a captive/login page from a provider. Name
         that case explicitly; calling it merely an invalid M3U hid the fix. */
      if (!/#EXTM3U/i.test(txt) && !/#EXTINF/i.test(txt)) {
        if (/^\s*<(?:!doctype\s+html|html|head|body|form)\b/i.test(String(txt || ''))) throw new Error(I18n.t('m3u.htmlResponse'));
        throw new Error(I18n.t('m3u.invalidResponse'));
      }
      self.epgUrl = self.epgUrl || self._findEpgUrl(txt);
      self.items = self._parse(txt);
      if (!self.items.length) throw new Error('Playlist is empty');
      Store.cacheSet(self.acc.id, 'm3u_items', self.items);
      /* XMLTV files are often much larger than the channel list. Defer this optional download so
         opening the first M3U channel never competes with an EPG transfer. */
      self._scheduleEpg(self.epgUrl);
      return { status: 'Loaded', expires: null, count: self.items.length };
    });
  },
  _findEpgUrl: function (txt) {
    var head = String(txt || '').split(/\r?\n/)[0] || '', m = /(?:url-tvg|x-tvg-url|tvg-url)\s*=\s*"([^"]+)"/i.exec(head);
    if (!m) m = /(?:url-tvg|x-tvg-url|tvg-url)\s*=\s*'([^']+)'/i.exec(head);
    return m ? m[1].trim() : '';
  },
  _parseAttrs: function (line) {
    var attrs = {}, re = /([a-zA-Z0-9\-_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g, m;
    while ((m = re.exec(line))) attrs[m[1].toLowerCase()] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
    return attrs;
  },
  _absoluteUrl: function (target) {
    target = String(target || '').trim();
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
    if (target.indexOf('//') === 0) return (this.url.match(/^https?:/i) || ['http:'])[0] + target;
    var m = this.url.match(/^(https?:\/\/[^/]+)(\/.*)?$/i), path = m && m[2] || '/';
    if (!m) return target;
    if (target.charAt(0) === '/') return m[1] + target;
    return m[1] + path.replace(/\/[^/]*$/, '/') + target;
  },
  _parse: function (txt) {
    var lines = txt.split(/\r?\n/), out = [], cur = null, seriesMap = {};
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim(); if (!l) continue;
      if (l.indexOf('#EXTINF') === 0) {
        var attrs = this._parseAttrs(l);
        var comma = l.indexOf(','), name = comma >= 0 ? l.slice(comma + 1).trim() : '';
        cur = { name: name || attrs['tvg-name'] || 'Unknown', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || 'Uncategorized', epgId: attrs['tvg-id'] || '' };
      } else if (l[0] === '#') continue;
      else if (cur) {
        cur.url = this._absoluteUrl(l);
        var type = this._guessType(cur), stable = U.sha1(cur.url).substr(0, 16);
        var item = { id: 'm' + stable, name: cur.name, logo: cur.logo, poster: cur.logo, catId: cur.group, catName: cur.group, epgId: cur.epgId, url: cur.url, num: out.length + 1 };
        if (type === 'series') {
          var sm = cur.name.match(/^(.*?)[\s\-]*S(\d{1,2})\s*E(\d{1,3})/i);
          var sName = sm ? sm[1].trim() : cur.name, key = cur.group + '|' + sName.toLowerCase();
          if (!seriesMap[key]) { seriesMap[key] = { type: 'series', id: 's' + U.sha1(key).substr(0, 16), name: sName, poster: cur.logo, catId: cur.group, catName: cur.group, seasons: {} }; out.push(seriesMap[key]); }
          var s = sm ? Number(sm[2]) : 1, e = sm ? Number(sm[3]) : Object.keys(seriesMap[key].seasons).length + 1;
          if (!seriesMap[key].seasons[s]) seriesMap[key].seasons[s] = [];
          seriesMap[key].seasons[s].push({ type: 'episode', id: item.id, seriesId: seriesMap[key].id, season: s, episode: e, name: cur.name, url: cur.url, thumb: cur.logo, catId: cur.group });
        } else { item.type = type; out.push(item); }
        cur = null;
      }
    }
    return out;
  },
  _guessType: function (c) {
    var u = c.url.toLowerCase(), g = c.group.toLowerCase();
    if (/\/series\//.test(u) || /series|séries/.test(g) || /S\d{1,2}\s*E\d{1,3}/i.test(c.name)) return 'series';
    if (/\/movie\//.test(u) || /\.(mp4|mkv|avi|mov)(\?|$)/.test(u) || /movie|film|vod|cinema/.test(g)) return 'movie';
    return 'live';
  },
  _xmlTime: function (s) {
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*([+-])(\d{2})(\d{2}))?/.exec(String(s || ''));
    if (!m) return 0;
    var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
    if (m[7]) { var offset = (Number(m[8]) * 60 + Number(m[9])) * 60000; ms += m[7] === '+' ? -offset : offset; }
    return Math.floor(ms / 1000);
  },
  _nodeText: function (node, tag) {
    var list = node.getElementsByTagName(tag); return list && list.length ? String(list[0].textContent || list[0].text || '').trim() : '';
  },
  _parseXmltv: function (txt) {
    var parser = new DOMParser(), doc = parser.parseFromString(String(txt || ''), 'text/xml'), bad = doc.getElementsByTagName('parsererror');
    if (bad && bad.length) throw new Error('Invalid XMLTV guide');
    var programs = doc.getElementsByTagName('programme'), map = {}, now = Date.now() / 1000, min = now - 6 * 3600, max = now + 8 * 86400;
    for (var i = 0; i < programs.length; i++) {
      var p = programs[i], id = p.getAttribute('channel') || '', start = this._xmlTime(p.getAttribute('start')), end = this._xmlTime(p.getAttribute('stop'));
      if (!id || !start || !end || end <= min || start >= max) continue;
      if (!map[id]) map[id] = [];
      map[id].push({ title: this._nodeText(p, 'title') || '—', desc: this._nodeText(p, 'desc'), start: start, end: end });
    }
    Object.keys(map).forEach(function (id) { map[id].sort(function (a, b) { return a.start - b.start; }); });
    return map;
  },
  _scheduleEpg: function (epgUrl) {
    var self = this;
    if (!epgUrl || this._epgPending || this._epgTimer) return;
    this._epgTimer = setTimeout(function () { self._epgTimer = null; self._loadEpg(epgUrl); }, 9000);
  },
  _loadEpg: function (epgUrl) {
    var self = this;
    if (!epgUrl || this._epgPending) return this._epgPending || Promise.resolve(this.epg);
    this._epgPending = this._fetch(epgUrl, 25000).then(function (xml) {
      self.epg = self._parseXmltv(xml); Store.cacheSet(self.acc.id, 'm3u_epg', self.epg); return self.epg;
    }).catch(function () { return self.epg; });
    this._epgPending.then(function () { self._epgPending = null; }, function () { self._epgPending = null; });
    return this._epgPending;
  },
  _cats: function (type) {
    var seen = {}, list = [];
    (this.items || []).forEach(function (x) { if (x.type === type && !seen[x.catId]) { seen[x.catId] = 1; list.push({ id: x.catId, name: x.catName }); } });
    return Promise.resolve(list);
  },
  liveCategories: function () { return this._cats('live'); },
  vodCategories: function () { return this._cats('movie'); },
  seriesCategories: function () { return this._cats('series'); },
  _filter: function (type, catId) { return Promise.resolve((this.items || []).filter(function (x) { return x.type === type && (!catId || x.catId === catId); })); },
  liveStreams: function (catId) { return this._filter('live', catId); },
  vodStreams: function (catId) { return this._filter('movie', catId); },
  seriesList: function (catId) { return this._filter('series', catId); },
  vodInfo: function (id, item) { return Promise.resolve(item); },
  seriesInfo: function (id, item) {
    var s = item && item.seasons || {}, seasons = Object.keys(s).sort(function (a, b) { return a - b; }).map(function (k) { return { num: Number(k), name: 'Season ' + k, episodes: s[k].sort(function (a, b) { return a.episode - b.episode; }) }; });
    return Promise.resolve({ type: 'series', id: item.id, name: item.name, poster: item.poster, catId: item.catId, seasons: seasons });
  },
  shortEPG: function (streamId, limit) {
    var list = this.epg[String(streamId)] || [], now = Date.now() / 1000;
    /* Return the currently relevant window, not programmes from the start of the cached guide. */
    list = list.filter(function (p) { return p.end > now - 60; });
    return Promise.resolve(list.slice(0, limit || 10));
  },
  destroy: function () { clearTimeout(this._epgTimer); this._epgTimer = null; },
  streamUrl: function (item) { return Promise.resolve(item && item.url); }
};

function createProvider(acc) {
  if (acc.type === 'stalker') return new StalkerProvider(acc);
  if (acc.type === 'm3u') return new M3UProvider(acc);
  return new XtreamProvider(acc);
}
