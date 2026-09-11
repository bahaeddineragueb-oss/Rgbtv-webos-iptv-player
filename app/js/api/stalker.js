/* RGBTv — Stalker / Ministra Portal provider (MAG emulation)
 * Implements the same interface as XtreamProvider. */
/* Stalker/Ministra releases do not agree on one envelope: some expose js.data,
   others data, channels, items or a bare array. Normalize only actual arrays and
   preserve the surrounding object for page/total metadata. */
function stalkerRows(payload) {
  var keys = ['data', 'channels', 'items', 'results', 'list', 'result', 'response'], todo = [{ value: payload, depth: 0 }], candidates = [], seen = [], entry, value, key, i, row;
  /* Follow only known response-envelope names and only four levels. This accepts
     old nested js/data responses without wandering through individual channel
     metadata or trusting arbitrary object values as a catalogue. */
  while (todo.length) {
    entry = todo.shift(); value = entry.value;
    if (Array.isArray(value)) { candidates.push(value); continue; }
    if (!value || typeof value !== 'object' || seen.indexOf(value) >= 0 || entry.depth > 4) continue;
    seen.push(value);
    for (i = 0; i < keys.length; i++) {
      key = keys[i];
      if (Array.isArray(value[key])) candidates.push(value[key]);
      else if (value[key] && typeof value[key] === 'object') todo.push({ value: value[key], depth: entry.depth + 1 });
    }
  }
  for (i = 0; i < candidates.length; i++) if (candidates[i].length || !row) row = candidates[i];
  return row || [];
}
function stalkerNumber(value) { value = Number(value); return isFinite(value) && value >= 0 ? value : 0; }
/* A portal should return one ITV page, but several older deployments silently
   return their whole catalogue. Map in short slices so a 20k-channel response
   cannot freeze the webOS UI thread while the Live list is being prepared. */
var STALKER_LIVE_PAGE_SIZE = 100, STALKER_MAP_CHUNK_SIZE = 100;
function stalkerMapLiveRows(provider, rows, fallbackCat, positionOffset) {
  rows = Array.isArray(rows) ? rows : [];
  return new Promise(function (resolve) {
    var out = [], at = 0, offset = Number(positionOffset) || 0;
    function next() {
      var end = Math.min(at + STALKER_MAP_CHUNK_SIZE, rows.length);
      while (at < end) { out.push(provider._mapLiveChannel(rows[at], fallbackCat, offset + at + 1)); at++; }
      if (at < rows.length) { setTimeout(next, 0); return; }
      resolve(out);
    }
    next();
  });
}
function stalkerCancelledError() { var e = new Error('Playback request cancelled'); e.name = 'AbortError'; e.code = 'USER_CANCELLED'; return e; }
function stalkerPageInfo(payload, rows, page) {
  var boxes = [{ value: payload, depth: 0 }], seen = [], total = 0, size = 0, returnedPage = Number(page) || 1, entry, box, keys, i;
  while (boxes.length) {
    entry = boxes.shift(); box = entry.value;
    if (!box || typeof box !== 'object' || Array.isArray(box) || seen.indexOf(box) >= 0 || entry.depth > 3) continue;
    seen.push(box);
    if (!total) total = stalkerNumber(box.total_items || box.total || box.total_count || box.count || box.recordsTotal);
    if (!size) size = stalkerNumber(box.max_page_items || box.page_size || box.per_page || box.limit || box.items_per_page);
    if (box.cur_page || box.current_page || box.page) returnedPage = stalkerNumber(box.cur_page || box.current_page || box.page) || returnedPage;
    keys = ['data', 'pagination', 'meta', 'result'];
    for (i = 0; i < keys.length; i++) if (box[keys[i]] && typeof box[keys[i]] === 'object' && !Array.isArray(box[keys[i]])) boxes.push({ value: box[keys[i]], depth: entry.depth + 1 });
  }
  size = size || rows.length || 1;
  return { page: returnedPage, total: total, pageSize: size, hasMore: total ? returnedPage * size < total : rows.length >= size };
}
function stalkerDebug(message, data) {
  /* Debug mode deliberately reports only response shape/counts; never MAC, bearer
     token, cookie values, portal URL, stream command or other credentials. */
  if (typeof window === 'undefined' || !window.RGBTvDebug || !window.console || !console.log) return;
  try { console.log('[STALKER] ' + message, data || ''); } catch (e) { }
}
/* A create_link command may include an ffmpeg prefix and URL|header options.
   Extract those without ever passing the command prefix or pipe annotations to
   HTMLVideoElement, which otherwise treats them as part of the media URL. */
function stalkerCommandSource(command) {
  var raw = String(command || '').trim(), match, rest, headers = {}, parts, i, pair, at, key, value;
  raw = raw.replace(/^(?:(?:ffmpeg|ffrt\d?|auto)\s+)+/i, '');
  match = raw.match(/https?:\/\/[^\s|]+/i);
  if (!match) return { url: '', headers: {}, raw: raw };
  rest = raw.slice(match.index + match[0].length); parts = rest.split('|');
  for (i = 1; i < parts.length; i++) {
    pair = parts[i]; at = pair.indexOf('='); if (at < 1) continue;
    key = pair.slice(0, at).trim().toLowerCase().replace(/[_\s]/g, '-'); value = pair.slice(at + 1).trim();
    if (!value || value.length > 2048 || /[\r\n]/.test(value)) continue;
    if ((key === 'user-agent' || key === 'http-user-agent') && value.length <= 512) headers['User-Agent'] = value;
    else if ((key === 'referer' || key === 'referrer' || key === 'http-referer' || key === 'http-referrer') && /^https?:\/\//i.test(value)) headers.Referer = value;
    else if (key === 'authorization') headers.Authorization = value;
  }
  return { url: match[0], headers: headers, raw: raw };
}
function stalkerSameOrigin(left, right) {
  var a = /^(https?):\/\/([^\/:?#]+)(?::(\d+))?/i.exec(String(left || '')), b = /^(https?):\/\/([^\/:?#]+)(?::(\d+))?/i.exec(String(right || '')), ap, bp;
  if (!a || !b || a[1].toLowerCase() !== b[1].toLowerCase() || a[2].toLowerCase() !== b[2].toLowerCase()) return false;
  /* https://host and https://host:443 are the same portal. The old string
     comparison silently dropped the active MAG session on this common form. */
  ap = String(a[3] || (a[1].toLowerCase() === 'https' ? '443' : '80'));
  bp = String(b[3] || (b[1].toLowerCase() === 'https' ? '443' : '80'));
  return ap === bp;
}
function stalkerSafeStreamUrl(raw) {
  var match = String(raw || '').match(/^(https?:\/\/[^/]+)/i); return match ? match[1] + '/…' : 'unavailable';
}
/* MAG firmware exposes an internal HTTP proxy as localhost. Browser apps do
   not have that firmware route: assigning http://localhost/ch/... to video
   points at the TV itself and can never reach the subscriber's portal. Rewrite
   only documented loopback aliases to the already authenticated portal origin. */
function stalkerPortalStreamUrl(sourceUrl, endpoint) {
  var source = String(sourceUrl || ''), local = /^(https?):\/\/(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?)(?::(\d+))?((?:[\/?#].*)?)$/i.exec(source), portal = /^(https?):\/\/([^\/:?#]+)(?::(\d+))?/i.exec(String(endpoint || ''));
  if (!local || !portal) return { url: source, loopbackRewritten: false };
  /* An explicit local gateway port is retained on the real portal host. Without
     one, use the portal's protocol and port because that is where /ch/ lives. */
  if (local[3]) return { url: local[1].toLowerCase() + '://' + portal[2] + ':' + local[3] + (local[4] || '/'), loopbackRewritten: true };
  return { url: portal[1].toLowerCase() + '://' + portal[2] + (portal[3] ? ':' + portal[3] : '') + (local[4] || '/'), loopbackRewritten: true };
}
/* Handshake payloads vary just as much as catalogue replies. Older Ministra
   portals commonly place the bearer below data/result, while newer portals put
   it at js.token. Only recognised response envelopes are inspected. */
function stalkerToken(payload) {
  var todo = [{ value: payload, depth: 0 }], seen = [], entry, value, keys, i, token;
  while (todo.length) {
    entry = todo.shift(); value = entry.value;
    if (typeof value === 'string' && /^[\[{]/.test(value.trim())) { try { value = JSON.parse(value); } catch (e) { } }
    if (!value || typeof value !== 'object' || seen.indexOf(value) >= 0 || entry.depth > 4) continue;
    seen.push(value);
    token = value.token || value.access_token || value.bearer_token;
    if (typeof token === 'string' && token.trim()) return token.trim();
    keys = ['js', 'data', 'result', 'response'];
    for (i = 0; i < keys.length; i++) if (value[keys[i]] && (typeof value[keys[i]] === 'object' || typeof value[keys[i]] === 'string')) todo.push({ value: value[keys[i]], depth: entry.depth + 1 });
  }
  return '';
}
function stalkerStreamError(error) {
  var e = error instanceof Error ? error : new Error(String(error || 'Unable to resolve Stalker stream'));
  if (!e.code) e.code = 'STREAM_RESOLUTION_ERROR';
  return e;
}

function StalkerProvider(acc) {
  this.acc = acc; this.type = 'stalker';
  var supplied = U.normUrl(acc.url), direct = /\/(?:server\/load\.php|portal\.php)(?:\?.*)?$/i.test(supplied) ? supplied.replace(/\?.*$/, '') : '';
  var base = supplied;
  // Accept "http://host", "http://host/c", "http://host/stalker_portal/c", or a direct load.php URL.
  // Strip a direct endpoint before its /c suffix so alternate paths remain rooted at the host.
  base = base.replace(/\/(server\/load\.php|portal\.php).*$/, '').replace(/\/(c|stalker_portal\/c)\/?$/, '');
  this.base = base;
  /* Portals are deployed at several different roots. A supplied direct endpoint
     is tried first, then the common Ministra/Stalker layouts without guessing
     credentials or changing the portal host. */
  this.endpoints = (direct ? [direct] : []).concat([base + '/server/load.php', base + '/c/server/load.php', base + '/stalker_portal/server/load.php', base + '/portal.php', base + '/c/portal.php', base + '/stalker_portal/portal.php', base + '/stalker_portal/c/portal.php']);
  this.endpoints = this.endpoints.filter(function (v, i, a) { return a.indexOf(v) === i; });
  this.endpoint = this.endpoints[0];
  var dev = Store.device();
  this.mac = (acc.mac || dev.mac).toUpperCase();
  this.sn = acc.sn || dev.sn; this.deviceId = acc.deviceId || dev.deviceId; this.deviceId2 = acc.deviceId2 || dev.deviceId2;
  this.sig = U.sha1(this.mac + this.sn);
  /* Tokens and portal session cookies are short-lived credentials. Keep both in
     memory only; each application launch starts with a fresh handshake. */
  this.token = null;
  /* MAG middleware compares the cookie value as a MAC address. Keep colons
     literal; URL-encoding them works on some PHP portals but is rejected by
     others before create_link is reached. */
  this.cookies = { mac: this.mac, stb_lang: 'en', timezone: 'Europe/Paris' };
  this.profile = null; this.portalInfo = null; this.agentMode = 0;
  this._genreCache = {}; this._keepalive = null; this._handshakePending = null; this._mem = {}; this._pending = {}; this._queue = [];
  /* One catalogue request is deliberately serialised, but create_link has a
     dedicated high-priority lane. A 120-second VOD/page fetch must never hold a
     selected live channel behind it until PlaybackManager times out. */
  this._activeRequests = 0; this._activePlaybackRequests = 0;
  this._livePages = {}; this._allLive = { items: [], ids: {}, nextPage: 1, total: 0, complete: false, pending: null };
}
StalkerProvider.prototype = {
  _cookieHeader: function () {
    var out = [], key;
    for (key in this.cookies || {}) if (Object.prototype.hasOwnProperty.call(this.cookies, key)) out.push(key + '=' + this.cookies[key]);
    return out.join('; ');
  },
  _mergeCookies: function (headers) {
    var raw = headers && (headers['set-cookie'] || headers['Set-Cookie']), list, i, first, at, key, value;
    if (!raw) return;
    list = Array.isArray(raw) ? raw : [raw];
    for (i = 0; i < list.length; i++) {
      first = String(list[i] || '').split(';')[0]; at = first.indexOf('=');
      if (at < 1) continue;
      key = first.slice(0, at).trim(); value = first.slice(at + 1).trim();
      if (/^[A-Za-z0-9_.-]{1,80}$/.test(key) && value.length <= 2048 && !/[\r\n]/.test(value)) this.cookies[key] = value;
    }
  },
  _enqueue: function (work, priority, signal) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var job = { work: work, resolve: resolve, reject: reject, signal: signal, priority: priority === 'playback' ? 'playback' : 'background' };
      if (job.priority === 'playback') self._queue.unshift(job); else self._queue.push(job);
      self._drainQueue();
    });
  },
  _drainQueue: function () {
    var self = this, job = null, index = -1, i;
    if (!this._queue.length) return;
    /* Normal portal work remains one-at-a-time. There is exactly one exception:
       one create_link may run beside an already-active catalogue request. This
       preserves anti-flood behaviour while protecting click-to-first-frame. */
    if (!this._activePlaybackRequests && this._activeRequests < 2) {
      for (i = 0; i < this._queue.length; i++) {
        if (this._queue[i].priority === 'playback') { index = i; break; }
      }
    }
    if (index >= 0) job = this._queue.splice(index, 1)[0];
    else if (!this._activeRequests) job = this._queue.shift();
    else return;
    /* A channel zap can cancel a create_link request before its turn. Do not send
       abandoned playback work to a rate-limited portal merely to discard it later. */
    if (job.signal && job.signal.aborted) { job.reject(stalkerCancelledError()); this._drainQueue(); return; }
    this._activeRequests++;
    if (job.priority === 'playback') this._activePlaybackRequests++;
    Promise.resolve().then(job.work).then(function (value) {
      self._activeRequests--; if (job.priority === 'playback') self._activePlaybackRequests--; job.resolve(value); self._drainQueue();
    }, function (err) {
      self._activeRequests--; if (job.priority === 'playback') self._activePlaybackRequests--; job.reject(err); self._drainQueue();
    });
  },
  _portalReferer: function () {
    var endpoint = String(this.endpoint || this.base || '').replace(/\?.*$/, '').replace(/\/+$/, ''), root;
    root = endpoint.replace(/\/(?:server\/load\.php|portal\.php)$/i, '');
    /* Keep the portal's real subdirectory. Sending /c/ for a portal installed
       below /stalker_portal/ is a common reason for profile/create_link 403s. */
    if (/\/c$/i.test(root)) return root + '/';
    if (/\/stalker_portal$/i.test(root)) return root + '/c/';
    return root + '/c/';
  },
  _headers: function (includeAuthorization) {
    /* Portals sometimes filter by the exact MAG model or the browser user agent and answer with nginx 444.
       Keep the standard MAG250 identity first, then try two compatible identities during handshake. */
    var modes = [
      { xua: 'Model: MAG250; Link: WiFi', ua: 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3' },
      { xua: 'Model: MAG254; Link: WiFi', ua: 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG254 stbapp ver: 2 rev: 272 Safari/533.3' },
      { xua: 'Model: MAG256; Link: WiFi', ua: 'Mozilla/5.0 (Linux; Web0S; SmartTV) AppleWebKit/537.36' }
    ], m = modes[this.agentMode] || modes[0], h = {
      'User-Agent': m.ua, 'X-User-Agent': m.xua, 'Referer': this._portalReferer(),
      'Cookie': this._cookieHeader()
    };
    /* A token refresh must not send the known-expired bearer back to handshake.
       Several Ministra portals reject that request before issuing a fresh token. */
    if (includeAuthorization !== false && this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  },
  _url: function (params) {
    var q = { type: params.type, action: params.action };
    for (var k in params) q[k] = params[k];
    q.JsHttpRequest = '1-xml';
    // MAC is also sent as query param — required by portals where the Cookie header cannot be set from a browser context
    if (!q.mac) q.mac = this.mac;
    return this.endpoint + '?' + U.qs(q);
  },
  _call: function (params, noRetry, priority, requestOpt) {
    requestOpt = requestOpt || {};
    var self = this, key = this.endpoint + '?' + U.qs(params || {}), signal = requestOpt.signal;
    /* Home, sidebar, guide and search can ask for the same endpoint together.
       Playback requests carry a session signal and are intentionally not shared:
       an aborted zap must not cancel or inherit another session's create_link. */
    if (!signal && this._pending[key]) return this._pending[key];
    var pending = this._enqueue(function () { return self._callNow(params, noRetry, requestOpt); }, priority, signal);
    if (!signal) {
      this._pending[key] = pending;
      pending.then(function () { delete self._pending[key]; }, function () { delete self._pending[key]; });
    }
    return pending;
  },
  _callNow: function (params, noRetry, requestOpt) {
    var self = this;
    requestOpt = requestOpt || {};
    if (requestOpt.signal && requestOpt.signal.aborted) return Promise.reject(stalkerCancelledError());
    /* Self-signed TLS remains opt-in per trusted portal; secure verification is the default.
       A catalogue page is allowed a longer request budget, but requests themselves
       are serialized in _enqueue to protect rate-limited MAG portals. */
    var opt = { insecureTls: this.acc.insecureTls === true, timeout: 45000, responseMeta: true, signal: requestOpt.signal };
    /* create_link is on the click-to-first-frame path. A stuck portal must fail
       fast so the PlaybackManager can perform its bounded fresh-session retry. */
    if (params && params.action === 'create_link') opt.timeout = 8000;
    else if (params && (params.action === 'get_ordered_list' || params.action === 'get_all_channels' || (params.action === 'get_categories' && params.type !== 'itv'))) opt.timeout = 120000;
    return U.getJSON(this._url(params), this._headers(), opt).then(function (response) {
      /* responseMeta is available through Luna. Keeping the fallback makes unit
         tests and non-webOS adapters compatible with the normalized call path. */
      var raw = response && response.headers && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
      self._mergeCookies(response && response.headers);
      var result = raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'js') ? raw.js : raw;
      /* Some Ministra versions put a JSON object inside the `js` string. */
      if (typeof result === 'string' && /^[\[{]/.test(result.trim())) { try { result = JSON.parse(result); } catch (x) { throw new Error('Invalid JSON'); } }
      if (typeof result === 'string' && /Authorization failed|invalid token|access denied/i.test(result)) throw new Error('AUTH');
      if (result && typeof result === 'object' && (/^(?:401|403)$/).test(String(result.status || result.status_code || result.code || '')) || result && result.error && /Authorization|token|access denied/i.test(String(result.error))) throw new Error('AUTH');
      stalkerDebug('Request ' + String(params && params.action || 'unknown'), { status: response && response.status || 200, rows: stalkerRows(result).length, keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 8) : [], cookies: response && response.headers && (response.headers['set-cookie'] || response.headers['Set-Cookie']) ? 'received' : 'none' });
      return result;
    }).catch(function (e) {
      var message = String(e && e.message || e);
      /* A 429 is already retried calmly by the service. Do not launch another
         handshake / endpoint sweep, because that would immediately re-trigger the limit. */
      if (/cancelled|canceled|AbortError/i.test(message) || e && e.code === 'USER_CANCELLED') throw stalkerCancelledError();
      if (/HTTP 429|rate limited/i.test(message)) { var rate = new Error(I18n.t('provider.http429')); rate.status = Number(e && e.status || 429); rate.retryAfter = Number(e && e.retryAfter || 0); throw rate; }
      if (!noRetry && (/AUTH|HTTP 401|HTTP 403|HTTP 406|HTTP 444/.test(message))) {
        /* Exactly one renewed token attempt inside this queued operation: no
           recursive queue entry and no infinite refresh loop. */
        return self._handshake().then(function () {
          if (requestOpt.signal && requestOpt.signal.aborted) throw stalkerCancelledError();
          return self._callNow(params, true, requestOpt);
        });
      }
      throw e;
    });
  },
  _handshake: function () {
    var self = this, endpointIndex = 0, mode = 0, lastError = null, rejected = false, AGENT_COUNT = 3;
    function tryNext() {
      if (endpointIndex >= self.endpoints.length) {
        if (rejected) return Promise.reject(new Error(I18n.t('provider.http444')));
        return Promise.reject(lastError || new Error('Portal not reachable (no valid endpoint)'));
      }
      var currentMode = mode;
      self.endpoint = self.endpoints[endpointIndex]; self.agentMode = currentMode;
      return U.getJSON(self._url({ type: 'stb', action: 'handshake', token: '', prehash: '' }), self._headers(false), { insecureTls: self.acc && self.acc.insecureTls === true, timeout: 45000, responseMeta: true }).then(function (response) {
        var raw = response && response.headers && Object.prototype.hasOwnProperty.call(response, 'data') ? response.data : response;
        self._mergeCookies(response && response.headers);
        var js = raw && raw.js != null ? raw.js : raw, token;
        if (typeof js === 'string') { try { js = JSON.parse(js); } catch (e) { } }
        token = stalkerToken(js);
        if (!token) throw new Error('No token returned by portal');
        self.token = token;
        stalkerDebug('Handshake: SUCCESS', { status: response && response.status || 200, token: 'received', cookies: response && response.headers && (response.headers['set-cookie'] || response.headers['Set-Cookie']) ? 'received' : 'none' });
        /* Only the endpoint is cached. Persisting a bearer token exposes a credential and causes stale-token failures. */
        delete self.acc.token; self.acc.endpoint = self.endpoint; Store.updateAccount(self.acc);
        return js;
      }).catch(function (e) {
        var message = String(e && e.message || e);
        /* Stop here on rate limiting. Cycling endpoint paths and MAG identities is
           useful for 403/406/444 only; for 429 it makes the provider block longer. */
        if (/HTTP 429|rate limited/i.test(message)) return Promise.reject(new Error(I18n.t('provider.http429')));
        var denied = /HTTP 444|HTTP 403|HTTP 406/.test(message);
        if (denied) rejected = true;
        lastError = e;
        /* Only a clear server-side rejection merits trying another device identity. Other endpoint
           failures move on immediately, avoiding a multiplied wait for an offline portal. */
        if (denied && currentMode < AGENT_COUNT - 1) { mode = currentMode + 1; return tryNext(); }
        endpointIndex++; mode = 0; return tryNext();
      });
    }
    if (this._handshakePending) return this._handshakePending;
    if (this.acc.endpoint && this.acc.endpoint.indexOf(this.base) === 0) this.endpoints.unshift(this.acc.endpoint);
    this.endpoints = this.endpoints.filter(function (v, n, a) { return a.indexOf(v) === n; });
    this._handshakePending = tryNext();
    this._handshakePending.then(function () { self._handshakePending = null; }, function () { self._handshakePending = null; });
    return this._handshakePending;
  },
  /* Called only by the bounded PlaybackManager recovery ladder. It deliberately
     shares any current handshake and does not start a keep-alive retry storm. */
  refreshSession: function () { return this._handshake(); },
  login: function () {
    var self = this;
    return this._handshake().then(function () {
      var now = new Date(), tz = 'Europe/Paris';
      return self._call({
        type: 'stb', action: 'get_profile', hd: 1, ver: 'ImageDescription: 0.2.18-r23-250; ImageDate: Thu Sep 13 11:31:16 EEST 2018; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c',
        num_banks: 2, sn: self.sn, stb_type: 'MAG250', client_type: 'STB', image_version: 218, video_out: 'hdmi', device_id: self.deviceId, device_id2: self.deviceId2, signature: self.sig,
        auth_second_step: 1, hw_version: '1.7-BD-00', not_valid_token: 0, metrics: JSON.stringify({ mac: self.mac, sn: self.sn, type: 'STB', model: 'MAG250', uid: '', random: U.uuid() }), hw_version_2: U.sha1(self.mac), timestamp: Math.floor(now / 1000), api_signature: 263, prehash: ''
      });
    }).then(function (p) {
      self.profile = p || {};
      if (p && (p.status === 2 || p.status === '2') && !p.id) throw new Error('Device is not authorized on this portal (MAC not registered)');
      if (p && p.block_msg) throw new Error(p.block_msg);
      return self._call({ type: 'account_info', action: 'get_main_info' }).catch(function () { return {}; }).then(function (info) {
        self._startKeepalive();
        var exp = null;
        if (info && info.end_date) { var d = Date.parse(info.end_date); if (!isNaN(d)) exp = d; }
        else if (info && info.phone) { var d2 = Date.parse(info.phone); if (!isNaN(d2)) exp = d2; }
        return { status: 'Active', expires: exp, mac: self.mac, login: info && info.login, tariff: info && info.tariff_plan };
      });
    });
  },
  _startKeepalive: function () {
    var self = this; clearInterval(this._keepalive);
    this._keepalive = setInterval(function () { self._call({ type: 'watchdog', action: 'get_events', init: 0, cur_play_type: 1, event_active_id: 0 }, true).catch(function () { }); }, 120000);
  },
  destroy: function () { clearInterval(this._keepalive); },

  _genres: function (type, cacheKey) {
    var self = this, c = Store.cacheGet(this.acc.id, cacheKey, 6 * 3600e3); if (c) return Promise.resolve(c);
    var p = type === 'itv' ? { type: 'itv', action: 'get_genres' } : { type: type, action: 'get_categories' };
    return this._call(p).then(function (r) {
      var rows = stalkerRows(r), list = rows.filter(function (g) { return g && g.id !== '*' && g.id !== undefined; }).map(function (g) { return { id: String(g.id), name: g.title || g.name || g.genre_name || '—', censored: Number(g.censored) === 1 }; });
      stalkerDebug('Genres: ' + list.length, { type: type, rows: rows.length });
      Store.cacheSet(self.acc.id, cacheKey, list); return list;
    });
  },
  liveCategories: function () { return this._genres('itv', 'live_cats'); },
  vodCategories: function () { return this._genres('vod', 'vod_cats'); },
  seriesCategories: function () {
    var self = this;
    return this._genres('series', 'series_cats').then(function (l) { return l.length ? l : self._genres('vod', 'vod_cats'); });
  },

  _mapLiveChannel: function (source, fallbackCat, position) {
    source = source && typeof source === 'object' ? source : { cmd: String(source || '') };
    var cmd = source.cmd || source.cmd_1 || source.cmd_0 || source.command || source.stream_url || source.stream || source.url || '', rawId = source.id;
    if (rawId == null || rawId === '') rawId = source.ch_id != null ? source.ch_id : (source.channel_id != null ? source.channel_id : (source.stream_id != null ? source.stream_id : source.number));
    var name = source.name || source.title || source.channel_name || source.display_name || '';
    /* A channel without a logo/number/category remains valid. If a portal omits
       its internal id, derive a stable local key from its actual command/name so
       it can still be listed and selected. */
    if (rawId == null || rawId === '') rawId = 'st-' + U.sha1(String(cmd || name || position || '')).substr(0, 16);
    return {
      type: 'live', id: String(rawId), name: String(name || ('Channel ' + rawId)), num: stalkerNumber(source.number || source.num || source.position || source.channel_number || position),
      logo: this._logo(source.logo || source.logo_uri || source.icon || source.stream_icon || ''), catId: String(source.tv_genre_id != null ? source.tv_genre_id : (source.genre_id != null ? source.genre_id : (source.category_id != null ? source.category_id : fallbackCat || ''))),
      cmd: String(cmd || ''), epgId: String(source.xmltv_id || source.epg_id || source.tvg_id || ''), archive: Number(source.enable_tv_archive || source.archive) === 1,
      archiveDays: Number(source.tv_archive_duration || source.archive_duration) || 0, useHttpTmp: Number(source.use_http_tmp_link) === 1
    };
  },
  _rememberAllLive: function (items) {
    var all = this._allLive, i, item;
    for (i = 0; i < (items || []).length; i++) {
      item = items[i]; if (!item || all.ids[item.id]) continue;
      all.ids[item.id] = 1; all.items.push(item);
    }
  },
  _pageKey: function (catId, page) { return String(catId == null ? '*' : catId) + ':' + Number(page || 1); },
  _unsupportedPageReply: function (reply) {
    var msg = reply && typeof reply === 'object' ? (reply.error || reply.error_text || reply.message || reply.msg || '') : reply;
    return /unknown|unsupported|invalid\s+(?:action|method)|not found|wrong action/i.test(String(msg || ''));
  },
  _legacyLivePage: function (catId, page) {
    var self = this, pageSize = 100;
    if (this._mem.legacyLive) return Promise.resolve(this._legacySlice(catId, page, pageSize));
    /* Only a portal that explicitly rejects the documented paged ITV action uses
       this compatibility endpoint. It is never touched by paginated portals. */
    return this._call({ type: 'itv', action: 'get_all_channels' }).then(function (reply) {
      var rows = stalkerRows(reply);
      return stalkerMapLiveRows(self, rows, '', 0).then(function (list) {
        self._mem.legacyLive = list; self._rememberAllLive(list);
        stalkerDebug('Legacy ITV catalogue', { rows: rows.length, mapped: list.length });
        return self._legacySlice(catId, page, pageSize);
      });
    });
  },
  _legacySlice: function (catId, page, pageSize) {
    var all = this._mem.legacyLive || [], filtered = catId == null ? all : all.filter(function (item) { return item.catId === String(catId); });
    var from = (Number(page || 1) - 1) * pageSize, items = filtered.slice(from, from + pageSize);
    return { items: items, page: Number(page) || 1, pageSize: pageSize, total: filtered.length, hasMore: from + items.length < filtered.length, legacy: true };
  },
  /* Fetch exactly one Stalker ITV page. This is the progressive API used by the
     Live screen; it never downloads a 23 000-channel catalogue just to paint the
     first rows. `p`/`genre`/`get_ordered_list` are the portal's documented ITV
     pagination fields and are already used by the VOD Stalker implementation. */
  livePage: function (catId, page) {
    var self = this, key = this._pageKey(catId, page), cached = this._livePages[key] || (Number(page) <= 2 && Store.cacheGet(this.acc.id, 'stalker_live_page_' + key, 6 * 3600e3));
    if (cached) return Promise.resolve(cached);
    return this._call({ type: 'itv', action: 'get_ordered_list', genre: catId == null ? '*' : String(catId), force_ch_link_check: 0, fav: 0, sortby: 'number', hd: 0, p: Number(page) || 1, page_size: STALKER_LIVE_PAGE_SIZE, limit: STALKER_LIVE_PAGE_SIZE }).then(function (reply) {
      var rows = stalkerRows(reply), info, items = [], seen = {};
      if (!rows.length && self._unsupportedPageReply(reply)) return self._legacyLivePage(catId, page);
      info = stalkerPageInfo(reply, rows, page);
      return stalkerMapLiveRows(self, rows, catId, (info.page - 1) * info.pageSize).then(function (mapped) {
        mapped.forEach(function (item) {
          /* A few portals repeat the last record at a page boundary. Keep every
             distinct channel but never insert the repeated record twice. */
          if (!seen[item.id]) { seen[item.id] = 1; items.push(item); }
        });
        var result = { items: items, page: info.page, pageSize: info.pageSize, total: info.total, hasMore: info.hasMore, legacy: false };
        self._livePages[key] = result;
        if (info.page <= 2) Store.cacheSet(self.acc.id, 'stalker_live_page_' + key, result);
        /* This is an in-memory search index of pages the viewer has actually seen,
           including category-filtered pages. It is not written as one giant cache. */
        self._rememberAllLive(items); if (catId == null && info.total) self._allLive.total = info.total;
        stalkerDebug('Channel page ' + info.page, { received: rows.length, mapped: items.length, total: info.total || 'unknown', pageSize: info.pageSize, category: catId == null ? 'all' : 'selected' });
        return result;
      });
    });
  },
  /* Legacy provider callers get only the first page. The Live controller below
     calls livePage repeatedly as the user navigates, so no generic home/search
     caller can accidentally request every channel. */
  liveStreams: function (catId) {
    var self = this;
    if (this._mem.legacyLive) return Promise.resolve(this._legacySlice(catId, 1, 100).items);
    return this.livePage(catId, 1).then(function (result) { return result.items; });
  },
  _loadAllLive: function (onProgress) {
    var self = this, all = this._allLive;
    if (all.complete || this._mem.legacyLive) { if (this._mem.legacyLive) { this._rememberAllLive(this._mem.legacyLive); all.complete = true; } return Promise.resolve(all.items); }
    if (all.pending) return all.pending;
    var page = 1, seenPages = {}, previousSignature = '';
    function next() {
      if (seenPages[page]) { all.complete = true; return Promise.resolve(all.items); }
      seenPages[page] = 1;
      return self.livePage(null, page).then(function (result) {
        var signature = (result.items || []).map(function (item) { return item.id; }).join('|');
        self._rememberAllLive(result.items);
        if (result.total) all.total = result.total;
        if (onProgress) onProgress(all.items.length, all.total || 0);
        /* A previously browsed All page adds no new index records, but it is still
           safe to advance. Stop only when a portal actually repeats its page. */
        if (result.hasMore && result.items.length && signature !== previousSignature) { previousSignature = signature; page = result.page + 1; return next(); }
        all.complete = true; return all.items;
      });
    }
    all.pending = next();
    all.pending.then(function () { all.pending = null; }, function () { all.pending = null; });
    return all.pending;
  },
  _searchText: function (value) {
    return String(value || '').toLowerCase().replace(/[\u064B-\u065F\u0670]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ùúûü]/g, 'u').replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i').replace(/[òóôö]/g, 'o').replace(/ç/g, 'c').replace(/\s+/g, ' ').trim();
  },
  searchLoadedLive: function (query) {
    var self = this, needle = this._searchText(query), items = this._allLive.items;
    if (!needle) return [];
    return items.filter(function (item) { return self._searchText(item.name).indexOf(needle) >= 0 || String(item.id).toLowerCase().indexOf(needle) >= 0 || String(item.num || '').indexOf(needle) >= 0; });
  },
  searchLive: function (query, onProgress, completeIndex) {
    var self = this;
    /* Text-entry uses the local page index immediately. A deliberate submitted
       search may complete it page-by-page when the portal has no documented
       search endpoint; never substitute get_all_channels for that operation. */
    if (!completeIndex) return Promise.resolve(this.searchLoadedLive(query));
    return this._loadAllLive(onProgress).then(function () { return self.searchLoadedLive(query); });
  },
  _logo: function (l) { if (!l) return ''; if (/^https?:/i.test(l)) return l; return this.base + '/stalker_portal/misc/logos/320/' + l; },
  _pageAll: function (params, mapFn, maxPages) {
    var self = this, out = [], page = 1, total = 0, pageSize = 14;
    /* 200 pages protects the TV from a runaway portal while no longer silently cutting
       the "All" catalogues to 20 pages. */
    maxPages = maxPages || 200;
    function next() {
      params.p = page;
      return self._call(params).then(function (r) {
        var data = stalkerRows(r), info = stalkerPageInfo(r, data, page); total = info.total || total; pageSize = info.pageSize || pageSize;
        data.forEach(function (x) { out.push(mapFn(x)); });
        /* Some portals omit total_items; then the first short page is the end. */
        var more = total ? out.length < total : info.hasMore;
        if (data.length && more && page < maxPages) { page++; return next(); }
        return out;
      });
    }
    return next();
  },
  vodStreams: function (catId) {
    var self = this, key = 'vod_' + (catId || 'all'), c = Store.cacheGet(this.acc.id, key, 3600e3); if (c) return Promise.resolve(c);
    return this._pageAll({ type: 'vod', action: 'get_ordered_list', category: catId || '*', genre: catId || '*', sortby: 'added', fav: 0, hd: 0, not_ended: 0 }, function (x) {
      return { type: Number(x.is_series) === 1 ? 'series' : 'movie', id: String(x.id), name: x.name, poster: x.screenshot_uri || x.pic || '', catId: String(x.category_id || catId || ''), rating: x.rating_imdb || x.rating_kinopoisk || '', plot: x.description || '', year: x.year || '', genre: x.genres_str || '', cast: x.actors || '', director: x.director || '', cmd: x.cmd, duration: x.time || '', added: Date.parse(x.added) || 0, series: x.series || [] };
    }, catId ? 100 : 200).then(function (list) { Store.cacheSet(self.acc.id, key, list); return list; });
  },
  seriesList: function (catId) {
    var self = this, key = 'series_' + (catId || 'all'), c = Store.cacheGet(this.acc.id, key, 3600e3); if (c) return Promise.resolve(c);
    return this._pageAll({ type: 'series', action: 'get_ordered_list', category: catId || '*', genre: catId || '*', sortby: 'added', fav: 0, hd: 0, not_ended: 0 }, function (x) {
      return { type: 'series', id: String(x.id), name: x.name, poster: x.screenshot_uri || x.pic || '', catId: String(x.category_id || catId || ''), rating: x.rating_imdb || '', plot: x.description || '', year: x.year || '', genre: x.genres_str || '', cast: x.actors || '', director: x.director || '', cmd: x.cmd, added: Date.parse(x.added) || 0 };
    }, catId ? 100 : 200).then(function (list) {
      if (list.length) { Store.cacheSet(self.acc.id, key, list); return list; }
      // fallback: portals that expose series inside VOD (is_series=1)
      return self.vodStreams(catId).then(function (v) { return v.filter(function (x) { return x.type === 'series'; }); });
    }).catch(function () { return self.vodStreams(catId).then(function (v) { return v.filter(function (x) { return x.type === 'series'; }); }); });
  },
  vodInfo: function (id, item) { return Promise.resolve(item || { type: 'movie', id: id }); },
  seriesInfo: function (id, item) {
    var self = this; item = item || {};
    // Stalker "series" module: seasons are items with movie_id parent, episodes listed in `series` array
    return this._call({ type: 'series', action: 'get_ordered_list', movie_id: id, category: '*', p: 1 }).then(function (r) {
      var data = stalkerRows(r), seasons = [];
      if (data.length) {
        data.forEach(function (s, idx) {
          var eps = (s.series || []).map(function (n) { return { type: 'episode', id: s.id + ':' + n, seriesId: String(id), season: idx + 1, episode: Number(n), name: 'Episode ' + n, cmd: s.cmd, seriesNum: n, thumb: s.screenshot_uri || '' }; });
          seasons.push({ num: idx + 1, name: s.name || ('Season ' + (idx + 1)), episodes: eps });
        });
      } else if (item.series && item.series.length) {
        seasons.push({ num: 1, name: 'Season 1', episodes: item.series.map(function (n) { return { type: 'episode', id: id + ':' + n, seriesId: String(id), season: 1, episode: Number(n), name: 'Episode ' + n, cmd: item.cmd, seriesNum: n }; }) });
      }
      item.seasons = seasons; item.type = 'series'; return item;
    }).catch(function () { item.seasons = []; return item; });
  },
  shortEPG: function (streamId, limit) {
    return this._call({ type: 'itv', action: 'get_short_epg', ch_id: streamId, size: limit || 10 }).then(function (r) {
      return stalkerRows(r).map(function (e) { return { title: e.name || e.title || '', desc: e.descr || e.description || '', start: Number(e.start_timestamp || e.start), end: Number(e.stop_timestamp || e.end) }; });
    }).catch(function () { return []; });
  },
  _linkCommand: function (reply) {
    /* Ministra releases put the create_link command in different envelopes.
       Resolve all documented shapes instead of treating a valid link as blank. */
    if (typeof reply === 'string') return reply;
    if (!reply || typeof reply !== 'object') return '';
    return reply.cmd || reply.command || reply.url || reply.data && (typeof reply.data === 'string' ? reply.data : (reply.data.cmd || reply.data.command || reply.data.url)) || reply.result && (reply.result.cmd || reply.result.command || reply.result.url) || '';
  },
  _createLink: function (item, requestOpt) {
    var self = this, cmd = item && item.cmd || '', params;
    if (!cmd) return Promise.reject(stalkerStreamError(new Error('Channel has no Stalker stream command')));
    if (item.type === 'live') params = { type: 'itv', action: 'create_link', cmd: cmd, series: '', forced_storage: '', disable_ad: 0, download: 0, force_ch_link_check: 0 };
    else if (item.type === 'episode') params = { type: 'vod', action: 'create_link', cmd: cmd, series: item.seriesNum || item.episode || '', forced_storage: '', disable_ad: 0, download: 0 };
    else params = { type: 'vod', action: 'create_link', cmd: cmd, series: '', forced_storage: '', disable_ad: 0, download: 0 };
    return this._call(params, false, 'playback', requestOpt).then(function (reply) {
      var command = self._linkCommand(reply), source;
      /* A portal must explicitly produce a link. Falling back to the old channel
         command hides a failed authorization/resolution behind a broken spinner. */
      if (!command) throw stalkerStreamError(new Error('Stalker create_link returned no stream command'));
      source = stalkerCommandSource(command);
      if (!source.url) throw stalkerStreamError(new Error('Stalker create_link returned an invalid stream URL'));
      var playable = stalkerPortalStreamUrl(source.url, self.endpoint);
      source.url = playable.url; source.loopbackRewritten = playable.loopbackRewritten;
      if (source.loopbackRewritten) stalkerDebug('Loopback stream command mapped to portal origin', { channelId: item && item.id });
      return source;
    }).catch(function (error) {
      if (error && (error.code === 'USER_CANCELLED' || error.name === 'AbortError')) throw error;
      throw stalkerStreamError(error);
    });
  },
  _playbackAuth: function (url, explicitHeaders) {
    var headers = {}, key, samePortal = stalkerSameOrigin(url, this.endpoint), portalHeaders;
    for (key in explicitHeaders || {}) if (Object.prototype.hasOwnProperty.call(explicitHeaders, key)) headers[key] = explicitHeaders[key];
    /* Do not leak a portal bearer token/cookie to a redirected CDN. Same-origin
       MAG links may require the active portal identity, so preserve it there. */
    if (samePortal) {
      portalHeaders = this._headers();
      for (key in portalHeaders) if (Object.prototype.hasOwnProperty.call(portalHeaders, key)) headers[key] = portalHeaders[key];
    }
    return { headers: headers, cookies: samePortal ? this._cookieHeader() : '', token: samePortal ? this.token || '' : '', samePortal: samePortal };
  },
  streamUrl: function (item, requestOpt) {
    return this._createLink(item, requestOpt).then(function (source) { return source.url; });
  },
  resolveStream: function (item, requestOpt) {
    var self = this;
    return this._createLink(item, requestOpt).then(function (source) {
      var auth = self._playbackAuth(source.url, source.headers), detected = /\.m3u8(?:[?#]|$)/i.test(source.url) ? 'hls' : /\.ts(?:[?#]|$)/i.test(source.url) ? 'mpegts' : 'unknown';
      var result = {
        url: source.url, streamUrl: source.url, streamType: detected, provider: self.type, channelId: item && item.id,
        headers: auth.headers, cookies: auth.cookies, token: auth.token,
        metadata: { contentType: item && item.type, title: item && item.name, live: !!(item && item.type === 'live'), streamId: item && item.id, macPresent: !!self.mac, deviceIdPresent: !!self.deviceId, tokenPresent: !!self.token, cookiePresent: !!self._cookieHeader(), samePortal: auth.samePortal, loopbackRewritten: !!source.loopbackRewritten }
      };
      /* Safe, opt-in portal diagnostic: fields prove the authenticated resolver
         path without writing MAC, bearer values, cookies or the full stream URL. */
      stalkerDebug('Playback source', { provider: 'STALKER', channelId: result.channelId, streamId: result.metadata.streamId, streamUrl: stalkerSafeStreamUrl(result.url), tokenPresent: !!self.token, cookiePresent: !!self._cookieHeader(), deviceIdPresent: !!self.deviceId, macPresent: !!self.mac, contentType: result.streamType, httpStatus: 'pending player probe', playerStrategy: 'webos adapter' });
      return result;
    });
  },
  _cleanCmd: function (c) { return stalkerCommandSource(c).url; },
  catchupUrl: function (item, startTs, durationMin) {
    return this._call({ type: 'tv_archive', action: 'create_link', cmd: item.cmd, series: '', forced_storage: '', disable_ad: 0, download: 0, start: startTs, real_time: 1 }).then(function (r) { return this._cleanCmd(r && r.cmd); }.bind(this));
  }
};
