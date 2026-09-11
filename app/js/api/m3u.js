/* RGBTv — M3U / M3U8 playlist provider with XMLTV EPG support.
 * XMLTV is loaded in the background so a slow guide never blocks opening the playlist. */
/* IPTV panels sometimes inspect the HTTP client before they return the list.
   The automatic profile covers webOS, native Android/VU-compatible and VLC requests.
   A provider-supplied custom User-Agent always wins and is never overwritten. */
/* Large provider exports are commonly 5–40 MiB. Do not treat a real playlist
   download as a short API call; rejected HTTP requests still retry quickly. */
var M3U_PLAYLIST_TIMEOUT = 120000;
var M3U_RETRY_STATUSES = /HTTP (?:403|406|429|444|512)\b/i;
var M3U_CLIENT_PROFILES = {
  auto: [
    /* Try a TV-player identity first. Some panels reject browser UAs before the
       request reaches the playlist endpoint; provider-supplied UA still wins. */
    { 'User-Agent': 'RGBTv/2.2 (webOS Smart TV) IPTVSmarters/3.1 ExoPlayerLib/2.18', 'Accept': '*/*' },
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
/* Keep stream annotations bounded and free of control characters before they are
   saved in the playlist cache. These headers are useful to hls.js when a browser
   permits them; the channel URL itself always stays a direct player URL. */
function m3uAddHeader(headers, rawKey, rawValue) {
  var key = String(rawKey || '').toLowerCase().replace(/[_\s]/g, '-'), val = m3uDecode(rawValue).trim();
  if (!headers || /[\r\n]/.test(val)) return;
  if ((key === 'user-agent' || key === 'http-user-agent') && val.length && val.length <= 512) headers['User-Agent'] = val;
  else if ((key === 'referer' || key === 'referrer' || key === 'http-referrer' || key === 'http-referer') && /^https?:\/\//i.test(val) && val.length <= 2048) headers.Referer = val;
}
/* Supports the familiar URL|User-Agent=...&Referer=... form. The suffix is removed
   before playlist parsing, so relative channel URLs remain correct. */
function m3uSource(raw) {
  raw = String(raw || '').trim();
  var pos = raw.indexOf('|'), out = { url: raw, headers: {} }, parts, i, pair, eq, key, val;
  if (pos < 1) return out;
  out.url = raw.slice(0, pos).trim(); parts = raw.slice(pos + 1).split('&');
  for (i = 0; i < parts.length; i++) {
    pair = parts[i]; eq = pair.indexOf('='); if (eq < 1) continue;
    key = m3uDecode(pair.slice(0, eq)); val = pair.slice(eq + 1);
    m3uAddHeader(out.headers, key, val);
  }
  return out;
}
/* Return a decoded query parameter without relying on URLSearchParams, which is
   missing on the older webOS browser engines supported by this application. */
function m3uQueryValue(query, wanted) {
  var parts = String(query || '').split('&'), i, p, at, key;
  wanted = String(wanted || '').toLowerCase();
  for (i = 0; i < parts.length; i++) {
    p = parts[i]; at = p.indexOf('='); if (at < 1) continue;
    key = m3uDecode(p.slice(0, at)).toLowerCase();
    if (key === wanted) return m3uDecode(p.slice(at + 1));
  }
  return null;
}
/* A get.php subscription URL often exposes the same credentials as Xtream.
   Keep this conversion local to the provider: the saved profile remains M3U and
   can transparently fall back to downloading its playlist if player_api.php is
   disabled by that provider. */
function m3uXtreamAccount(acc) {
  var src, m, path, query, user, pass, base, x;
  if (!acc || acc.type !== 'm3u') return null;
  src = m3uSource(acc.url || '');
  m = /^(https?:\/\/[^\/?#]+)(\/[^?#]*)\?([^#]*)$/i.exec(src.url);
  if (!m || !/\/get\.php$/i.test(m[2])) return null;
  path = m[2]; query = m[3]; user = m3uQueryValue(query, 'username'); pass = m3uQueryValue(query, 'password');
  if (user == null || pass == null || !user || !pass) return null;
  base = m[1] + path.replace(/\/get\.php$/i, '');
  x = m3uCopy(acc); x.type = 'xtream'; x.url = base || m[1]; x.username = user; x.password = pass;
  /* The source was entered as M3U, so use the same Luna/native-safe route for
     its optional API fast path. The profile itself remains unchanged on disk. */
  x.apiProxy = true;
  return x;
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
    var clients = this._clients(), attempt = 0, last, wait = Number(timeout) || M3U_PLAYLIST_TIMEOUT;
    function next() {
      /* The packaged service is deliberately preferred here: it avoids browser
         CORS restrictions, preserves documented headers, and asks for identity
         encoding on old webOS Node builds. If Luna is unavailable, U.http falls
         back to XHR; Android uses its native fetch bridge. */
      var opt = { timeout: wait, proxy: true, headers: clients[attempt] };
      return U.http(target, opt).catch(function (err) {
        last = err;
        /* Rejections are normally fast. Never repeat a 120-second network
           timeout for every compatibility identity, but include 512 because
           several IPTV panels use it as a browser/client rejection. */
        if (attempt < clients.length - 1 && M3U_RETRY_STATUSES.test(String(err && err.message))) { attempt++; return next(); }
        throw last;
      });
    }
    return next();
  },
  _playlistError: function (err) {
    var msg = String(err && err.message || err || ''), status = /HTTP\s+(\d{3})\b/i.exec(msg);
    if (/^Timeout\b/i.test(msg)) return new Error(I18n.t('m3u.timeout'));
    if (status) return new Error(I18n.t('m3u.httpStatus', { code: status[1] }));
    if (/^(?:Network error|no luna|Luna timeout)\b/i.test(msg)) return new Error(I18n.t('m3u.network'));
    return err instanceof Error ? err : new Error(msg || I18n.t('m3u.network'));
  },
  _normalizeCachedItems: function (items) {
    /* Existing six-hour caches can contain URL|User-Agent annotations produced by
       earlier versions. Repair those entries before the first click after upgrade,
       including episodes nested inside a cached series. */
    var changed = false;
    function repair(item) {
      var source, key, seasons, season;
      if (!item) return;
      if (item.url) {
        source = m3uSource(item.url);
        if (source.url !== item.url) { item.url = source.url; changed = true; }
        for (key in source.headers) if (Object.prototype.hasOwnProperty.call(source.headers, key)) {
          if (!item.streamHeaders) item.streamHeaders = {};
          if (item.streamHeaders[key] !== source.headers[key]) { item.streamHeaders[key] = source.headers[key]; changed = true; }
        }
      }
      seasons = item.seasons;
      for (season in seasons || {}) if (Object.prototype.hasOwnProperty.call(seasons, season)) (seasons[season] || []).forEach(repair);
    }
    (items || []).forEach(repair);
    return changed;
  },
  login: function () {
    var self = this, cached = Store.cacheGet(this.acc.id, 'm3u_items', 6 * 3600e3), cachedEpg = Store.cacheGet(this.acc.id, 'm3u_epg', 12 * 3600e3), cacheChanged;
    if (cachedEpg) this.epg = cachedEpg;
    if (cached) {
      cacheChanged = this._normalizeCachedItems(cached);
      this.items = cached;
      /* Cache can predate the Smart Playlist release. Normalize it one time here,
         then write the compact result back so browsing never repeats this work. */
      if (window.SmartPlaylist) { var cachedPrepared = SmartPlaylist.prepare(cached); this.items = cachedPrepared.list; this.smartStats = cachedPrepared.stats; Store.cacheSet(this.acc.id, 'm3u_items', this.items); }
      else if (cacheChanged) Store.cacheSet(this.acc.id, 'm3u_items', this.items);
      this._scheduleEpg(this.epgUrl);
      return Promise.resolve({ status: 'Loaded (cache)', expires: null, count: this.items.length });
    }
    /* A playlist may be tens of megabytes. It is fetched once, cached for six
       hours, then every channel uses the direct URL parsed from this text. */
    return this._fetch(this.url, M3U_PLAYLIST_TIMEOUT).then(function (txt) {
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
    }).catch(function (err) { throw self._playlistError(err); });
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
        cur = { name: name || attrs['tvg-name'] || 'Unknown', logo: attrs['tvg-logo'] || '', group: attrs['group-title'] || 'Uncategorized', epgId: attrs['tvg-id'] || '', streamHeaders: {} };
        m3uAddHeader(cur.streamHeaders, 'user-agent', attrs['user-agent'] || attrs['http-user-agent']);
        m3uAddHeader(cur.streamHeaders, 'referer', attrs.referer || attrs.referrer || attrs['http-referrer'] || attrs['http-referer']);
      } else if (cur && /^#EXTVLCOPT:/i.test(l)) {
        /* VLC-style sidecar lines belong to the preceding EXTINF entry. */
        var option = /^#EXTVLCOPT:\s*([^=]+)=(.*)$/i.exec(l);
        if (option) m3uAddHeader(cur.streamHeaders, option[1], option[2]);
      } else if (l[0] === '#') continue;
      else if (cur) {
        var source = m3uSource(this._absoluteUrl(l));
        cur.url = source.url;
        for (var headerName in source.headers) if (Object.prototype.hasOwnProperty.call(source.headers, headerName)) cur.streamHeaders[headerName] = source.headers[headerName];
        var type = this._guessType(cur), stable = U.sha1(cur.url).substr(0, 16);
        var item = { id: 'm' + stable, name: cur.name, logo: cur.logo, poster: cur.logo, catId: cur.group, catName: cur.group, epgId: cur.epgId, url: cur.url, num: out.length + 1 };
        if (Object.keys(cur.streamHeaders).length) item.streamHeaders = cur.streamHeaders;
        if (type === 'series') {
          var sm = cur.name.match(/^(.*?)[\s\-]*S(\d{1,2})\s*E(\d{1,3})/i);
          var sName = sm ? sm[1].trim() : cur.name, key = cur.group + '|' + sName.toLowerCase();
          if (!seriesMap[key]) { seriesMap[key] = { type: 'series', id: 's' + U.sha1(key).substr(0, 16), name: sName, poster: cur.logo, catId: cur.group, catName: cur.group, seasons: {} }; out.push(seriesMap[key]); }
          var s = sm ? Number(sm[2]) : 1, e = sm ? Number(sm[3]) : Object.keys(seriesMap[key].seasons).length + 1;
          if (!seriesMap[key].seasons[s]) seriesMap[key].seasons[s] = [];
          seriesMap[key].seasons[s].push({ type: 'episode', id: item.id, seriesId: seriesMap[key].id, season: s, episode: e, name: cur.name, url: cur.url, streamHeaders: item.streamHeaders, thumb: cur.logo, catId: cur.group });
        } else { item.type = type; out.push(item); }
        cur = null;
      }
    }
    /* Clean only demonstrably broken URLs and exact duplicates before caching. This
       turns a large text playlist into a smaller, stable in-memory catalogue. */
    if (window.SmartPlaylist) { var prepared = SmartPlaylist.prepare(out); this.smartStats = prepared.stats; return prepared.list; }
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
  /* Provider-neutral playback contract. streamUrl remains for older callers,
     while resolveStream supplies the exact M3U URL and per-entry headers to the
     central PlaybackManager without fetching or pre-validating the stream. */
  resolveStream: function (item) {
    return Promise.resolve({ url: item && item.url, provider: this.type, channelId: item && item.id, headers: item && item.streamHeaders, metadata: { contentType: item && item.type, title: item && item.name, live: !!(item && item.type === 'live') } });
  },
  streamUrl: function (item) { return Promise.resolve(item && item.url); }
};

/* Fast path for a genuine Xtream get.php export. If player_api.php is not
   available, preserve the reliable M3U behavior by falling back to the text
   playlist instead of rejecting a valid subscription URL. */
function M3UGetPhpProvider(acc, xtreamAcc) {
  this.acc = acc; this.type = 'm3u';
  this.playlist = new M3UProvider(acc); this.xtream = new XtreamProvider(xtreamAcc); this.active = null;
}
M3UGetPhpProvider.prototype = {
  _provider: function () { return this.active || this.playlist; },
  login: function () {
    var self = this;
    return this.xtream.login().then(function (info) {
      self.active = self.xtream; info.status = info.status || 'Xtream API'; info.source = 'xtream'; return info;
    }).catch(function () {
      return self._usePlaylist();
    });
  },
  _usePlaylist: function () {
    var self = this;
    if (this.active === this.playlist) return Promise.resolve({ status: 'Loaded', source: 'm3u' });
    if (this._playlistPending) return this._playlistPending;
    var p = this.playlist.login().then(function (info) { self.active = self.playlist; self.smartStats = self.playlist.smartStats; info.source = 'm3u'; self._playlistPending = null; return info; }, function (e) { self._playlistPending = null; throw e; });
    this._playlistPending = p; return p;
  },
  /* A get.php URL remains a valid M3U subscription even when player_api.php
     logs in but its very large VOD/series actions time out. Switch only this
     wrapper to the already-supported text playlist in that situation. */
  _catalog: function (method, args) {
    var self = this, current = this._provider();
    return current[method].apply(current, args).catch(function (err) {
      if (current !== self.xtream) throw err;
      if (method === 'liveStreams' || method === 'vodStreams' || method === 'seriesList') self.catalogFallback = true;
      return self._usePlaylist().then(function () {
        /* Xtream category IDs do not necessarily match M3U group names. On a
           fallback, return the compatible complete type list rather than an
           empty pane; subsequent category loads use the M3U categories. */
        if (method === 'liveStreams' || method === 'vodStreams' || method === 'seriesList') return self.playlist[method](null);
        return self.playlist[method].apply(self.playlist, args);
      });
    });
  },
  liveCategories: function () { return this._catalog('liveCategories', arguments); },
  vodCategories: function () { return this._catalog('vodCategories', arguments); },
  seriesCategories: function () { return this._catalog('seriesCategories', arguments); },
  liveStreams: function (catId) { return this._catalog('liveStreams', arguments); },
  vodStreams: function (catId) { return this._catalog('vodStreams', arguments); },
  seriesList: function (catId) { return this._catalog('seriesList', arguments); },
  vodInfo: function (id, item) { return this._provider().vodInfo(id, item); },
  seriesInfo: function (id, item) { return this._provider().seriesInfo(id, item); },
  shortEPG: function (streamId, limit) { return this._provider().shortEPG(streamId, limit); },
  streamUrl: function (item) { return this._provider().streamUrl(item); },
  resolveStream: function (item, opt) {
    var provider = this._provider();
    return provider.resolveStream ? provider.resolveStream(item, opt) : provider.streamUrl(item).then(function (url) { return { url: url, provider: provider.type, channelId: item && item.id, headers: item && item.streamHeaders }; });
  },
  catchupUrl: function (item, startTs, durationMin) {
    var p = this._provider();
    return p.catchupUrl ? p.catchupUrl(item, startTs, durationMin) : Promise.reject(new Error('Catch-up is not available for this playlist'));
  },
  destroy: function () {
    if (this.playlist && this.playlist.destroy) this.playlist.destroy();
    if (this.xtream && this.xtream.destroy) this.xtream.destroy();
  }
};

function createProvider(acc) {
  var xtream;
  if (acc && acc.type === 'm3u') { xtream = m3uXtreamAccount(acc); return xtream ? new M3UGetPhpProvider(acc, xtream) : new M3UProvider(acc); }
  if (acc && acc.type === 'xtream') return new XtreamProvider(acc);
  throw new Error('Unsupported profile type');
}
