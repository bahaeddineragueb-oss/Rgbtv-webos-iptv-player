/* RGBTv — provider-neutral playback core for LG webOS web applications.
 * The stable HTMLVideoElement remains the webOS media surface. Providers only
 * resolve metadata into a normalized stream object; this module owns sessions,
 * recovery, error classification and stale-work cancellation. */
var StreamTypeDetector = (function () {
  function clean(url) { return String(url || '').split('|')[0]; }
  function detect(url, declared) {
    var source = clean(url), lower = source.toLowerCase(), path = lower.split(/[?#]/)[0], type = '';
    declared = String(declared || '').toLowerCase();
    if (/mpegurl|m3u8/.test(declared) || /\.m3u8$/.test(path) || /[?&](?:type|output|format|extension)=m3u8(?:[&#]|$)/.test(lower) || /\/(?:hls|playlist)(?:[/?#]|$)/.test(lower)) type = 'hls';
    else if (/dash|mpd/.test(declared) || /\.mpd$/.test(path) || /[?&](?:type|format)=mpd(?:[&#]|$)/.test(lower)) type = 'dash';
    else if (/mp2t|mpeg-ts|transportstream/.test(declared) || /\.ts$/.test(path) || /[?&](?:type|output|format)=ts(?:[&#]|$)/.test(lower)) type = 'mpegts';
    else if (/video\/mp4/.test(declared) || /\.m4v$|\.mp4$/.test(path)) type = 'mp4';
    else if (/matroska|\.mkv$/.test(path)) type = 'mkv';
    else type = 'unknown';
    return { type: type, url: source };
  }
  function isHttp(url) { return /^https?:\/\//i.test(String(url || '')); }
  return { detect: detect, clean: clean, isHttp: isHttp };
})();

var StreamResolver = (function () {
  function cancelled() { var e = new Error('Playback request cancelled'); e.name = 'AbortError'; e.code = 'USER_CANCELLED'; return e; }
  function copyHeaders(input) {
    var out = {}, key, value;
    for (key in input || {}) if (Object.prototype.hasOwnProperty.call(input, key)) {
      value = String(input[key] == null ? '' : input[key]);
      if (value && value.length <= 2048 && !/[\r\n]/.test(value)) out[key] = value;
    }
    return out;
  }
  function normalize(value, provider, item) {
    var raw = value && typeof value === 'object' ? value : { url: value }, url = raw.url || (item && item.url), detected;
    if (!url || !StreamTypeDetector.isHttp(url)) throw new PlaybackError('SOURCE_ERROR', 'Invalid or missing stream URL', false, false, value);
    /* The exact URL is retained; detection operates on a copy and never changes
       tokens, query strings, encoded values, long paths, or M3U URL metadata. */
    url = String(url);
    detected = StreamTypeDetector.detect(url, raw.mimeType || raw.contentType || raw.type);
    return {
      url: url,
      type: raw.streamType || detected.type,
      provider: raw.provider || (provider && provider.type) || 'unknown',
      channelId: String(raw.channelId != null ? raw.channelId : item && item.id != null ? item.id : ''),
      headers: copyHeaders(raw.headers || raw.streamHeaders || item && (item.streamHeaders || item.headers)),
      metadata: raw.metadata || { contentType: item && item.type || '', title: item && (item.title || item.name) || '', live: !!(item && item.type === 'live') }
    };
  }
  function resolve(provider, item, opt) {
    opt = opt || {};
    if (opt.signal && opt.signal.aborted) return Promise.reject(cancelled());
    var value;
    try {
      if (opt.url) value = Promise.resolve({ url: opt.url, headers: opt.headers || item && item.streamHeaders });
      else if (provider && provider.resolveStream) value = provider.resolveStream(item, opt);
      else if (provider && provider.streamUrl) value = provider.streamUrl(item, opt);
      else value = Promise.reject(new Error('Provider cannot resolve streams'));
    } catch (e) { value = Promise.reject(e); }
    return Promise.resolve(value).then(function (result) {
      if (opt.signal && opt.signal.aborted) throw cancelled();
      return normalize(result, provider, item);
    });
  }
  return { resolve: resolve, normalize: normalize, cancelled: cancelled };
})();

function PlaybackError(code, message, recoverable, retryable, originalError, status, retryAfter) {
  this.name = 'PlaybackError'; this.code = code || 'MEDIA_ERROR'; this.message = message || 'Unable to play this channel';
  this.recoverable = !!recoverable; this.retryable = !!retryable; this.originalError = originalError || null;
  this.status = status || 0; this.retryAfter = retryAfter || 0;
}
PlaybackError.prototype = Object.create(Error.prototype);
PlaybackError.prototype.constructor = PlaybackError;

function PlaybackErrorClassifier(raw, stream) {
  if (raw instanceof PlaybackError) return raw;
  raw = raw || {};
  var text = String(raw.message || raw.details || raw.type || raw || ''), status = Number(raw.status || raw.statusCode || raw.response && (raw.response.code || raw.response.status) || 0), retryValue = raw.retryAfter || raw.response && raw.response.headers && (raw.response.headers['retry-after'] || raw.response.headers['Retry-After']) || 0, retryAfter = Number(retryValue);
  /* Retry-After permits either delay-seconds or an HTTP date. */
  if (!retryAfter && retryValue && !/^\d+(?:\.\d+)?$/.test(String(retryValue))) { var retryDate = Date.parse(retryValue); if (!isNaN(retryDate)) retryAfter = Math.max(0, retryDate - Date.now()); }
  if (retryAfter > 0 && retryAfter < 1000) retryAfter *= 1000;
  if (raw.name === 'AbortError' || raw.code === 'USER_CANCELLED' || /cancelled|canceled/i.test(text)) return new PlaybackError('USER_CANCELLED', 'Playback request cancelled', false, false, raw);
  if (status === 401 || status === 403 || /HTTP\s*(401|403)|unauthori[sz]ed|forbidden|token.*(?:expired|invalid)/i.test(text)) return new PlaybackError(status === 401 ? 'AUTH_ERROR' : 'AUTH_ERROR', 'Access to this stream was denied', false, false, raw, status);
  if (status === 404 || /HTTP\s*404|not found/i.test(text)) return new PlaybackError('HTTP_ERROR', 'Stream was not found', false, false, raw, status);
  if (status === 429 || /HTTP\s*429|too many requests|rate limit/i.test(text)) return new PlaybackError('HTTP_ERROR', 'Stream server is rate limiting requests', true, true, raw, status, retryAfter);
  if (raw.hls && raw.type === 'mediaError') return new PlaybackError('MEDIA_ERROR', 'Media decoder error', true, true, raw, status);
  if (raw.nativeCode === 4 || /not supported|unsupported format|demux|manifest incompatible/i.test(text)) return new PlaybackError('UNSUPPORTED_FORMAT', 'This stream format is not supported by this TV', false, false, raw, status);
  if (raw.code === 'TIMEOUT' || /timeout|timed out/i.test(text)) return new PlaybackError('TIMEOUT', 'Stream request timed out', true, true, raw, status, retryAfter);
  if (raw.nativeCode === 2 || raw.hls && raw.type === 'networkError' || /network|offline|connection|dns|failed to fetch/i.test(text)) return new PlaybackError('NETWORK_ERROR', 'Network error while loading stream', true, true, raw, status, retryAfter);
  if (raw.code === 'BUFFER_ERROR' || /stall|buffer/i.test(text)) return new PlaybackError('BUFFER_ERROR', 'Stream stopped buffering', true, true, raw, status, retryAfter);
  if (stream && stream.type === 'dash') return new PlaybackError('UNSUPPORTED_FORMAT', 'DASH is not supported by this TV playback engine', false, false, raw, status);
  return new PlaybackError('MEDIA_ERROR', 'Unable to play this stream', true, true, raw, status, retryAfter);
}

function PlaybackRecoveryManager(callbacks) {
  this.callbacks = callbacks || {}; this.session = 0; this.attempt = 0; this.timer = null;
  this.delays = [2000, 5000, 10000]; this.maxAttempts = this.delays.length;
}
PlaybackRecoveryManager.prototype = {
  begin: function (session) { this.cancel(); this.session = session; this.attempt = 0; },
  cancel: function () { if (this.timer) clearTimeout(this.timer); this.timer = null; },
  pending: function () { return !!this.timer; },
  recover: function (session, error) {
    var self = this;
    if (session !== this.session || this.timer) return false;
    if (!error || !error.retryable || this.attempt >= this.maxAttempts) { if (this.callbacks.onGiveUp) this.callbacks.onGiveUp(session, error, this.attempt); return false; }
    this.attempt++;
    var delay = Number(error.retryAfter) || this.delays[this.attempt - 1];
    delay = Math.max(250, Math.min(60000, delay));
    if (this.callbacks.onRecovering) this.callbacks.onRecovering(session, error, this.attempt, this.maxAttempts, delay);
    this.timer = setTimeout(function () {
      self.timer = null;
      if (session === self.session && self.callbacks.onRetry) self.callbacks.onRetry(session, self.attempt, error);
    }, delay);
    return true;
  },
  retryNow: function (session) {
    if (session !== this.session || !this.timer) return false;
    clearTimeout(this.timer); this.timer = null;
    if (this.callbacks.onRetry) this.callbacks.onRetry(session, this.attempt, null);
    return true;
  }
};

var PlaybackManager = (function () {
  var STATES = { IDLE: 'IDLE', LOADING: 'LOADING', READY: 'READY', PLAYING: 'PLAYING', BUFFERING: 'BUFFERING', RECOVERING: 'RECOVERING', STOPPING: 'STOPPING', ERROR: 'ERROR' };
  function makeAbortController() {
    if (typeof AbortController !== 'undefined') return new AbortController();
    return { signal: { aborted: false }, abort: function () { this.signal.aborted = true; } };
  }
  function redactedSource(url) {
    var clean = StreamTypeDetector.clean(url).replace(/\/\/[^@/]+@/, '//');
    clean = clean.replace(/([?&](?:username|password|token|auth|authorization|mac|key|sig)=)[^&]*/ig, '$1[redacted]');
    /* Development diagnostics identify the origin and format, not the private path. */
    var m = clean.match(/^(https?:\/\/[^/]+)/i); return m ? m[1] + '/…' : 'source';
  }
  function debug(event, data) {
    if (typeof window === 'undefined' || !window.RGBTvDebug || !window.console || !console.log) return;
    try { console.log('[RGBTV PLAYER] ' + event, data || ''); } catch (e) { }
  }
  function Manager(options) {
    this.adapter = options.adapter; this.resolve = options.resolve; this.onState = options.onState || function () {};
    this.onSource = options.onSource || function () {}; this.onError = options.onError || function () {};
    this.sessionId = 0; this.state = STATES.IDLE; this.current = null; this.options = null; this.stream = null; this.engine = 'native';
    this.abortController = null; this.startedAt = 0; this.lastProgress = 0; this.hasMetadata = false; this.userPaused = false; this.mediaRecovered = false; this.hlsFallbackTried = false;
    var self = this;
    this.recovery = new PlaybackRecoveryManager({
      onRecovering: function (session, error, attempt, max, delay) { self._setState(STATES.RECOVERING, { error: error, attempt: attempt, max: max, delay: delay }); self._log('Recovering', { retry: attempt + '/' + max, error: error.code }); },
      onRetry: function (session) { self._retry(session); },
      onGiveUp: function (session, error, attempts) { if (!self.isCurrent(session)) return; self._setState(STATES.ERROR, { error: error, attempt: attempts, max: self.recovery.maxAttempts }); self.onError(error, attempts, self.recovery.maxAttempts); self._log('Error', { code: error && error.code, retries: attempts }); }
    });
    this.watchdogTimer = setInterval(function () { self._watchdog(); }, 3000);
  }
  Manager.prototype = {
    isCurrent: function (session) { return session === this.sessionId && !!this.current; },
    attempts: function () { return this.recovery.attempt; },
    currentSession: function () { return this.sessionId; },
    _log: function (event, extra) {
      var stream = this.stream || {}, data = { session: this.sessionId, provider: stream.provider || this.current && this.current.provider || '', channelId: stream.channelId || this.current && this.current.id || '', streamType: stream.type || '', engine: this.engine || '' }, key;
      if (stream.url) data.source = redactedSource(stream.url);
      for (key in extra || {}) if (Object.prototype.hasOwnProperty.call(extra, key)) data[key] = extra[key];
      debug(event, data);
    },
    _setState: function (state, detail) { this.state = state; this.onState(state, detail || {}, this.sessionId); },
    _abort: function () { if (this.abortController) { try { this.abortController.abort(); } catch (e) { } } this.abortController = null; },
    _clear: function () { if (this.adapter && this.adapter.clear) this.adapter.clear(); },
    play: function (item, opt) {
      /* Advance first so callbacks triggered while the old source is being
         detached cannot belong to, or overwrite, the new channel session. */
      opt = opt || {}; this.sessionId++;
      /* Detach ownership before clearing the element: native events triggered by
         pause/removeAttribute are now guaranteed to be ignored as stale. */
      this.current = null; this.stream = null; this._abort(); this.recovery.cancel(); this._clear();
      this.current = item; this.options = opt; this.engine = 'native'; this.startedAt = Date.now(); this.lastProgress = this.startedAt;
      this.hasMetadata = false; this.userPaused = false; this.mediaRecovered = false; this.hlsFallbackTried = false; this.abortController = makeAbortController(); this.recovery.begin(this.sessionId);
      this._setState(STATES.LOADING, { initial: true }); this._log('Channel selected', { provider: opt.provider || '' });
      return this._open(this.sessionId, true, 0);
    },
    _open: function (session, initial, resumeAt) {
      var self = this, item = this.current, opt = this.options || {}, request = {};
      if (!this.isCurrent(session)) return Promise.resolve(null);
      this._setState(STATES.LOADING, { initial: !!initial, retry: !initial, resolving: true, attempt: this.recovery.attempt });
      this.lastProgress = Date.now(); this.hasMetadata = false;
      request.signal = this.abortController && this.abortController.signal;
      /* A catch-up URL is already resolved by its provider; normal live retries
         deliberately re-resolve to refresh expiring Stalker/Xtream links. */
      if (opt.url && item.type === 'catchup') request.url = opt.url;
      return this.resolve(item, request).then(function (stream) {
        if (!self.isCurrent(session)) return null;
        self.stream = stream; if (initial) self.engine = 'native'; self.mediaRecovered = false;
        if (stream.type === 'dash' && (!self.adapter || !self.adapter.canPlayDash || !self.adapter.canPlayDash(stream))) {
          self.fail(new PlaybackError('UNSUPPORTED_FORMAT', 'DASH is not supported by this TV playback engine', false, false, null), session); return null;
        }
        self._log('Source resolved', { source: redactedSource(stream.url), initial: !!initial });
        self.onSource(stream, session, { initial: !!initial, resumeAt: resumeAt || 0 });
        self._setState(STATES.LOADING, { source: true, initial: !!initial, retry: !initial, attempt: self.recovery.attempt });
        /* Once a native HLS handoff succeeded, recover with that selected engine
           rather than bouncing back and forth between two decoders. */
        var engine = self.engine === 'hls' && self.hlsFallbackTried && stream.type === 'hls' ? 'hls' : 'native';
        self.engine = engine;
        if (self.adapter && self.adapter.load) self.adapter.load(stream, session, engine);
        return stream;
      }, function (error) {
        if (!self.isCurrent(session)) return null;
        self.fail(error, session); return null;
      });
    },
    fail: function (raw, session) {
      session = session == null ? this.sessionId : session;
      if (!this.isCurrent(session) || this.state === STATES.STOPPING) return false;
      var error = PlaybackErrorClassifier(raw, this.stream);
      if (error.code === 'USER_CANCELLED') return false;
      /* HLS has one controlled native-to-hls.js handover. It is an engine change,
         not a retry and cannot cycle back to native for the same session. */
      if (this.stream && this.stream.type === 'hls' && this.engine === 'native' && !this.hlsFallbackTried && this.adapter && this.adapter.canUseHls && this.adapter.canUseHls()) {
        this.hlsFallbackTried = true; this.engine = 'hls'; this.hasMetadata = false; this.lastProgress = Date.now();
        this._setState(STATES.LOADING, { fallback: true }); this._log('Native HLS fallback');
        this.adapter.load(this.stream, session, 'hls'); return true;
      }
      /* hls.js offers one decoder-specific recovery. Further media errors use the
         same bounded RecoveryManager as every other source. */
      if (error.code === 'MEDIA_ERROR' && this.engine === 'hls' && !this.mediaRecovered && this.adapter && this.adapter.recoverMedia) {
        this.mediaRecovered = true; this._setState(STATES.BUFFERING, { mediaRecovery: true }); this.adapter.recoverMedia(session); return true;
      }
      this._log('Playback failure', { code: error.code, status: error.status || '', retryable: error.retryable });
      return this.recovery.recover(session, error);
    },
    mediaEvent: function (name, detail) {
      if (!this.current || this.state === STATES.STOPPING) return;
      detail = detail || {};
      if (name === 'loadstart') { this._setState(STATES.LOADING, {}); this._log('Load started'); return; }
      if (name === 'loadedmetadata') { this.hasMetadata = true; this.lastProgress = Date.now(); this._setState(STATES.READY, {}); this._log('Metadata loaded'); return; }
      if (name === 'canplay') { this.lastProgress = Date.now(); if (this.state !== STATES.PLAYING) this._setState(STATES.READY, {}); this._log('Can play'); return; }
      if (name === 'playing') { this.lastProgress = Date.now(); this._setState(STATES.PLAYING, { startupMs: Date.now() - this.startedAt }); this._log('Playing', { startupMs: Date.now() - this.startedAt, retry: this.recovery.attempt }); return; }
      if (name === 'waiting' || name === 'stalled') { if (!this.userPaused && this.state !== STATES.RECOVERING) this._setState(STATES.BUFFERING, {}); return; }
      if (name === 'timeupdate' || name === 'progress') { if (detail.progressed !== false) { this.lastProgress = Date.now(); if (this.state === STATES.BUFFERING) this._setState(STATES.PLAYING, {}); } return; }
      if (name === 'pause') { return; }
    },
    mediaError: function (detail) { return this.fail(detail || {}, this.sessionId); },
    setUserPaused: function (paused) { this.userPaused = !!paused; },
    _retry: function (session) {
      if (!this.isCurrent(session)) return;
      var snapshot = this.adapter && this.adapter.snapshot ? this.adapter.snapshot() : {}, item = this.current;
      var resumeAt = item && item.type !== 'live' && item.type !== 'catchup' && snapshot && Number(snapshot.currentTime) > 5 ? Number(snapshot.currentTime) : 0;
      this._abort(); this._clear(); this.abortController = makeAbortController(); this.startedAt = Date.now(); this.lastProgress = this.startedAt; this.hasMetadata = false;
      this._open(session, false, resumeAt);
    },
    retryNow: function () {
      if (!this.current) return false;
      if (this.recovery.retryNow(this.sessionId)) return true;
      /* Manual retry is a new session, invalidating any failed resolver promise. */
      this.play(this.current, this.options || {}); return true;
    },
    online: function () { this.recovery.retryNow(this.sessionId); },
    _watchdog: function () {
      if (!this.current || this.userPaused || this.state === STATES.RECOVERING || this.state === STATES.ERROR || this.recovery.pending()) return;
      var snap = this.adapter && this.adapter.snapshot ? this.adapter.snapshot() : {}, now = Date.now();
      if (snap.ended || (snap.paused && Number(snap.readyState) >= 3)) return;
      var limit = this.current.type === 'live' ? 12000 : this.hasMetadata ? 30000 : 60000;
      if (now - this.lastProgress > limit && Number(snap.readyState || 0) < 3) this.fail({ code: 'BUFFER_ERROR', message: 'Playback stalled' }, this.sessionId);
      else if (!this.hasMetadata && this.current.type !== 'live' && now - this.startedAt >= 6000 && this.state === STATES.LOADING) this._setState(STATES.LOADING, { elapsed: Math.round((now - this.startedAt) / 1000) });
    },
    stop: function (clearCurrent) {
      this.sessionId++; this._setState(STATES.STOPPING, {}); this._abort(); this.recovery.cancel(); this._clear();
      if (clearCurrent !== false) { this.current = null; this.stream = null; this.options = null; }
      this._setState(STATES.IDLE, {});
    },
    destroy: function () { this.stop(); if (this.watchdogTimer) clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  };
  Manager.STATES = STATES; return Manager;
})();
