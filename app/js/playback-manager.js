/* RGBTv — provider-neutral playback core for LG webOS web applications.
 * The stable HTMLVideoElement remains the webOS media surface. Providers only
 * resolve metadata into a normalized stream object; this module owns sessions,
 * recovery, error classification and stale-work cancellation. */
var StreamTypeDetector = (function () {
  function clean(url) { return String(url || '').split('|')[0]; }
  function detect(url, declared) {
    var source = clean(url), lower = source.toLowerCase(), path = lower.split(/[?#]/)[0], type = '', extension = '', mimeType = '', protocol = '';
    declared = String(declared || '').toLowerCase();
    if (/^https:/i.test(source)) protocol = 'https'; else if (/^http:/i.test(source)) protocol = 'http';
    var ext = /\.([a-z0-9]{2,5})$/i.exec(path); extension = ext ? ext[1].toLowerCase() : '';
    if (/mpegurl|m3u8/.test(declared) || extension === 'm3u8' || /[?&](?:type|output|format|extension)=m3u8(?:[&#]|$)/.test(lower) || /\/(?:hls|playlist)(?:[/?#]|$)/.test(lower)) { type = 'hls'; mimeType = 'application/vnd.apple.mpegurl'; }
    else if (/dash|mpd/.test(declared) || extension === 'mpd' || /[?&](?:type|format)=mpd(?:[&#]|$)/.test(lower)) { type = 'dash'; mimeType = 'application/dash+xml'; }
    else if (/mp2t|mpeg-ts|transportstream/.test(declared) || extension === 'ts' || /[?&](?:type|output|format)=ts(?:[&#]|$)/.test(lower)) { type = 'mpegts'; mimeType = 'video/mp2t'; }
    else if (/video\/mp4/.test(declared) || extension === 'm4v' || extension === 'mp4') { type = 'mp4'; mimeType = 'video/mp4'; }
    else if (/matroska/.test(declared) || extension === 'mkv') { type = 'mkv'; mimeType = 'video/x-matroska'; }
    else { type = 'unknown'; mimeType = declared || ''; }
    return { type: type, url: source, extension: extension, protocol: protocol, mimeType: mimeType };
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
    var raw = value && typeof value === 'object' ? value : { url: value }, url = raw.streamUrl || raw.url || (item && item.url), detected, headers, mimeType;
    if (!url || !StreamTypeDetector.isHttp(url)) throw new PlaybackError('STREAM_RESOLUTION_ERROR', 'Invalid or missing stream URL', false, false, value);
    /* The exact URL is retained; detection operates on a copy and never changes
       tokens, query strings, encoded values, long paths, or M3U URL metadata. */
    url = String(url); headers = copyHeaders(raw.headers || raw.streamHeaders || item && (item.streamHeaders || item.headers));
    detected = StreamTypeDetector.detect(url, raw.mimeType || raw.contentType || raw.streamType || raw.type);
    mimeType = String(raw.mimeType || raw.contentType || detected.mimeType || '');
    /* StreamSource is deliberately provider-neutral. Secrets remain in memory for
       a capable adapter but diagnostics receive only redacted/boolean fields. */
    var declaredType = String(raw.streamType || raw.type || '').toLowerCase();
    if (!declaredType || declaredType === 'unknown') declaredType = detected.type;
    return {
      url: url, streamUrl: url,
      type: declaredType, streamType: declaredType,
      provider: raw.provider || (provider && provider.type) || 'unknown',
      channelId: String(raw.channelId != null ? raw.channelId : item && item.id != null ? item.id : ''),
      mimeType: mimeType, contentType: mimeType, protocol: raw.protocol || detected.protocol,
      container: raw.container || detected.extension || '', extension: detected.extension,
      codec: raw.codec || '', drm: raw.drm || null,
      headers: headers, cookies: raw.cookies || '', token: raw.token || '',
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

/* Inspection is observational and opt-in. Playback never waits for a probe and
   never sends a mandatory HEAD/full-stream request before assigning the source.
   HLS manifest facts are supplied by the adapter after the real manifest load. */
var StreamInspector = (function () {
  function truthy(value) { return value === true || value === 1 || value === '1' || value === 'true'; }
  function sourceSummary(stream) {
    var detected = StreamTypeDetector.detect(stream && (stream.streamUrl || stream.url), stream && (stream.mimeType || stream.streamType));
    return {
      provider: String(stream && stream.provider || 'unknown'), channelId: String(stream && stream.channelId || ''),
      protocol: String(stream && stream.protocol || detected.protocol || ''), streamType: String(stream && (stream.streamType || stream.type) || detected.type || 'unknown'),
      mimeType: String(stream && (stream.mimeType || stream.contentType) || detected.mimeType || ''),
      container: String(stream && stream.container || detected.extension || ''), extension: detected.extension,
      headersPresent: !!(stream && stream.headers && Object.keys(stream.headers).length), tokenPresent: !!(stream && stream.token),
      cookiePresent: !!(stream && stream.cookies), drm: !!(stream && stream.drm), httpStatus: 0, redirects: 0, mediaBytes: 0,
      hlsMaster: false, videoVariants: 0, audioOnlyVariants: 0, mixedAudioOnly: false, compatible: true
    };
  }
  function responseSummary(response) {
    var headers = response && response.headers || {}, type = headers['content-type'] || headers['Content-Type'] || '';
    return { inspected: true, httpStatus: Number(response && response.status) || 0, contentType: String(type).split(';')[0].trim(),
      redirects: Number(response && response.redirects) || 0, mediaBytes: Number(response && response.bytesRead) || String(response && response.data || response && response.body || '').length || 0,
      finalUrl: response && response.finalUrl || '' };
  }
  function hlsSummary(levels, audioTracks, text) {
    levels = levels || []; audioTracks = audioTracks || [];
    var video = 0, audioOnly = 0, index = -1, i, level, visual, source = String(text || ''), mediaVideo = /#EXT-X-MEDIA\s*:\s*TYPE\s*=\s*VIDEO\b/i.test(source), mediaTag = /#EXT-X-MEDIA\s*:/i.test(source);
    for (i = 0; i < levels.length; i++) {
      level = levels[i] || {}; visual = !!(level.videoCodec || level.width || level.height || level.videoRange);
      if (visual) { video++; if (index < 0) index = i; } else audioOnly++;
    }
    return { hlsMaster: levels.length > 1 || /#EXT-X-STREAM-INF/i.test(source), videoVariants: video, audioOnlyVariants: audioOnly,
      mixedAudioOnly: video > 0 && audioOnly > 0, selectableVideoLevel: index, extXMedia: mediaTag || audioTracks.length > 0, extXMediaVideo: mediaVideo,
      /* EXT-X-MEDIA VIDEO is a documented native-webOS compatibility concern.
         It is recorded here after the real manifest loads; hls.js may still play
         it, while native failures become a clear compatibility error. */
      nativeCompatibilityWarning: mediaVideo ? 'EXT-X-MEDIA TYPE=VIDEO' : '', compatible: true };
  }
  return { enabled: truthy, sourceSummary: sourceSummary, responseSummary: responseSummary, hlsSummary: hlsSummary };
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
  if (raw.code === 'STREAM_RESOLUTION_ERROR' || raw.phase === 'resolve' || /create_link|resolve stream|missing stream url|invalid stream url/i.test(text)) return new PlaybackError('STREAM_RESOLUTION_ERROR', 'Unable to resolve a playable stream URL', true, true, raw, status, retryAfter);
  if (raw.code === 'TOKEN_EXPIRED' || /token.*(?:expired|invalid)|expired.*token/i.test(text)) return new PlaybackError('TOKEN_ERROR', 'Stream authorization expired', true, true, raw, status, retryAfter);
  if (status === 401 || status === 403 || /HTTP\s*(401|403)|unauthori[sz]ed|forbidden|access denied/i.test(text)) return new PlaybackError('AUTHENTICATION_ERROR', 'Access to this stream was denied', false, false, raw, status);
  if (status === 404 || /HTTP\s*404|not found/i.test(text)) return new PlaybackError('HTTP_ERROR', 'Stream was not found', false, false, raw, status);
  if (status === 429 || /HTTP\s*429|too many requests|rate limit/i.test(text)) return new PlaybackError('HTTP_ERROR', 'Stream server is rate limiting requests', true, true, raw, status, retryAfter);
  if (status === 408 || status >= 500 && status <= 504 || /HTTP\s*(408|5\d\d)|server (?:temporarily )?unavailable|gateway/i.test(text)) return new PlaybackError('HTTP_ERROR', 'Stream server is temporarily unavailable', true, true, raw, status, retryAfter);
  if (raw.code === 'TIMEOUT_ERROR' || raw.code === 'TIMEOUT' || /timeout|timed out/i.test(text)) return new PlaybackError('TIMEOUT_ERROR', 'Playback did not start before its deadline', true, true, raw, status, retryAfter);
  if (raw.code === 'WEBOS_COMPATIBILITY_ERROR' || raw.nativeCode === 4 || /not supported|unsupported format|demux|manifest incompatible/i.test(text)) return new PlaybackError('WEBOS_COMPATIBILITY_ERROR', 'This stream format is not supported by this TV', false, false, raw, status);
  if (raw.hls && /codec|manifest|level|audio.*only/i.test(text)) return new PlaybackError('HLS_ERROR', 'The HLS playlist is incompatible with this TV', false, false, raw, status);
  if (raw.hls && raw.type === 'mediaError') return new PlaybackError('CODEC_ERROR', 'The TV decoder could not play this HLS variant', true, true, raw, status);
  if (raw.hls) return new PlaybackError('HLS_ERROR', 'HLS playback failed', true, true, raw, status, retryAfter);
  if (raw.code === 'MIME_ERROR' || /mime|content[ -]?type/i.test(text)) return new PlaybackError('MIME_ERROR', 'The stream returned an unsupported media type', false, false, raw, status);
  if (raw.code === 'CORS_ERROR' || /cors|cross.origin|network\/cors/i.test(text)) return new PlaybackError('CORS_ERROR', 'The stream server rejected this TV client request', false, false, raw, status);
  if (raw.nativeCode === 2 || /network|offline|connection|dns|failed to fetch/i.test(text)) return new PlaybackError('NETWORK_ERROR', 'Network error while loading stream', true, true, raw, status, retryAfter);
  if (raw.code === 'BUFFER_ERROR' || /stall|buffer/i.test(text)) return new PlaybackError('NETWORK_ERROR', 'Stream stopped buffering', true, true, raw, status, retryAfter);
  if (stream && stream.type === 'dash') return new PlaybackError('WEBOS_COMPATIBILITY_ERROR', 'DASH is not supported by this TV playback engine', false, false, raw, status);
  if (raw.code === 'PLAYER_ERROR' || raw.phase === 'player') return new PlaybackError('PLAYER_ERROR', 'The TV player could not start this stream', true, true, raw, status, retryAfter);
  return new PlaybackError('UNKNOWN_ERROR', 'Unable to start this stream', true, true, raw, status, retryAfter);
}

/* SmartBufferManager deliberately owns only observation/debouncing, never source
 * loading or retry. This prevents noisy live-TV waiting/stalled events from
 * producing a spinner or reconnect while frames are still progressing. */
function SmartBufferManager(onBuffering) {
  this.onBuffering = onBuffering || function () {}; this.timer = null; this.waiting = false;
  this.lastProgressAt = 0; this.waitingAt = 0; this.bufferingCount = 0;
}
SmartBufferManager.prototype = {
  reset: function (at, clearCount) { if (this.timer) clearTimeout(this.timer); this.timer = null; this.waiting = false; this.waitingAt = 0; if (clearCount) this.bufferingCount = 0; this.lastProgressAt = at || Date.now(); },
  wait: function () {
    var self = this;
    if (this.timer || this.waiting) return;
    this.waitingAt = Date.now();
    /* webOS may emit transient waiting for healthy HLS/TS playback. */
    this.timer = setTimeout(function () { self.timer = null; self.waiting = true; self.bufferingCount++; self.onBuffering({ waitingAt: self.waitingAt, bufferingCount: self.bufferingCount }); }, 700);
  },
  progressed: function () {
    var wasWaiting = this.waiting;
    if (this.timer) clearTimeout(this.timer); this.timer = null; this.waiting = false; this.waitingAt = 0; this.lastProgressAt = Date.now();
    return wasWaiting;
  },
  pending: function () { return !!this.timer; },
  destroy: function () { this.reset(0); }
};

/* Per-session local-only timings. Values contain no URL, credentials, title or
 * provider payload and can therefore safely feed the advanced player stats. */
function PlaybackMetrics() { this.reset(0); }
PlaybackMetrics.prototype = {
  reset: function (startedAt) {
    this.startupStartedAt = startedAt || 0; this.streamResolveStartedAt = 0; this.sourceAssignedAt = 0;
    this.loadStartedAt = 0; this.metadataLoadedAt = 0; this.canPlayAt = 0; this.playingAt = 0;
    this.startupDuration = 0; this.streamResolveTime = 0; this.bufferingCount = 0; this.recoveryCount = 0;
    this.retryCount = 0; this.networkErrors = 0; this.failureCount = 0; this.lastErrorCode = ''; this.networkState = 0;
    this.channelSwitchDuration = 0; this.timeToFirstFrame = 0; this.bufferingDuration = 0;
    this.lastCurrentTime = 0; this.lastCurrentTimeAt = 0; this.sameStreamResolutions = 0;
    this.provider = ''; this.channelId = ''; this.streamType = ''; this.protocol = ''; this.mimeType = ''; this.container = ''; this.codec = '';
    this.strategy = ''; this.streamUrl = ''; this.httpStatus = 0; this.redirects = 0; this.mediaBytes = 0; this.lastEvent = ''; this.lastEventAt = 0;
    this.tokenPresent = false; this.cookiePresent = false; this.headersPresent = false; this.hlsMaster = false; this.videoVariants = 0; this.audioOnlyVariants = 0; this.mixedAudioOnly = false; this.extXMedia = false; this.extXMediaVideo = false; this.nativeCompatibilityWarning = ''; this.inspectionError = '';
  },
  source: function (stream, detail) {
    detail = detail || {}; this.provider = String(stream && stream.provider || ''); this.channelId = String(stream && stream.channelId || '');
    this.streamType = String(stream && (stream.streamType || stream.type) || ''); this.protocol = String(stream && stream.protocol || '');
    this.mimeType = String(stream && (stream.mimeType || stream.contentType) || ''); this.container = String(stream && stream.container || ''); this.codec = String(stream && stream.codec || '');
    this.streamUrl = String(detail.streamUrl || ''); this.tokenPresent = !!(stream && stream.token); this.cookiePresent = !!(stream && stream.cookies); this.headersPresent = !!(stream && stream.headers && Object.keys(stream.headers).length);
  },
  inspected: function (detail) {
    detail = detail || {}; this.httpStatus = Number(detail.httpStatus || detail.status) || this.httpStatus; this.redirects = Number(detail.redirects) || 0;
    this.mediaBytes = Number(detail.mediaBytes || detail.bytesRead) || 0; if (detail.contentType) this.mimeType = String(detail.contentType); if (detail.finalUrl) this.streamUrl = String(detail.finalUrl);
    if (detail.error) this.inspectionError = String(detail.error);
  },
  event: function (name) { this.lastEvent = String(name || ''); this.lastEventAt = Date.now(); },
  hls: function (detail) {
    detail = detail || {}; this.hlsMaster = !!detail.hlsMaster; this.videoVariants = Number(detail.videoVariants) || 0; this.audioOnlyVariants = Number(detail.audioOnlyVariants) || 0; this.mixedAudioOnly = !!detail.mixedAudioOnly; this.extXMedia = !!detail.extXMedia; this.extXMediaVideo = !!detail.extXMediaVideo; this.nativeCompatibilityWarning = String(detail.nativeCompatibilityWarning || '');
    if (detail.videoCodec || detail.audioCodec) this.codec = [detail.videoCodec, detail.audioCodec].filter(Boolean).join(' / '); else if (detail.codec) this.codec = String(detail.codec);
  },
  snapshot: function () {
    return { startupStartedAt: this.startupStartedAt, sourceAssignedAt: this.sourceAssignedAt, loadStartedAt: this.loadStartedAt,
      metadataLoadedAt: this.metadataLoadedAt, canPlayAt: this.canPlayAt, playingAt: this.playingAt, startupDuration: this.startupDuration,
      streamResolveTime: this.streamResolveTime, bufferingCount: this.bufferingCount, recoveryCount: this.recoveryCount,
      retryCount: this.retryCount, networkErrors: this.networkErrors, failureCount: this.failureCount, lastErrorCode: this.lastErrorCode, networkState: this.networkState,
      channelSwitchDuration: this.channelSwitchDuration, timeToFirstFrame: this.timeToFirstFrame, bufferingDuration: this.bufferingDuration,
      lastCurrentTime: this.lastCurrentTime, lastCurrentTimeAt: this.lastCurrentTimeAt, sameStreamResolutions: this.sameStreamResolutions,
      provider: this.provider, channelId: this.channelId, streamType: this.streamType, protocol: this.protocol, mimeType: this.mimeType, container: this.container, codec: this.codec,
      strategy: this.strategy, streamUrl: this.streamUrl, httpStatus: this.httpStatus, redirects: this.redirects, mediaBytes: this.mediaBytes, lastEvent: this.lastEvent, lastEventAt: this.lastEventAt,
      tokenPresent: this.tokenPresent, cookiePresent: this.cookiePresent, headersPresent: this.headersPresent, hlsMaster: this.hlsMaster, videoVariants: this.videoVariants, audioOnlyVariants: this.audioOnlyVariants, mixedAudioOnly: this.mixedAudioOnly, extXMedia: this.extXMedia, extXMediaVideo: this.extXMediaVideo, nativeCompatibilityWarning: this.nativeCompatibilityWarning, inspectionError: this.inspectionError };
  }
};

/* Short local circuit breaker: a broken channel/portal must not turn repeated
 * remote Retry presses into a 429-producing request storm. It never stores URLs
 * or credentials and automatically reopens after its small cooldown. */
function PlaybackCircuitBreaker() { this.entries = {}; this.windowMs = 90000; this.cooldownMs = 30000; this.threshold = 4; this.maxEntries = 120; }
PlaybackCircuitBreaker.prototype = {
  allow: function (key, now) { var item = this.entries[key]; now = now || Date.now(); return !item || item.openUntil <= now; },
  failure: function (key, now) {
    var self = this, item = this.entries[key] || { times: [], openUntil: 0 }; now = now || Date.now();
    item.times = item.times.filter(function (time) { return now - time <= self.windowMs; }); item.times.push(now); item.lastAt = now;
    if (item.times.length >= this.threshold) item.openUntil = now + this.cooldownMs;
    this.entries[key] = item;
    var keys = Object.keys(this.entries);
    if (keys.length > this.maxEntries) { keys.sort(function (a, b) { return self.entries[a].lastAt - self.entries[b].lastAt; }); keys.slice(0, keys.length - this.maxEntries).forEach(function (old) { delete self.entries[old]; }); }
    return item.openUntil > now;
  },
  success: function (key) { delete this.entries[key]; }
};

function streamFingerprint(stream) {
  var input = String(stream && stream.url || ''), headers = stream && stream.headers || {}, key, hash = 2166136261;
  /* A non-cryptographic private in-memory fingerprint: sufficient to detect a
     changed token/source without exposing it in UI, logs or persisted storage. */
  for (key in headers) if (Object.prototype.hasOwnProperty.call(headers, key)) input += '\n' + key + ':' + headers[key];
  for (var i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24); }
  return (hash >>> 0).toString(36);
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
  var STATES = { IDLE: 'IDLE', RESOLVING_STREAM: 'RESOLVING_STREAM', STREAM_RESOLVED: 'STREAM_RESOLVED', PREPARING_PLAYER: 'PREPARING_PLAYER', LOADING: 'LOADING', CAN_PLAY: 'CAN_PLAY', PLAYING: 'PLAYING', PAUSED: 'PAUSED', BUFFERING: 'BUFFERING', RETRYING: 'RETRYING', ERROR: 'ERROR', STOPPED: 'STOPPED', TIMEOUT: 'TIMEOUT' };
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
    this.adapter = options.adapter || {}; this.resolve = options.resolve; this.refreshSession = options.refreshSession || function () { return Promise.resolve(false); }; this.onState = options.onState || function () {};
    this.onSource = options.onSource || function () {}; this.onError = options.onError || function () {};
    this.sessionId = 0; this.requestId = 0; this.state = STATES.IDLE; this.current = null; this.options = null; this.stream = null; this.engine = 'native';
    this.abortController = null; this.startedAt = 0; this.lastProgress = 0; this.lastCurrentTime = -1; this.lastCurrentTimeAt = 0; this.hasMetadata = false; this.userPaused = false; this.mediaRecovered = false; this.hlsFallbackTried = false; this.networkOffline = false;
    this.metrics = new PlaybackMetrics(); this.circuit = new PlaybackCircuitBreaker(); this.streamFingerprint = ''; this.sameSourceReloadTried = false; this.lastError = null; this.providerType = ''; this.tokenRefreshTried = false;
    this.resolveTimer = null; this.startTimer = null; this.timeouts = { resolve: Number(options.resolveTimeout) || 45000, start: Number(options.startTimeout) || 30000 };
    var self = this;
    this.buffer = new SmartBufferManager(function (detail) {
      if (!self.current || self.userPaused || self.state === STATES.RETRYING || self.state === STATES.ERROR || self.state === STATES.STOPPING) return;
      self.metrics.bufferingCount = detail.bufferingCount;
      self._setState(STATES.BUFFERING, { bufferingCount: detail.bufferingCount }); self._log('Buffering', { count: detail.bufferingCount });
    });
    this.recovery = new PlaybackRecoveryManager({
      onRecovering: function (session, error, attempt, max, delay) { self.metrics.recoveryCount++; self.metrics.retryCount = attempt; self._setState(STATES.RETRYING, { error: error, attempt: attempt, max: max, delay: delay }); self._log('Recovering', { retry: attempt + '/' + max, error: error.code }); },
      onRetry: function (session, attempt, error) { self._retry(session, attempt, error); },
      onGiveUp: function (session, error, attempts) { if (!self.isCurrent(session)) return; self._setState(STATES.ERROR, { error: error, attempt: attempts, max: self.recovery.maxAttempts }); self.onError(error, attempts, self.recovery.maxAttempts); self._log('Error', { code: error && error.code, retries: attempts }); }
    });
    this.watchdogTimer = setInterval(function () { self._watchdog(); }, 3000);
  }
  Manager.prototype = {
    isCurrent: function (session) { return session === this.sessionId && !!this.current; },
    attempts: function () { return this.recovery.attempt; },
    currentSession: function () { return this.sessionId; },
    diagnostics: function () { var snapshot = this.metrics.snapshot(); snapshot.currentState = this.state; snapshot.lastError = this.lastError && this.lastError.code || ''; return snapshot; },
    _clearDeadline: function (kind) { var key = kind === 'resolve' ? 'resolveTimer' : 'startTimer'; if (this[key]) clearTimeout(this[key]); this[key] = null; },
    _clearDeadlines: function () { this._clearDeadline('resolve'); this._clearDeadline('start'); },
    _armDeadline: function (kind, session, requestId) {
      var self = this, key = kind === 'resolve' ? 'resolveTimer' : 'startTimer', wait = Number(this.timeouts[kind]) || 0;
      this._clearDeadline(kind); if (!wait) return;
      this[key] = setTimeout(function () {
        self[key] = null;
        if (!self.isCurrent(session) || self.requestId !== requestId) return;
        /* A deadline is a real deterministic state transition, not a cosmetic
           spinner change. Abort obsolete resolver work before recovery begins. */
        if (kind === 'resolve') self._abort();
        self._setState(STATES.TIMEOUT, { phase: kind, timeout: wait, attempt: self.recovery.attempt });
        self._log('Playback timeout', { phase: kind, timeout: wait });
        self.fail({ code: 'TIMEOUT_ERROR', phase: kind, message: kind === 'resolve' ? 'Stream resolution timed out' : 'Playback start timed out' }, session);
      }, wait);
      /* Do not hold Node-based regression tests open; webOS returns a numeric
         handle and simply ignores this optional Node convenience. */
      if (this[key] && this[key].unref) this[key].unref();
    },
    _circuitKey: function () { return String(this.current && this.current.provider || this.options && this.options.provider || this.stream && this.stream.provider || this.providerType || 'unknown') + ':' + String(this.current && this.current.id || this.stream && this.stream.channelId || ''); },
    _log: function (event, extra) {
      var stream = this.stream || {}, data = { session: this.sessionId, provider: stream.provider || this.current && this.current.provider || '', channelId: stream.channelId || this.current && this.current.id || '', streamType: stream.type || '', engine: this.engine || '' }, key;
      if (stream.url) data.source = redactedSource(stream.url);
      for (key in extra || {}) if (Object.prototype.hasOwnProperty.call(extra, key)) data[key] = extra[key];
      debug(event, data);
    },
    _setState: function (state, detail) { this.state = state; this.onState(state, detail || {}, this.sessionId); },
    _abort: function () { if (this.abortController) { try { this.abortController.abort(); } catch (e) { } } this.abortController = null; },
    _clear: function () { if (this.adapter && this.adapter.clear) this.adapter.clear(); },
    _bufferProgressed: function (now) { var began = this.buffer.waitingAt, recovered = this.buffer.progressed(); if (recovered && began) this.metrics.bufferingDuration += Math.max(0, now - began); return recovered; },
    _inspect: function (stream, session, requestId) {
      var self = this;
      if (!this.adapter || !this.adapter.inspect) return;
      try {
        Promise.resolve(this.adapter.inspect(stream)).then(function (detail) {
          if (!self.isCurrent(session) || self.requestId !== requestId || !detail) return;
          /* A redirected inspection URL can include a short-lived stream token.
             Metrics remain safe to display/export by retaining only its origin. */
          if (detail.finalUrl) detail.finalUrl = redactedSource(detail.finalUrl);
          self.metrics.inspected(detail); self._log('Stream inspected', { status: detail.httpStatus || '', redirects: detail.redirects || 0, bytes: detail.mediaBytes || 0 });
        }, function (err) {
          if (!self.isCurrent(session) || self.requestId !== requestId) return;
          /* Inspection is diagnostic-only: a CORS/range refusal never blocks the
             actual media handoff or turns a playable stream into a false error. */
          self.metrics.inspected({ error: String(err && err.message || err || 'inspection failed') }); self._log('Stream inspection unavailable');
        });
      } catch (e) { this.metrics.inspected({ error: String(e && e.message || e) }); }
    },
    inspectNow: function () {
      var self = this, session = this.sessionId, requestId = this.requestId, stream = this.stream;
      if (!stream || !this.adapter || !this.adapter.inspect) return Promise.resolve(null);
      /* Opening the existing INFO/BLUE diagnostics panel is an explicit developer
         action, so it may request the bounded Range observation after playback
         has already started. This remains outside the play critical path. */
      try { return Promise.resolve(this.adapter.inspect(stream, true)).then(function (detail) {
        if (!self.isCurrent(session) || self.requestId !== requestId || !detail) return null;
        if (detail.finalUrl) detail.finalUrl = redactedSource(detail.finalUrl); self.metrics.inspected(detail); self._log('Developer stream inspection', { status: detail.httpStatus || '', redirects: detail.redirects || 0, bytes: detail.mediaBytes || 0 }); return detail;
      }, function (error) { if (self.isCurrent(session)) self.metrics.inspected({ error: String(error && error.message || error || 'inspection failed') }); return null; }); }
      catch (e) { this.metrics.inspected({ error: String(e && e.message || e) }); return Promise.resolve(null); }
    },
    play: function (item, opt) {
      /* Advance first so callbacks triggered while the old source is being
         detached cannot belong to, or overwrite, the new channel session. */
      opt = opt || {}; this.sessionId++; this.requestId++;
      /* Detach ownership before clearing the element: native events triggered by
         pause/removeAttribute are now guaranteed to be ignored as stale. */
      this.current = null; this.stream = null; this._abort(); this._clearDeadlines(); this.recovery.cancel(); this._clear();
      this.current = item; this.options = opt; this.providerType = String(opt.provider || item && item.provider || this.providerType || ''); this.engine = 'native'; this.startedAt = Date.now(); this.lastProgress = this.startedAt; this.lastCurrentTime = -1; this.lastCurrentTimeAt = this.startedAt;
      this.metrics.reset(this.startedAt); this.metrics.lastCurrentTimeAt = this.startedAt; this.buffer.reset(this.startedAt, true); this.streamFingerprint = ''; this.sameSourceReloadTried = false; this.lastError = null; this.tokenRefreshTried = false;
      this.hasMetadata = false; this.userPaused = false; this.mediaRecovered = false; this.hlsFallbackTried = false; this.networkOffline = false; this.abortController = makeAbortController(); this.recovery.begin(this.sessionId);
      if (!this.circuit.allow(this._circuitKey(), this.startedAt)) {
        var blocked = new PlaybackError('CIRCUIT_OPEN', 'This channel is temporarily paused after repeated failures. Please try again shortly.', false, false, null);
        this.metrics.lastErrorCode = blocked.code; this._setState(STATES.ERROR, { error: blocked, circuitOpen: true }); this.onError(blocked, this.recovery.attempt, this.recovery.maxAttempts); return Promise.resolve(null);
      }
      this._log('Channel selected', { provider: opt.provider || '' });
      return this._open(this.sessionId, true, 0);
    },
    _open: function (session, initial, resumeAt) {
      var self = this, item = this.current, opt = this.options || {}, request = {}, requestId;
      if (!this.isCurrent(session)) return Promise.resolve(null);
      requestId = ++this.requestId;
      this._setState(STATES.RESOLVING_STREAM, { initial: !!initial, retry: !initial, attempt: this.recovery.attempt });
      this.lastProgress = Date.now(); this.hasMetadata = false; this.metrics.streamResolveStartedAt = this.lastProgress; this.metrics.event('resolving_stream');
      this._armDeadline('resolve', session, requestId);
      request.signal = this.abortController && this.abortController.signal;
      /* A catch-up URL is already resolved by its provider; normal live retries
         deliberately re-resolve to refresh expiring Stalker/Xtream links. */
      if (opt.url && item.type === 'catchup') request.url = opt.url;
      return this.resolve(item, request).then(function (stream) {
        if (!self.isCurrent(session) || self.requestId !== requestId) return null;
        self._clearDeadline('resolve');
        var priorFingerprint = self.streamFingerprint, nextFingerprint = streamFingerprint(stream), unchanged = !!priorFingerprint && priorFingerprint === nextFingerprint;
        self.stream = stream; self.streamFingerprint = nextFingerprint; self.providerType = self.options && self.options.provider || stream.provider || self.providerType; if (unchanged) self.metrics.sameStreamResolutions++;
        if (initial) self.engine = 'native'; self.mediaRecovered = false;
        self.metrics.streamResolveTime = Math.max(0, Date.now() - self.metrics.streamResolveStartedAt);
        self.metrics.source(stream, { streamUrl: redactedSource(stream.url) }); self.metrics.event('stream_resolved');
        if (stream.type === 'dash' && (!self.adapter || !self.adapter.canPlayDash || !self.adapter.canPlayDash(stream))) {
          self.fail(new PlaybackError('WEBOS_COMPATIBILITY_ERROR', 'DASH is not supported by this TV playback engine', false, false, null), session); return null;
        }
        self._setState(STATES.STREAM_RESOLVED, { initial: !!initial, sourceChanged: !unchanged });
        self._log('Source resolved', { source: redactedSource(stream.url), initial: !!initial, sourceChanged: !unchanged, type: stream.type, protocol: stream.protocol });
        /* A normal re-resolve is worthwhile only when it produced a new signed URL
           or headers. After the one low-cost same-source reload, do not churn the
           identical decoder input again: consume the remaining bounded recovery
           budget without presenting a black reload loop. */
        if (!initial && unchanged && self.sameSourceReloadTried) {
          self._log('Unchanged source skipped', { attempt: self.recovery.attempt });
          self.fail(new PlaybackError('NETWORK_ERROR', 'Fresh stream resolution returned the same source', true, true, null), session); return null;
        }
        self.onSource(stream, session, { initial: !!initial, resumeAt: resumeAt || 0 });
        self._setState(STATES.PREPARING_PLAYER, { source: true, sourceChanged: !unchanged, initial: !!initial, retry: !initial, attempt: self.recovery.attempt });
        /* Once a native HLS handoff succeeded, recover with that selected engine
           rather than bouncing back and forth between two decoders. */
        var engine = self.engine === 'hls' && self.hlsFallbackTried && stream.type === 'hls' ? 'hls' : 'native';
        self.engine = engine; self.metrics.strategy = engine; self.metrics.sourceAssignedAt = Date.now(); self.metrics.event('preparing_player');
        self._armDeadline('start', session, requestId); self._inspect(stream, session, requestId);
        if (self.adapter && self.adapter.load) self.adapter.load(stream, session, engine);
        return stream;
      }, function (error) {
        if (!self.isCurrent(session) || self.requestId !== requestId) return null;
        self._clearDeadline('resolve'); self.fail(error, session); return null;
      });
    },
    fail: function (raw, session) {
      session = session == null ? this.sessionId : session;
      if (!this.isCurrent(session) || this.state === STATES.STOPPING) return false;
      var error = PlaybackErrorClassifier(raw, this.stream);
      if (error.code === 'USER_CANCELLED') return false;
      this._clearDeadlines();
      if (error.code === 'TOKEN_ERROR') {
        if (this.tokenRefreshTried) error = new PlaybackError('AUTHENTICATION_ERROR', 'Stream authorization could not be refreshed', false, false, error, error.status);
        else this.tokenRefreshTried = true;
      }
      this.metrics.lastErrorCode = error.code; this.metrics.failureCount++; this.lastError = error;
      if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT_ERROR') this.metrics.networkErrors++;
      if (this.circuit.failure(this._circuitKey(), Date.now())) {
        var blocked = new PlaybackError('CIRCUIT_OPEN', 'This channel is temporarily paused after repeated failures. Please try again shortly.', false, false, error);
        this.metrics.lastErrorCode = blocked.code; this._clearDeadlines(); this.recovery.cancel(); this._setState(STATES.ERROR, { error: blocked, circuitOpen: true }); this.onError(blocked, this.recovery.attempt, this.recovery.maxAttempts); this._log('Circuit opened', { error: error.code }); return false;
      }
      /* HLS has one controlled native-to-hls.js handover. It is an engine change,
         not a retry and cannot cycle back to native for the same session. */
      /* MAG create_link endpoints are frequently opaque PHP paths with no
         .m3u8 suffix. A native SRC_NOT_SUPPORTED result is the decisive signal:
         make one hls.js attempt for an unknown live source rather than denying a
         valid HLS stream solely because its signed URL lacks an extension. */
      if (this.stream && (this.stream.type === 'hls' || (this.stream.type === 'unknown' && this.stream.metadata && this.stream.metadata.live)) && this.engine === 'native' && !this.hlsFallbackTried && this.adapter && this.adapter.canUseHls && this.adapter.canUseHls()) {
        this.hlsFallbackTried = true; this.engine = 'hls'; this.metrics.strategy = 'hls'; this.hasMetadata = false; this.lastProgress = Date.now();
        this._setState(STATES.PREPARING_PLAYER, { fallback: true }); this._log('Native HLS fallback');
        this._armDeadline('start', session, this.requestId); this.adapter.load(this.stream, session, 'hls'); return true;
      }
      /* hls.js offers one decoder-specific recovery. Further media errors use the
         same bounded RecoveryManager as every other source. */
      if (error.code === 'CODEC_ERROR' && this.engine === 'hls' && !this.mediaRecovered && this.adapter && this.adapter.recoverMedia) {
        this.mediaRecovered = true; this._setState(STATES.BUFFERING, { mediaRecovery: true }); this.adapter.recoverMedia(session); return true;
      }
      this._log('Playback failure', { code: error.code, status: error.status || '', retryable: error.retryable });
      return this.recovery.recover(session, error);
    },
    mediaEvent: function (name, detail) {
      if (!this.current || this.state === STATES.STOPPING) return;
      detail = detail || {}; var now = Date.now(), recovered;
      this.metrics.event(name);
      if (detail.networkState != null) this.metrics.networkState = Number(detail.networkState) || 0;
      if (name === 'loadstart') { this.metrics.loadStartedAt = this.metrics.loadStartedAt || now; this._setState(STATES.LOADING, {}); this._log('Load started'); return; }
      if (name === 'waiting' || name === 'stalled') { if (!this.userPaused && this.state !== STATES.RETRYING) this.buffer.wait(); return; }
      if (name === 'loadedmetadata' || name === 'loadeddata' || name === 'durationchange') {
        recovered = this._bufferProgressed(now); this.hasMetadata = true; this.lastProgress = now; this.metrics.metadataLoadedAt = this.metrics.metadataLoadedAt || now;
        this._setState(STATES.LOADING, { metadata: true, recovered: recovered }); this._log(name); return;
      }
      if (name === 'canplay' || name === 'canplaythrough') {
        recovered = this._bufferProgressed(now); this.lastProgress = now; this.metrics.canPlayAt = this.metrics.canPlayAt || now;
        if (this.state !== STATES.PLAYING) this._setState(STATES.CAN_PLAY, { recovered: recovered }); this._log(name); return;
      }
      if (name === 'playing') {
        this._clearDeadline('start'); this._bufferProgressed(now); this.lastProgress = now; this.lastCurrentTime = Number(detail.currentTime) || this.lastCurrentTime; this.lastCurrentTimeAt = now;
        this.metrics.lastCurrentTime = this.lastCurrentTime; this.metrics.lastCurrentTimeAt = now; this.metrics.playingAt = this.metrics.playingAt || now;
        this.circuit.success(this._circuitKey());
        this.metrics.startupDuration = Math.max(0, this.metrics.playingAt - this.metrics.startupStartedAt);
        this.metrics.timeToFirstFrame = this.metrics.startupDuration; this.metrics.channelSwitchDuration = this.metrics.startupDuration;
        this._setState(STATES.PLAYING, { startupMs: this.metrics.startupDuration }); this._log('Playing', { startupMs: this.metrics.startupDuration, retry: this.recovery.attempt }); return;
      }
      if (name === 'timeupdate') {
        if (detail.progressed !== false) {
          this._clearDeadline('start'); recovered = this._bufferProgressed(now); this.lastProgress = now; this.lastCurrentTime = Number(detail.currentTime) || 0; this.lastCurrentTimeAt = now;
          this.metrics.lastCurrentTime = this.lastCurrentTime; this.metrics.lastCurrentTimeAt = now;
          if (!this.metrics.playingAt) { this.metrics.playingAt = now; this.metrics.startupDuration = Math.max(0, now - this.metrics.startupStartedAt); this.metrics.timeToFirstFrame = this.metrics.startupDuration; this.metrics.channelSwitchDuration = this.metrics.startupDuration; }
          if (this.state !== STATES.PLAYING && this.state !== STATES.RETRYING) this._setState(STATES.PLAYING, { recovered: recovered, progressSignal: true });
        }
        return;
      }
      if (name === 'progress') { if (detail.progressed !== false) this.lastProgress = now; return; }
      if (name === 'pause') { if (this.userPaused) this._setState(STATES.PAUSED, {}); return; }
      if (name === 'ended') { this._clearDeadline('start'); this._setState(STATES.STOPPED, { ended: true }); return; }
      /* suspend is informational on webOS; abort only becomes an error when it
         belongs to the active session and was not caused by our own cleanup. */
      if (name === 'abort') this.fail({ code: 'PLAYER_ERROR', phase: 'player', message: 'Media loading was aborted' }, this.sessionId);
    },
    hlsManifest: function (detail, session) {
      if (!this.isCurrent(session)) return;
      this.metrics.hls(detail || {}); this._log('HLS manifest parsed', { videoVariants: this.metrics.videoVariants, audioOnlyVariants: this.metrics.audioOnlyVariants });
    },
    inspection: function (detail, session) { if (this.isCurrent(session)) this.metrics.inspected(detail || {}); },
    mediaError: function (detail) { return this.fail(detail || {}, this.sessionId); },
    setUserPaused: function (paused) { this.userPaused = !!paused; if (this.userPaused) this.buffer.progressed(); },
    _retry: function (session, attempt, error) {
      if (!this.isCurrent(session)) return;
      var snapshot = this.adapter && this.adapter.snapshot ? this.adapter.snapshot() : {}, item = this.current, now = Date.now();
      var resumeAt = item && item.type !== 'live' && item.type !== 'catchup' && snapshot && Number(snapshot.currentTime) > 5 ? Number(snapshot.currentTime) : 0;
      error = error || this.lastError || {}; attempt = Number(attempt || this.recovery.attempt);
      /* Adaptive recovery ladder: a stall gets one decoder-level nudge first;
         transient transport failures reload the already fingerprinted source once;
         later attempts re-resolve so expiring provider URLs can rotate. */
      if (error.code === 'NETWORK_ERROR' && attempt === 1 && this.adapter && this.adapter.recoverBuffer && this.adapter.recoverBuffer(session)) {
        this.lastProgress = now; this.lastCurrentTimeAt = now; this.buffer.reset(now); this._setState(STATES.BUFFERING, { recoveryLevel: 'buffer' }); this._log('Adaptive buffer recovery'); return;
      }
      if ((error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT_ERROR') && attempt === 1 && this.stream && this.adapter && this.adapter.reload) {
        this._abort(); this.abortController = makeAbortController(); this.lastProgress = now; this.lastCurrentTimeAt = now; this.hasMetadata = false; this.sameSourceReloadTried = true; this.buffer.reset(now);
        this._setState(STATES.PREPARING_PLAYER, { recoveryLevel: 'reinitialize', sourceChanged: false, attempt: attempt }); this._log('Player reinitialized', { sourceChanged: false }); this._armDeadline('start', session, this.requestId); this.adapter.reload(this.stream, session, this.engine); return;
      }
      this._abort(); this._clear(); this.abortController = makeAbortController(); this.startedAt = now; this.lastProgress = now; this.lastCurrentTimeAt = now; this.hasMetadata = false; this.buffer.reset(now);
      /* Final bounded attempt refreshes a Stalker session before a fresh link;
         other providers simply re-resolve, without inventing credentials. */
      if (attempt >= 3 && (this.providerType || this.options && this.options.provider) === 'stalker') {
        var self = this;
        Promise.resolve(this.refreshSession('stalker', { signal: this.abortController.signal })).then(function () { if (self.isCurrent(session)) self._open(session, false, resumeAt); }, function (refreshError) { if (self.isCurrent(session)) self.fail(refreshError, session); });
      } else this._open(session, false, resumeAt);
    },
    retryNow: function () {
      if (!this.current) return false;
      if (this.recovery.retryNow(this.sessionId)) return true;
      /* Manual retry is a new session, invalidating any failed resolver promise. */
      this.play(this.current, this.options || {}); return true;
    },
    networkLost: function () {
      if (!this.current || this.state === STATES.ERROR || this.state === STATES.STOPPING) return;
      this.networkOffline = true; this.buffer.progressed(); this._setState(STATES.BUFFERING, { networkLost: true }); this._log('Network connection lost');
    },
    online: function () { this.networkOffline = false; this.recovery.retryNow(this.sessionId); },
    _watchdog: function () {
      if (!this.current || this.userPaused || this.state === STATES.RETRYING || this.state === STATES.ERROR || this.recovery.pending()) return;
      var snap = this.adapter && this.adapter.snapshot ? this.adapter.snapshot() : {}, now = Date.now(), currentTime = Number(snap.currentTime) || 0;
      if (snap.ended || (snap.paused && Number(snap.readyState) >= 3)) return;
      /* Independent health check: growing buffered ranges or a stale playing event
         do not count as healthy playback. The decoded media clock must advance. */
      if (currentTime > this.lastCurrentTime + 0.05) {
        this.lastCurrentTime = currentTime; this.lastCurrentTimeAt = now; this.metrics.lastCurrentTime = currentTime; this.metrics.lastCurrentTimeAt = now;
      }
      var limit = this.current.type === 'live' ? 12000 : this.hasMetadata ? 30000 : 60000;
      if ((this.state === STATES.PLAYING || this.state === STATES.BUFFERING) && now - this.lastCurrentTimeAt > limit) this.fail({ code: 'BUFFER_ERROR', message: 'Playback media clock stalled' }, this.sessionId);
      else if (now - this.lastProgress > limit && Number(snap.readyState || 0) < 3) this.fail({ code: 'BUFFER_ERROR', message: 'Playback loading stalled' }, this.sessionId);
      else if (!this.hasMetadata && this.current.type !== 'live' && now - this.startedAt >= 6000 && this.state === STATES.LOADING) this._setState(STATES.LOADING, { elapsed: Math.round((now - this.startedAt) / 1000) });
    },
    stop: function (clearCurrent) {
      this.sessionId++; this.requestId++; this._setState(STATES.STOPPING, {}); this._abort(); this._clearDeadlines(); this.recovery.cancel(); this.buffer.reset(0); this._clear();
      if (clearCurrent !== false) { this.current = null; this.stream = null; this.options = null; }
      this._setState(STATES.STOPPED, {});
    },
    destroy: function () { this.stop(); if (this.watchdogTimer) clearInterval(this.watchdogTimer); this.watchdogTimer = null; }
  };
  Manager.STATES = STATES; return Manager;
})();
