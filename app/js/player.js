/* RGBTv — HTML5/webOS player adapter. Playback lifecycle, source resolution,
 * session invalidation and recovery belong to PlaybackManager (not the UI). */
var Player = (function () {
  var video, hls = null, manager = null, osdTimer = null, current = null, playlist = [], index = -1, ratioMode = 0, RATIOS = ['Fit', 'Fill', 'Stretch'], lastLive = null, lastLiveAccount = null;
  var onEnded = null, canPlay = null, posKey = null, posTimer = null, seekAccum = 0, seekTimer = null, numBuf = '', numTimer = null, zapOpen = false, trackMenuOpen = false, trackMenuKind = '', trackReturnEl = null;
  var els = {}, lastTime = -1, lastBufferEnd = -1;
  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M7 4v16l14-8z"/></svg>', ICON_PAUSE = '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor"><path d="M6 5h4v14h-4z"/></svg>';
  function T(k, v) { return I18n.t(k, v); }
  function redactStreamUrl(url) {
    return String(url || '').replace(/\/\/[^@/]+@/, '//').replace(/\/(live|movie|series)\/[^/?#]+\/[^/?#]+(?=\/)/i, '/$1/[redacted]/[redacted]').replace(/([?&](?:token|auth|authorization|username|user|password|pass|key|signature|sig)=[^&#]*)/gi, function (match) { return match.replace(/=[^&]*/, '=[redacted]'); }).replace(/^https?:\/\//, '');
  }

  function loading(on, txt) { els['player-loading'].classList.toggle('show', !!on); if (txt) els['player-loading-text'].textContent = txt; }
  function transition(on, item) {
    var box = els['player-transition']; if (!box) return;
    box.classList.toggle('show', !!on);
    if (on && els['player-transition-title']) els['player-transition-title'].textContent = item && (item.title || item.name) || '';
  }
  function error(msg) {
    els['player-error'].classList.toggle('show', !!msg);
    if (msg) (els['player-error-text'] || els['player-error']).textContent = msg;
    if (els['player-retry']) els['player-retry'].style.display = msg ? '' : 'none';
    if (els['player-error-prev']) els['player-error-prev'].style.display = msg && current && current.type === 'live' && playlist.length > 1 ? '' : 'none';
    if (els['player-error-next']) els['player-error-next'].style.display = msg && current && current.type === 'live' && playlist.length > 1 ? '' : 'none';
    if (els['player-error-back']) els['player-error-back'].style.display = msg ? '' : 'none';
  }
  function playbackUi(state, detail) {
    detail = detail || {};
    if (state === PlaybackManager.STATES.RESOLVING_STREAM || state === PlaybackManager.STATES.STREAM_RESOLVED || state === PlaybackManager.STATES.PREPARING_PLAYER || state === PlaybackManager.STATES.LOADING) {
      if (detail.fallback || detail.recoveryLevel) transition(true, current);
      error(null); loading(true, detail.fallback ? T('p.engineFallback') : detail.resolving ? T('connecting') : detail.elapsed ? T('opening', { s: detail.elapsed }) : T('loading'));
    } else if (state === PlaybackManager.STATES.CAN_PLAY || state === PlaybackManager.STATES.PLAYING) {
      loading(false); error(null); if (state === PlaybackManager.STATES.PLAYING) { transition(false); els['osd-play'].innerHTML = ICON_PAUSE; }
    } else if (state === PlaybackManager.STATES.PAUSED) {
      loading(false); error(null); els['osd-play'].innerHTML = ICON_PLAY;
    } else if (state === PlaybackManager.STATES.BUFFERING) {
      loading(true, detail.networkLost ? T('p.networkLost') : T('buffering'));
    } else if (state === PlaybackManager.STATES.RETRYING) {
      transition(true, current); error(null); loading(true, T('reconnecting', { n: detail.attempt, max: detail.max }));
      if (detail.attempt > 1) UI.toast(T('p.interrupted', { n: detail.attempt, max: detail.max }), 2500, '↻');
    } else if (state === PlaybackManager.STATES.ERROR) {
      transition(false); loading(false); error((detail.error && detail.error.message) || T('p.error'));
    } else if (state === PlaybackManager.STATES.IDLE || state === PlaybackManager.STATES.STOPPED) {
      transition(false); loading(false);
    }
  }
  function destroyHls() { if (hls) { try { hls.destroy(); } catch (e) { } hls = null; } }
  function clearSource() {
    destroyHls();
    try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) { }
  }
  function requiresScriptTransport(stream) {
    var headers = stream && stream.headers || {}, key;
    /* Native HTMLVideoElement cannot attach bearer/cookie headers. When a portal
       explicitly made them part of a resolved HLS source, use the one adapter
       that can attempt permitted headers rather than silently dropping them. */
    for (key in headers) if (Object.prototype.hasOwnProperty.call(headers, key) && /^(authorization|cookie)$/i.test(key) && headers[key]) return true;
    return false;
  }
  function hlsHeaderSetup(headers) {
    var safe = {}, key, value, has = false;
    for (key in headers || {}) if (Object.prototype.hasOwnProperty.call(headers, key)) {
      value = String(headers[key] || '');
      if (value && value.length <= 2048 && !/[\r\n]/.test(value)) { safe[key] = value; has = true; }
    }
    if (!has) return null;
    return function (xhr) {
      for (key in safe) if (Object.prototype.hasOwnProperty.call(safe, key)) {
        /* Some headers are forbidden by browser XHR. Try permitted IPTV headers
           without blocking the direct source assignment on webOS. */
        try { xhr.setRequestHeader(key, safe[key]); } catch (e) { }
      }
    };
  }
  function startHls(stream, session) {
    destroyHls();
    var cfg = {
      /* Recovery is centralized in PlaybackRecoveryManager. hls.js may report
         a fatal error, but it never owns a second reconnect loop. */
      maxBufferLength: 18, maxMaxBufferLength: 30, liveSyncDurationCount: 3, enableWorker: false,
      fragLoadingTimeOut: 20000, manifestLoadingTimeOut: 10000,
      manifestLoadingMaxRetry: 0, levelLoadingMaxRetry: 0, fragLoadingMaxRetry: 0
    }, setup = hlsHeaderSetup(stream.headers), instance, manifestHint = null;
    if (setup) cfg.xhrSetup = setup;
    /* Cookie-bearing requests need the browser credential mode too. The server
       must still opt in through CORS; a failure becomes a classified diagnostic,
       never a false PLAYING state. */
    if (stream.cookies) cfg.xhrSetup = (function (previous) { return function (xhr) { try { xhr.withCredentials = true; } catch (e) { } if (previous) previous(xhr); }; })(cfg.xhrSetup);
    instance = new Hls(cfg); hls = instance; instance._rgbSession = session;
    instance.loadSource(stream.url); instance.attachMedia(video);
    if (Hls.Events.MANIFEST_LOADED) instance.on(Hls.Events.MANIFEST_LOADED, function (event, data) {
      if (hls !== instance || !manager.isCurrent(session)) return;
      var body = data && data.networkDetails && (data.networkDetails.responseText || data.networkDetails.response || '') || '';
      manifestHint = StreamInspector.hlsSummary([], data && data.audioTracks || [], body);
    });
    if (Hls.Events.AUDIO_TRACKS_UPDATED) instance.on(Hls.Events.AUDIO_TRACKS_UPDATED, function () { if (hls === instance && manager.isCurrent(session)) applyHlsTrackPreferences(); });
    if (Hls.Events.SUBTITLE_TRACKS_UPDATED) instance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, function () { if (hls === instance && manager.isCurrent(session)) applyHlsTrackPreferences(); });
    instance.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
      if (hls !== instance || !manager.isCurrent(session)) return;
      /* hls.js has parsed the actual master playlist. On mixed video/audio-only
         masters, pin the first visual level for startup so old webOS decoders do
         not receive an audio-only rendition as their initial video selection. */
      var summary = StreamInspector.hlsSummary(data && data.levels || instance.levels || [], data && data.audioTracks || instance.audioTracks || []);
      if (manifestHint) { summary.extXMedia = summary.extXMedia || manifestHint.extXMedia; summary.extXMediaVideo = summary.extXMediaVideo || manifestHint.extXMediaVideo; summary.nativeCompatibilityWarning = summary.nativeCompatibilityWarning || manifestHint.nativeCompatibilityWarning; }
      if (summary.mixedAudioOnly && summary.selectableVideoLevel >= 0) {
        try { instance.startLevel = summary.selectableVideoLevel; instance.nextAutoLevel = summary.selectableVideoLevel; } catch (levelError) { }
      }
      manager.hlsManifest(summary, session); applyHlsTrackPreferences();
      video.play().catch(function (e) { if (hls === instance && manager.isCurrent(session)) manager.mediaError({ code: 'PLAYER_ERROR', phase: 'player', message: e && e.message || 'Unable to start HLS playback' }); });
      setTimeout(function () { if (hls === instance && manager.isCurrent(session)) updateQualityBadge(); }, 1000);
    });
    instance.on(Hls.Events.ERROR, function (ev, data) {
      if (!data || !data.fatal || hls !== instance || !manager.isCurrent(session)) return;
      manager.mediaError({ hls: true, type: data.type, details: data.details, response: data.response, message: 'HLS ' + (data.details || data.type || 'error') });
    });
  }
  function canUseHls() { return !!(window.Hls && Hls.isSupported && Hls.isSupported()); }
  function canPlayDash() { try { return !!(video && video.canPlayType && video.canPlayType('application/dash+xml')); } catch (e) { return false; } }
  function developerDiagnosticsEnabled() {
    try { return !!(window.RGBTvDebug || (Store.settings && Store.settings().developerDiagnostics)); } catch (e) { return false; }
  }
  function inspectSource(stream, force) {
    /* Opt-in, bounded Range observation only. It is deliberately not part of the
       source-resolution critical path and therefore cannot create slow starts or
       a second media request for normal viewers. */
    if (!(force || developerDiagnosticsEnabled()) || !U.inspectStream) return null;
    return U.inspectStream(stream.url, stream.headers || {}, { timeout: 12000, maxBytes: 4096 }).then(function (detail) {
      return detail || null;
    });
  }
  function mediaSnapshot() {
    var end = 0;
    try { end = video.buffered && video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0; } catch (e) { }
    return { paused: !!video.paused, ended: !!video.ended, readyState: Number(video.readyState) || 0, currentTime: Number(video.currentTime) || 0, bufferedEnd: end };
  }
  function mediaBelongsToCurrentSession() {
    if (!manager || !manager.current || !manager.stream) return false;
    /* hls.js owns a MediaSource URL, while direct native playback exposes the
       assigned source. Ignore a late native event if the element still reports
       a previous channel URL after a rapid zap. */
    if (hls) return hls._rgbSession === manager.currentSession();
    var expected = String(manager.stream.url || ''), actual = String(video.currentSrc || video.src || '');
    return !actual || !expected || actual === expected;
  }
  function recoverHlsMedia(session) { if (hls && hls._rgbSession === session) { try { hls.recoverMediaError(); } catch (e) { manager.mediaError({ hls: true, type: 'mediaError', message: e.message || 'Media recovery failed' }); } } }
  function recoverBuffer(session) {
    if (!hls || hls._rgbSession !== session || !hls.startLoad) return false;
    try { hls.startLoad(-1); return true; } catch (e) { return false; }
  }
  function reloadSource(stream, session, engine) { if (!manager.isCurrent(session)) return false; loadSource(stream, session, engine); return true; }
  function loadSource(stream, session, forcedEngine) {
    if (!manager.isCurrent(session)) return;
    var setting = Store.settings().engine, nativeHls = false, useHls, requiresHeaders = requiresScriptTransport(stream);
    try { nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl'); } catch (e) { }
    /* Native webOS media remains the first HLS strategy when it can play the
       playlist. HLS.js is selected only for an actual missing native capability,
       an explicit diagnostics setting, a controlled native fallback, or a stream
       whose bearer/cookie headers cannot be attached by HTMLVideoElement. */
    useHls = stream.type === 'hls' && canUseHls() && (forcedEngine === 'hls' || setting === 'hlsjs' || (setting === 'auto' && (!nativeHls || requiresHeaders)));
    current.url = stream.url; current.streamHeaders = stream.headers || {};
    if (useHls) { startHls(stream, session); return; }
    destroyHls();
    /* This is the webOS adapter's direct handoff: preserve the exact provider URL
       and let the hardware-backed HTML5 media pipeline open it immediately. */
    try {
      video.src = stream.url; video.load();
      video.play().catch(function (e) { if (manager.isCurrent(session)) manager.mediaError({ code: 'PLAYER_ERROR', phase: 'player', message: e && e.message || 'Unable to start native playback' }); });
    } catch (e2) { manager.mediaError({ code: 'PLAYER_ERROR', phase: 'player', message: e2.message || 'Unable to assign media source' }); }
  }
  function sourceResolved(stream, session, context) {
    if (!manager.isCurrent(session) || !current) return;
    current.url = stream.url; current.streamHeaders = stream.headers || {};
    if (context.resumeAt) {
      var once = function () { video.removeEventListener('loadedmetadata', once); if (manager.isCurrent(session)) { try { video.currentTime = context.resumeAt; } catch (e) { } } };
      video.addEventListener('loadedmetadata', once);
    } else if (context.initial && manager.options && manager.options.resume && posKey) {
      var saved = Store.getPos(App.account.id, posKey);
      if (saved && saved.pos > 10) {
        var resume = function () { video.removeEventListener('loadedmetadata', resume); if (manager.isCurrent(session)) { try { video.currentTime = saved.pos; } catch (e) { } } };
        video.addEventListener('loadedmetadata', resume);
      }
    }
    if (context.initial) {
      if (posKey) { clearInterval(posTimer); posTimer = setInterval(savePos, 5000); }
      if (current.type !== 'catchup') Store.pushHistory(App.account.id, { type: current.type, id: current.id, name: current.name, logo: current.logo, poster: current.poster, seriesId: current.seriesId, ext: current.ext, cmd: current.cmd, url: current.type === 'm3u' ? stream.url : undefined, catId: current.catId, season: current.season, episode: current.episode });
    }
  }

  function init() {
    video = U.$('#video'); try { video.preload = 'auto'; } catch (e) { }
    ['osd', 'osd-title', 'osd-sub', 'osd-logo', 'osd-clock', 'osd-played', 'osd-buffer', 'osd-cur', 'osd-dur', 'osd-play', 'player-transition', 'player-transition-title', 'player-loading', 'player-loading-text', 'player-error', 'player-error-text', 'player-retry', 'player-error-prev', 'player-error-next', 'player-error-back', 'zap-list', 'channel-number', 'track-menu', 'osd-fav', 'osd-ratio', 'osd-list-btn', 'osd-audio', 'osd-subs', 'osd-quality', 'osd-picture', 'picture-fx', 'stats-box', 'zap-preview', 'osd-stats', 'osd-epg', 'autonext', 'an-bar', 'an-count', 'an-title'].forEach(function (id) { els[id] = document.getElementById(id); });
    var savedRatio = Store.settings().aspectRatio; ratioMode = ['fit', 'fill', 'stretch'].indexOf(savedRatio); if (ratioMode < 0) ratioMode = 0; applyRatio(); updateTrackControls();
    manager = new PlaybackManager({
      resolve: function (item, opt) { return StreamResolver.resolve(App.provider, item, opt); },
      refreshSession: function (provider, opt) { return App.provider && App.provider.type === provider && App.provider.refreshSession ? App.provider.refreshSession(opt) : Promise.resolve(false); },
      adapter: { clear: clearSource, load: loadSource, reload: reloadSource, snapshot: mediaSnapshot, canUseHls: canUseHls, canPlayDash: canPlayDash, recoverMedia: recoverHlsMedia, recoverBuffer: recoverBuffer, inspect: inspectSource },
      onState: playbackUi,
      onSource: sourceResolved,
      onError: function () { /* state renderer supplies the bounded retry result */ }
    });
    /* Buffer state belongs to the central SmartBufferManager. The adapter only
       forwards real media events and current networkState when webOS exposes it. */
    function mediaDetail(extra) { extra = extra || {}; extra.networkState = video.networkState; extra.currentTime = Number(video.currentTime) || 0; return extra; }
    video.addEventListener('loadstart', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('loadstart', mediaDetail()); });
    video.addEventListener('waiting', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('waiting', mediaDetail()); });
    video.addEventListener('stalled', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('stalled', mediaDetail()); });
    video.addEventListener('loadedmetadata', function () { if (!mediaBelongsToCurrentSession()) return; applyNativeTrackPreference(); updateQualityBadge(); manager.mediaEvent('loadedmetadata', mediaDetail()); });
    video.addEventListener('loadeddata', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('loadeddata', mediaDetail()); });
    video.addEventListener('canplay', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('canplay', mediaDetail()); });
    video.addEventListener('canplaythrough', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('canplaythrough', mediaDetail()); });
    video.addEventListener('durationchange', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('durationchange', mediaDetail()); });
    video.addEventListener('playing', function () { if (!mediaBelongsToCurrentSession()) return; manager.mediaEvent('playing', mediaDetail()); els['osd-play'].innerHTML = ICON_PAUSE; });
    video.addEventListener('pause', function () { els['osd-play'].innerHTML = ICON_PLAY; if (mediaBelongsToCurrentSession()) manager.mediaEvent('pause', mediaDetail()); });
    video.addEventListener('suspend', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('suspend', mediaDetail()); });
    video.addEventListener('emptied', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('emptied', mediaDetail()); });
    video.addEventListener('abort', function () { if (mediaBelongsToCurrentSession()) manager.mediaEvent('abort', mediaDetail()); });
    video.addEventListener('timeupdate', function () {
      if (!mediaBelongsToCurrentSession()) return;
      var advanced = video.currentTime !== lastTime; if (advanced) lastTime = video.currentTime;
      manager.mediaEvent('timeupdate', mediaDetail({ progressed: advanced })); updateProgress();
    });
    video.addEventListener('progress', function () {
      if (!mediaBelongsToCurrentSession()) return;
      var snap = mediaSnapshot(), advanced = snap.bufferedEnd !== lastBufferEnd; if (advanced) lastBufferEnd = snap.bufferedEnd;
      manager.mediaEvent('progress', mediaDetail({ progressed: advanced })); updateProgress();
    });
    video.addEventListener('resize', updateQualityBadge);
    video.addEventListener('ended', function () { if (!mediaBelongsToCurrentSession()) return; manager.mediaEvent('ended'); if (onEnded) onEnded(); });
    video.addEventListener('error', function () {
      /* HLS errors are emitted by its adapter callback. Native errors are classified
         centrally, including the one HLS engine fallback and terminal formats. */
      if (!hls && mediaBelongsToCurrentSession()) manager.mediaError({ nativeCode: video.error && video.error.code, message: T('p.error') });
    });
    window.addEventListener('offline', function () { if (manager) manager.networkLost(); });
    window.addEventListener('online', function () { if (manager) manager.online(); });
    setInterval(function () { if (els['osd-clock']) els['osd-clock'].textContent = U.clock(); }, 1000);
  }

  function trackCapabilities() {
    var audio = 0, subs = 0;
    try { audio = (hls && hls.audioTracks ? hls.audioTracks.length : 0) || (video.audioTracks ? video.audioTracks.length : 0); subs = (hls && hls.subtitleTracks ? hls.subtitleTracks.length : 0) || (video.textTracks ? video.textTracks.length : 0); } catch (e) { }
    return { audio: audio, subtitles: subs };
  }
  function updateTrackControls() {
    var tracks = trackCapabilities();
    if (els['osd-audio']) els['osd-audio'].style.display = tracks.audio > 1 ? '' : 'none';
    if (els['osd-subs']) els['osd-subs'].style.display = tracks.subtitles ? '' : 'none';
  }
  function capabilities() {
    var can = function (mime) { try { return !!(video && video.canPlayType && video.canPlayType(mime)); } catch (e) { return false; } }, tracks = trackCapabilities();
    return { nativeHls: can('application/vnd.apple.mpegurl'), mp4: can('video/mp4'), mpegts: can('video/mp2t'), dash: can('application/dash+xml'), hlsjs: canUseHls(), audioTracks: tracks.audio > 1, subtitleTracks: tracks.subtitles > 0, fullscreen: !!(video && (video.requestFullscreen || video.webkitRequestFullscreen)) };
  }
  /* Resolution badge in OSD (4K / FHD / HD / SD) from the decoded video size */
  function updateQualityBadge() {
    var w = video.videoWidth, h = video.videoHeight, el = els['osd-quality']; updateTrackControls(); if (!el) return;
    var b = [], nm = current ? String((current.title || '') + ' ' + (current.subtitle || '') + ' ' + (current.name || '')) : '';
    if (w && h) { var uhd = (w >= 3800 || h >= 2100); b.push('<span class="osd-badge' + (uhd ? ' uhd' : '') + '">' + (uhd ? '4K UHD' : (h >= 1000 || w >= 1900) ? 'FHD' : (h >= 700 || w >= 1200) ? 'HD' : 'SD') + '</span>'); b.push('<span class="osd-badge">' + w + '×' + h + '</span>'); }
    else if (/\b(4k|uhd|2160p)\b/i.test(nm)) b.push('<span class="osd-badge uhd">4K</span>');
    if (/\b(hdr|dolby ?vision)\b/i.test(nm)) b.push('<span class="osd-badge hdr">HDR</span>');
    var subs = 0, auds = 0; try { subs = (hls && hls.subtitleTracks ? hls.subtitleTracks.length : 0) || (video.textTracks ? video.textTracks.length : 0); auds = (hls && hls.audioTracks ? hls.audioTracks.length : 0) || (video.audioTracks ? video.audioTracks.length : 0); } catch (e) { }
    if (subs) b.push('<span class="osd-badge">CC ' + subs + '</span>'); if (auds > 1) b.push('<span class="osd-badge">♪ ' + auds + '</span>');
    if (!b.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
    el.className = 'osd-badges'; el.innerHTML = b.join(''); el.style.display = '';
  }

  /* play(item, {list, index, url, resume}) */
  function play(item, opt) {
    opt = opt || {};
    /* Save the old VOD position before the manager clears the stable element. */
    savePos(); clearInterval(posTimer);
    if (current && current.type === 'live' && item && item.type === 'live' && String(current.id) !== String(item.id)) { lastLive = current; lastLiveAccount = App.account && App.account.id; }
    current = item; applyPictureMode();
    if (opt.list) { playlist = opt.list; index = opt.index != null ? opt.index : playlist.indexOf(item); }
    transition(true, item); error(null); loading(true, T('loading'));
    els['osd-title'].textContent = item.title || item.name || '';
    els['osd-sub'].textContent = item.subtitle || ''; if (els['osd-quality']) { els['osd-quality'].innerHTML = ''; els['osd-quality'].style.display = 'none'; }
    els['osd-epg'].classList.remove('show'); els['osd-epg'].innerHTML = ''; hideAutoNext();
    els['osd-logo'].style.backgroundImage = item.logo ? 'url("' + item.logo + '")' : 'none';
    els['osd-list-btn'].style.display = item.type === 'live' ? '' : 'none';
    updateFavBtn();
    var isLive = item.type === 'live';
    U.$('.osd-progress').style.visibility = isLive ? 'hidden' : 'visible';
    U.$('.osd-times').style.visibility = isLive ? 'hidden' : 'visible';
    posKey = (isLive || item.type === 'catchup') ? null : (item.type + ':' + item.id);
    showOsd(); lastTime = -1; lastBufferEnd = -1;
    if (!opt.provider && App.provider) opt.provider = App.provider.type;
    return manager.play(item, opt);
  }
  function stop(clearCurrent) {
    savePos(); clearInterval(posTimer);
    if (manager) manager.stop(clearCurrent);
    if (clearCurrent !== false) current = null;
    transition(false); loading(false);
  }
  function togglePlay() {
    if (manager && manager.state === PlaybackManager.STATES.ERROR && current) { error(null); loading(true, T('retrying')); manager.retryNow(); return; }
    if (video.paused) resume();
    else pause();
    showOsd();
  }

  function savePos() { if (posKey && video.duration && !isNaN(video.duration)) Store.setPos(App.account.id, posKey, video.currentTime, video.duration); }
  function seek(delta) {
    if (!current || current.type === 'live' || !isFinite(video.duration)) return;
    seekAccum += delta; showOsd();
    var target = U.clamp(video.currentTime + seekAccum, 0, video.duration - 1);
    els['osd-cur'].textContent = U.fmtTime(target) + (seekAccum ? ' (' + (seekAccum > 0 ? '+' : '') + seekAccum + 's)' : '');
    els['osd-played'].style.width = (target / video.duration * 100) + '%';
    clearTimeout(seekTimer); seekTimer = setTimeout(function () { video.currentTime = target; seekAccum = 0; }, 500);
  }
  function updateProgress() {
    if (!video.duration || !isFinite(video.duration)) return;
    if (!seekAccum) { els['osd-cur'].textContent = U.fmtTime(video.currentTime); els['osd-played'].style.width = (video.currentTime / video.duration * 100) + '%'; }
    els['osd-dur'].innerHTML = U.fmtTime(video.duration) + '<span class="osd-rem">−' + U.fmtTime(Math.max(0, video.duration - video.currentTime)) + '</span>';
    try { if (video.buffered.length) els['osd-buffer'].style.width = (video.buffered.end(video.buffered.length - 1) / video.duration * 100) + '%'; } catch (e) { }
  }
  function showOsd(persist) {
    els.osd.classList.add('show'); clearTimeout(osdTimer);
    if (!persist) osdTimer = setTimeout(hideOsd, 5000);
    if (current && current.type === 'live') fillMiniEpg();
  }
  /* mini EPG inside the OSD (live): NOW with progress + NEXT */
  var epgCache = {};
  function fillMiniEpg() {
    var ch = current, box = els['osd-epg']; if (!ch || !App.provider || !App.provider.shortEPG) return;
    var paint = function (list) {
      if (current !== ch) return; var now = Date.now() / 1000, cur = null, nxt = null;
      list.forEach(function (e) { if (e.start <= now && e.end > now) cur = e; else if (e.start > now && !nxt) nxt = e; });
      if (!cur && !nxt) { box.classList.remove('show'); return; }
      box.innerHTML = '<div class="oe-now"><span class="lbl">' + U.esc(T('nowLbl')) + '</span><span>' + U.esc(cur ? cur.title : '—') + '</span>' + (cur ? '<span class="oe-time">' + U.hm(cur.start) + ' – ' + U.hm(cur.end) + ' · ' + Math.max(0, Math.round((cur.end - now) / 60)) + ' ' + U.esc(T('home.min')) + '</span>' : '') + '</div><div class="oe-bar"><i style="width:' + (cur ? Math.round((now - cur.start) / (cur.end - cur.start) * 100) : 0) + '%"></i></div><div class="oe-next"><span class="lbl">' + U.esc(T('next')) + '</span>' + (nxt ? U.hm(nxt.start) + '  ' + U.esc(nxt.title) : '—') + '</div>';
      box.classList.add('show');
    };
    var c = epgCache[ch.id]; if (c && Date.now() - c.at < 5 * 60000) { paint(c.list); return; }
    App.provider.shortEPG(ch.epgId || ch.id, 4).then(function (list) { epgCache[ch.id] = { at: Date.now(), list: list || [] }; paint(list || []); }).catch(function () { });
  }
  /* auto-play next episode: 10 s circular countdown */
  var an = { timer: null, left: 0, onPlay: null, onCancel: null };
  function autoNext(title, onPlay, onCancel) {
    hideAutoNext(); an.left = 10; an.onPlay = onPlay; an.onCancel = onCancel;
    els['an-title'].textContent = title || ''; els['an-count'].textContent = '10'; els['an-bar'].style.transition = 'none'; els['an-bar'].style.strokeDashoffset = '0';
    els.autonext.classList.add('show'); showOsd(true);
    setTimeout(function () { els['an-bar'].style.transition = 'stroke-dashoffset 10s linear'; els['an-bar'].style.strokeDashoffset = '327'; }, 50);
    an.timer = setInterval(function () { an.left--; els['an-count'].textContent = String(Math.max(0, an.left)); if (an.left <= 0) { var f = an.onPlay; hideAutoNext(); if (f) f(); } }, 1000);
  }
  function hideAutoNext() { clearInterval(an.timer); an.timer = null; if (els.autonext) els.autonext.classList.remove('show'); }
  function autoNextOpen() { return !!an.timer; }
  function hideOsd() { els.osd.classList.remove('show'); if (Nav.current() && Nav.current().getAttribute('data-nav') === 'osd') Nav.blur(); }
  function osdVisible() { return els.osd.classList.contains('show'); }
  function ratioName(i) { return T(['p.fit', 'p.fill', 'p.stretch'][i]); }
  function applyRatio() {
    if (!video) return;
    video.className = ['', 'fill', 'stretch'][ratioMode];
    if (els['osd-ratio']) els['osd-ratio'].textContent = ratioName(ratioMode);
  }
  function cycleRatio() {
    ratioMode = (ratioMode + 1) % 3; Store.setSetting('aspectRatio', ['fit', 'fill', 'stretch'][ratioMode]); applyRatio(); UI.toast(T('p.aspect', { m: ratioName(ratioMode) }));
  }
  function updateFavBtn() { if (!current) return; els['osd-fav'].textContent = Store.isFav(App.account.id, current.type === 'episode' ? 'series' : current.type, current.type === 'episode' ? current.seriesId : current.id) ? '★' : '☆'; }

  /* ---- channel zapping ---- */
  /* Keep the application-level parental gate for all player-originated changes. */
  function permit(item, done) {
    if (!canPlay) { done(); return; }
    var allowed;
    try { allowed = canPlay(item); } catch (e) { return; }
    if (allowed && typeof allowed.then === 'function') allowed.then(function (ok) { if (ok) done(); });
    else if (allowed !== false) done();
  }
  function next() { if (playlist.length && current && current.type === 'live') zapTo(index + 1); else if (playlist.length) playIndex(index + 1); }
  function prev() { if (playlist.length && current && current.type === 'live') zapTo(index - 1); else if (playlist.length) playIndex(index - 1); }
  function recall() {
    if (!current || current.type !== 'live' || !lastLive || lastLiveAccount !== (App.account && App.account.id) || String(lastLive.id) === String(current.id)) { UI.toast(T('p.noRecall')); return; }
    var previous = lastLive, at = -1;
    playlist.forEach(function (item, i) { if (String(item.id) === String(previous.id)) at = i; });
    permit(previous, function () { if (at >= 0) { index = at; play(UI.toPlayable(playlist[at]), { list: playlist, index: at }); } else play(UI.toPlayable(previous), { list: [previous], index: 0 }); });
  }
  function zapTo(i) { if (!playlist.length) return; i = (i + playlist.length) % playlist.length; playIndex(i); }
  function playIndex(i) {
    if (i < 0 || i >= playlist.length) return;
    var it = playlist[i]; permit(it, function () { index = i; play(UI.toPlayable(it), { list: playlist, index: i }); });
  }
  function numberKey(d) {
    if (!current || current.type !== 'live') return;
    numBuf = (numBuf + d).slice(-4);
    var n = Number(numBuf), idx = -1; playlist.forEach(function (c, i) { if (Number(c.num) === n) idx = i; });
    if (idx < 0 && n >= 1 && n <= playlist.length) idx = n - 1;
    showZapPreview(numBuf, idx >= 0 ? playlist[idx] : null);
    clearTimeout(numTimer); numTimer = setTimeout(function () { commitZap(idx, n); }, 2500);
    zapPending = { idx: idx, n: n };
  }
  var zapPending = null;
  function commitZap(idx, n) {
    clearTimeout(numTimer); numBuf = ''; zapPending = null; els['zap-preview'].classList.remove('show');
    if (idx >= 0) playIndex(idx); else UI.toast(T('p.noChannel', { n: n }));
  }
  function cancelZap() { clearTimeout(numTimer); numBuf = ''; zapPending = null; els['zap-preview'].classList.remove('show'); }
  function showZapPreview(num, ch) {
    var box = els['zap-preview'];
    if (!ch) { box.innerHTML = '<div class="zp-num">' + num + '</div><div class="zp-none">' + U.esc(T('p.noChannel', { n: num })) + '</div>'; box.classList.add('show'); return; }
    box.innerHTML = '<div class="zp-num">' + num + '</div><div class="zp-head"><div class="zp-logo" style="' + (ch.logo ? 'background-image:url(\'' + U.esc(ch.logo) + '\')' : '') + '"></div><div><div class="zp-name">' + U.esc(ch.name) + '</div><div class="zp-cat">' + U.esc(ch.catName || '') + '</div></div></div>' +
      '<div class="zp-now"><span class="lbl">' + U.esc(T('nowLbl')) + '</span><span class="zp-now-t">…</span></div><div class="zp-bar"><i style="width:0"></i></div><div class="zp-next"><span class="lbl">' + U.esc(T('next')) + '</span><span class="zp-next-t">—</span></div><div class="zp-hint">' + U.esc(T('p.zapHint')) + '</div>';
    box.classList.add('show');
    var me = ch;
    App.provider.shortEPG(ch.epgId || ch.id, 3).then(function (list) {
      if (!box.classList.contains('show') || !zapPending || playlist[zapPending.idx] !== me) return;
      var now = Date.now() / 1000, cur = null, nxt = null; list.forEach(function (e) { if (e.start <= now && e.end > now) cur = e; else if (e.start > now && !nxt) nxt = e; });
      U.$('.zp-now-t', box).textContent = cur ? U.hm(cur.start) + ' – ' + U.hm(cur.end) + '  ' + cur.title : (list.length ? '—' : T('noEpg'));
      U.$('.zp-bar i', box).style.width = cur ? Math.round((now - cur.start) / (cur.end - cur.start) * 100) + '%' : '0';
      U.$('.zp-next-t', box).textContent = nxt ? U.hm(nxt.start) + '  ' + nxt.title : '—';
    });
  }
  function toggleZapList() {
    zapOpen = !zapOpen; els['zap-list'].classList.toggle('show', zapOpen);
    if (zapOpen) {
      hideOsd(); var inner = U.el('div', 'zap-inner'); els['zap-list'].innerHTML = '';
      playlist.forEach(function (c, i) {
        var d = U.el('div', 'ch-item focusable' + (i === index ? ' selected' : ''));
        d.setAttribute('data-nav', 'zap'); d.setAttribute('data-i', i);
        d.innerHTML = '<span class="num">' + (c.num || i + 1) + '</span><div class="logo-img" style="background-image:url(\'' + U.esc(c.logo || '') + '\')"></div><div class="info"><div class="name">' + U.esc(c.name) + '</div></div>';
        d.onclick = function () { playIndex(i); toggleZapList(); };
        inner.appendChild(d);
      });
      els['zap-list'].appendChild(inner);
      var target = inner.children[index >= 0 ? index : 0]; if (target) { scrollZap(target); Nav.focus(target); }
    } else Nav.blur();
  }
  function scrollZap(elm) {
    var inner = els['zap-list'].firstChild; if (!inner) return; var i = Number(elm.getAttribute('data-i')), h = 80, viewH = 1080 - 60;
    var off = Math.max(0, i * h - viewH / 2 + h / 2); inner.style.transform = 'translateY(-' + off + 'px)';
  }

  /* ---- audio / subtitle tracks ---- */
  function trackIdentity(track) { return String(track && (track.lang || track.language || track.name || track.label) || '').toLowerCase(); }
  function savedTrack(kind) {
    if (!current || !App.account || !Store.trackPref) return null;
    var pref = Store.trackPref(App.account.id, current); return pref && pref[kind] || null;
  }
  function preferredTrackIndex(kind, tracks) {
    var pref = savedTrack(kind), wanted = pref && pref.key != null ? String(pref.key).toLowerCase() : '', i, fallback = pref && pref.index != null ? Number(pref.index) : NaN;
    if (pref === 'off') return -1;
    for (i = 0; tracks && i < tracks.length; i++) if (wanted && trackIdentity(tracks[i]) === wanted) return i;
    return isFinite(fallback) && fallback >= 0 && tracks && fallback < tracks.length ? fallback : -2;
  }
  function rememberTrack(kind, track, index, off) {
    if (!current || !App.account || !Store.setTrackPref) return;
    Store.setTrackPref(App.account.id, current, kind, off ? 'off' : { key: trackIdentity(track), index: index });
  }
  function applyHlsTrackPreferences() {
    if (!hls || !current) return;
    var audio = preferredTrackIndex('audio', hls.audioTracks), subs = preferredTrackIndex('subs', hls.subtitleTracks);
    if (audio >= 0) hls.audioTrack = audio;
    if (subs >= -1) hls.subtitleTrack = subs;
  }
  function applyNativeTrackPreference() {
    if (!current) return;
    var i, audio = preferredTrackIndex('audio', video.audioTracks), subs = preferredTrackIndex('subs', video.textTracks);
    if (audio >= 0 && video.audioTracks) for (i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = i === audio;
    if (video.textTracks && subs >= -1) for (i = 0; i < video.textTracks.length; i++) video.textTracks[i].mode = subs === -1 ? 'disabled' : i === subs ? 'showing' : 'disabled';
  }
  function openTrackMenu(kind) {
    var menu = els['track-menu'], list = [];
    trackMenuKind = kind;
    trackReturnEl = kind === 'audio' ? els['osd-audio'] : els['osd-subs'];
    menu.classList.remove('picture-menu');
    menu.innerHTML = '<div class="tm-title">' + (kind === 'audio' ? 'Audio tracks' : 'Subtitles') + '</div>';
    if (hls) {
      if (kind === 'audio') hls.audioTracks.forEach(function (t, i) { list.push({ label: t.name || t.lang || T('p.track', { n: i + 1 }), active: hls.audioTrack === i, track: t, index: i, act: function () { hls.audioTrack = i; } }); });
      else { list.push({ label: T('off'), active: hls.subtitleTrack === -1, off: true, act: function () { hls.subtitleTrack = -1; } }); hls.subtitleTracks.forEach(function (t, i) { list.push({ label: t.name || t.lang || T('p.subTrack', { n: i + 1 }), active: hls.subtitleTrack === i, track: t, index: i, act: function () { hls.subtitleTrack = i; } }); }); }
    } else {
      if (kind === 'audio' && video.audioTracks) for (var i = 0; i < video.audioTracks.length; i++) (function (t, i) { list.push({ label: t.label || t.language || T('p.track', { n: i + 1 }), active: t.enabled, track: t, index: i, act: function () { for (var j = 0; j < video.audioTracks.length; j++) video.audioTracks[j].enabled = j === i; } }); })(video.audioTracks[i], i);
      if (kind === 'subs' && video.textTracks) { list.push({ label: T('off'), active: !Array.prototype.some.call(video.textTracks, function (t) { return t.mode === 'showing'; }), off: true, act: function () { for (var j = 0; j < video.textTracks.length; j++) video.textTracks[j].mode = 'disabled'; } }); for (var k = 0; k < video.textTracks.length; k++) (function (t, k) { list.push({ label: t.label || t.language || T('p.subTrack', { n: k + 1 }), active: t.mode === 'showing', track: t, index: k, act: function () { for (var j = 0; j < video.textTracks.length; j++) video.textTracks[j].mode = j === k ? 'showing' : 'disabled'; } }); })(video.textTracks[k], k); }
    }
    if (!list.length) { UI.toast(kind === 'audio' ? 'No alternate audio tracks' : 'No subtitles available'); return; }
    list.forEach(function (t) {
      var d = U.el('div', 'track-item focusable' + (t.active ? ' active' : ''), U.esc(t.label)); d.setAttribute('data-nav', 'track');
      d.onclick = function () { t.act(); rememberTrack(kind, t.track, t.index, t.off); closeTrackMenu(); UI.toast(t.label); }; menu.appendChild(d);
    });
    menu.classList.add('show'); trackMenuOpen = true; showOsd(true); Nav.focusScope('track');
  }
  function closeTrackMenu() {
    var target = trackReturnEl || els['osd-play'];
    els['track-menu'].classList.remove('show');
    els['track-menu'].classList.remove('picture-menu');
    trackMenuOpen = false; trackMenuKind = ''; trackReturnEl = null;
    showOsd(); Nav.focus(target);
  }

  /* Picture controls are local only. Some webOS native video planes bypass CSS
     filters, so every grade is also represented by a visible DOM overlay fallback.
     No TV-wide setting, stream URL, canvas copy or second decoder is ever used. */
  var PICTURE_LIMITS = {
    brightness: { min: 60, max: 140, step: 2, unit: '%' },
    contrast: { min: 60, max: 160, step: 2, unit: '%' },
    saturation: { min: 0, max: 180, step: 2, unit: '%' },
    tone: { min: -30, max: 30, step: 2, unit: '°' },
    blackLevel: { min: -20, max: 20, step: 2, unit: '' },
    gamma: { min: -20, max: 20, step: 2, unit: '' }
  };
  var PICTURE_CONTROLS = ['brightness', 'contrast', 'saturation', 'tone', 'blackLevel', 'gamma'];
  var PICTURE_PRESETS = ['original', 'cinema', 'vivid', 'standard', 'night', 'sports'];
  function pictureValues() {
    var s = Store.settings(), mode = /^(original|cinema|vivid|standard|night|sports|custom)$/.test(s.pictureMode) ? s.pictureMode : 'original';
    return {
      mode: mode,
      brightness: U.clamp(Number(s.pictureBrightness) || 100, 60, 140),
      contrast: U.clamp(Number(s.pictureContrast) || 100, 60, 160),
      saturation: U.clamp(Number(s.pictureSaturation) || 100, 0, 180),
      tone: U.clamp(Number(s.pictureTone) || 0, -30, 30),
      blackLevel: U.clamp(Number(s.pictureBlackLevel) || 0, -20, 20),
      gamma: U.clamp(Number(s.pictureGamma) || 0, -20, 20)
    };
  }
  function picturePreset(mode) {
    return {
      original: [100, 100, 100, 0, 0, 0],
      cinema: [88, 128, 74, 12, -4, -3],
      vivid: [112, 138, 146, -4, -2, 2],
      standard: [100, 108, 108, 0, 0, 0],
      night: [76, 112, 78, 16, -6, -5],
      sports: [108, 124, 132, -8, 2, 3],
      custom: [100, 100, 100, 0, 0, 0]
    }[mode] || [100, 100, 100, 0, 0, 0];
  }
  function pictureEffectiveValues(p) {
    var preset = picturePreset(p.mode);
    return {
      mode: p.mode,
      brightness: U.clamp(Math.round(p.brightness * preset[0] / 100), 60, 160),
      contrast: U.clamp(Math.round(p.contrast * preset[1] / 100), 60, 180),
      saturation: U.clamp(Math.round(p.saturation * preset[2] / 100), 0, 220),
      tone: U.clamp(p.tone + preset[3], -30, 30),
      blackLevel: U.clamp(p.blackLevel + preset[4], -20, 20),
      gamma: U.clamp(p.gamma + preset[5], -20, 20)
    };
  }
  function pictureButton(p) {
    var b = els['osd-picture']; if (!b) return;
    b.textContent = T('p.picture') + (p.mode === 'original' ? '' : ' · ' + T('p.picture.' + p.mode));
  }
  function isPictureNeutral(p) { return p.brightness === 100 && p.contrast === 100 && p.saturation === 100 && !p.tone && !p.blackLevel && !p.gamma; }
  function applyPictureMode() {
    if (!video) return;
    var base = pictureValues(), p = pictureEffectiveValues(base), b = p.brightness, c = p.contrast, s = p.saturation, fx = els['picture-fx'], layers = [], alpha;
    /* Filter gives a true grade on browser/Android renderers. */
    var filter = base.mode === 'original' ? '' : 'brightness(' + b.toFixed(1) + '%) contrast(' + c.toFixed(1) + '%) saturate(' + s.toFixed(1) + '%)';
    video.style.webkitFilter = filter; video.style.filter = filter;
    /* Overlay is intentionally pronounced enough to prove the action immediately
       on LG native video planes where the filter itself has no visible effect. */
    if (base.mode !== 'original' && !isPictureNeutral(p)) {
      if (b < 100) { alpha = Math.min(.28, (100 - b) / 115); layers.push('linear-gradient(rgba(0,0,0,' + alpha.toFixed(3) + '),rgba(0,0,0,' + alpha.toFixed(3) + '))'); }
      else if (b > 100) { alpha = Math.min(.20, (b - 100) / 185); layers.push('linear-gradient(rgba(255,255,255,' + alpha.toFixed(3) + '),rgba(255,255,255,' + alpha.toFixed(3) + '))'); }
      if (c > 100) { alpha = Math.min(.22, (c - 100) / 175); layers.push('radial-gradient(ellipse at center,rgba(0,0,0,0) 38%,rgba(0,0,0,' + alpha.toFixed(3) + ') 100%)'); }
      else if (c < 100) { alpha = Math.min(.16, (100 - c) / 230); layers.push('linear-gradient(rgba(255,255,255,' + alpha.toFixed(3) + '),rgba(255,255,255,' + alpha.toFixed(3) + '))'); }
      if (s < 100) { alpha = Math.min(.34, (100 - s) / 190); layers.push('linear-gradient(rgba(128,128,128,' + alpha.toFixed(3) + '),rgba(128,128,128,' + alpha.toFixed(3) + '))'); }
      else if (s > 100) { alpha = Math.min(.12, (s - 100) / 650); layers.push('linear-gradient(105deg,rgba(255,35,85,' + alpha.toFixed(3) + '),rgba(0,0,0,0) 48%,rgba(20,155,255,' + alpha.toFixed(3) + '))'); }
      if (p.tone) { alpha = Math.min(.18, Math.abs(p.tone) / 155); layers.push('linear-gradient(rgba(' + (p.tone > 0 ? '255,120,24' : '24,128,255') + ',' + alpha.toFixed(3) + '),rgba(' + (p.tone > 0 ? '255,120,24' : '24,128,255') + ',' + alpha.toFixed(3) + '))'); }
      /* Black level and gamma are visible overlay grades when the native video plane
         is isolated from filters. Negative values deepen shadows; positive values lift them. */
      if (p.blackLevel) { alpha = Math.min(.17, Math.abs(p.blackLevel) / 125); layers.push('linear-gradient(rgba(' + (p.blackLevel < 0 ? '0,0,0' : '255,255,255') + ',' + alpha.toFixed(3) + '),rgba(' + (p.blackLevel < 0 ? '0,0,0' : '255,255,255') + ',' + alpha.toFixed(3) + '))'); }
      if (p.gamma) { alpha = Math.min(.14, Math.abs(p.gamma) / 165); layers.push('radial-gradient(ellipse at center,rgba(' + (p.gamma > 0 ? '255,255,255' : '0,0,0') + ',' + alpha.toFixed(3) + ') 0%,rgba(' + (p.gamma > 0 ? '255,255,255' : '0,0,0') + ',0) 72%)'); }
    }
    if (fx) { fx.style.background = layers.length ? layers.join(',') : 'transparent'; fx.style.opacity = layers.length ? '1' : '0'; }
    pictureButton(base);
  }
  function resetPictureControls() {
    Store.setSetting('pictureBrightness', 100); Store.setSetting('pictureContrast', 100); Store.setSetting('pictureSaturation', 100);
    Store.setSetting('pictureTone', 0); Store.setSetting('pictureBlackLevel', 0); Store.setSetting('pictureGamma', 0);
  }
  function setPictureMode(mode, resetControls) {
    Store.setSetting('pictureMode', mode);
    if (resetControls || mode === 'original') resetPictureControls();
    applyPictureMode();
  }
  function pictureMeter(key, value) {
    var limit = PICTURE_LIMITS[key], percent = Math.round((value - limit.min) / (limit.max - limit.min) * 100);
    return '<span class="pic-meter"><i style="width:' + U.clamp(percent, 0, 100) + '%"></i></span>';
  }
  function syncPictureMenu() {
    if (trackMenuKind !== 'picture') return;
    var p = pictureEffectiveValues(pictureValues()), menu = els['track-menu'];
    U.$$('.track-item[data-picture-preset]', menu).forEach(function (item) { item.classList.toggle('active', item.getAttribute('data-picture-preset') === p.mode); });
    U.$$('.track-item[data-picture-key]', menu).forEach(function (item) {
      var key = item.getAttribute('data-picture-key');
      var label = U.$('.pic-label', item), value = U.$('.pic-value', item), meter = U.$('.pic-meter i', item);
      if (label) label.textContent = T('p.' + key);
      if (value) value.textContent = (p[key] > 0 && PICTURE_LIMITS[key].min < 0 ? '+' : '') + p[key] + PICTURE_LIMITS[key].unit;
      if (meter) meter.style.width = U.clamp(Math.round((p[key] - PICTURE_LIMITS[key].min) / (PICTURE_LIMITS[key].max - PICTURE_LIMITS[key].min) * 100), 0, 100) + '%';
    });
    pictureButton(p);
  }
  function adjustPicture(key, delta) {
    var limit = PICTURE_LIMITS[key]; if (!limit) return false;
    var base = pictureValues(), effective = pictureEffectiveValues(base);
    /* A direct adjustment becomes Custom while retaining the exact visible grade
       of the selected preset before adding this key press. */
    if (base.mode !== 'custom') {
      Store.setSetting('pictureMode', 'custom');
      PICTURE_CONTROLS.forEach(function (name) { Store.setSetting('picture' + name.charAt(0).toUpperCase() + name.slice(1), U.clamp(effective[name], PICTURE_LIMITS[name].min, PICTURE_LIMITS[name].max)); });
    }
    var now = pictureValues(), value = U.clamp(now[key] + delta * limit.step, limit.min, limit.max);
    if (value === now[key]) return true;
    Store.setSetting('picture' + key.charAt(0).toUpperCase() + key.slice(1), value);
    applyPictureMode(); syncPictureMenu(); showOsd(true);
    return true;
  }
  function adjustFocusedPicture(delta) {
    var currentFocus = Nav.current();
    if (!currentFocus || currentFocus.getAttribute('data-nav') !== 'track') return false;
    var key = currentFocus.getAttribute('data-picture-key');
    return key ? adjustPicture(key, delta) : false;
  }
  function openPictureMenu() {
    var p = pictureEffectiveValues(pictureValues()), menu = els['track-menu'];
    trackMenuKind = 'picture'; trackReturnEl = els['osd-picture'];
    menu.className = 'track-menu picture-menu';
    menu.innerHTML = '<div class="tm-title">' + U.esc(T('p.picture')) + '</div><div class="tm-hint">' + U.esc(T('p.pictureHint')) + '</div><div class="tm-divider"></div>';
    function preset(mode) {
      var d = U.el('div', 'track-item picture-preset focusable' + (p.mode === mode ? ' active' : ''), U.esc(T('p.picture.' + mode)));
      d.setAttribute('data-nav', 'track'); d.setAttribute('data-picture-preset', mode);
      d.onclick = function () { setPictureMode(mode, true); syncPictureMenu(); showOsd(true); UI.toast(T('p.picture.' + mode)); };
      menu.appendChild(d);
    }
    PICTURE_PRESETS.forEach(preset);
    menu.appendChild(U.el('div', 'tm-divider'));
    PICTURE_CONTROLS.forEach(function (key) {
      var d = U.el('div', 'track-item picture-adjust focusable');
      d.setAttribute('data-nav', 'track'); d.setAttribute('data-picture-key', key);
      d.innerHTML = '<span class="pic-label">' + U.esc(T('p.' + key)) + '</span><span class="pic-value">' + (p[key] > 0 && PICTURE_LIMITS[key].min < 0 ? '+' : '') + p[key] + PICTURE_LIMITS[key].unit + '</span>' + pictureMeter(key, p[key]) + '<span class="pic-arrows">◀ − &nbsp; + ▶</span>';
      d.onclick = function () { UI.toast(T('p.adjustHint')); showOsd(true); };
      menu.appendChild(d);
    });
    menu.appendChild(U.el('div', 'tm-divider'));
    var reset = U.el('div', 'track-item picture-reset focusable', U.esc(T('p.resetPicture')));
    reset.setAttribute('data-nav', 'track'); reset.setAttribute('data-picture-reset', '1');
    reset.onclick = function () { setPictureMode('original', true); syncPictureMenu(); showOsd(true); UI.toast(T('p.resetPicture')); };
    menu.appendChild(reset);
    menu.classList.add('show'); trackMenuOpen = true; showOsd(true); Nav.focusScope('track');
  }

  /* ---- stream statistics overlay (INFO / BLUE) ---- */
  var statsOpen = false, statsTimer = null, statsPrev = null, brHist = [];
  function toggleStats(force) {
    statsOpen = force == null ? !statsOpen : !!force; els['stats-box'].classList.toggle('show', statsOpen);
    clearInterval(statsTimer); statsPrev = null; brHist = [];
    if (statsOpen) { renderStats(); if (manager && manager.inspectNow) manager.inspectNow(); statsTimer = setInterval(renderStats, 1000); }
  }
  function fmtBits(bps) { if (!bps || !isFinite(bps)) return T('stats.unknown'); return bps >= 1e6 ? (bps / 1e6).toFixed(2) + ' Mbps' : Math.round(bps / 1e3) + ' kbps'; }
  function bufferAhead() { try { var b = video.buffered, t = video.currentTime; for (var i = 0; i < b.length; i++) if (b.start(i) <= t && b.end(i) >= t) return b.end(i) - t; } catch (e) { } return 0; }
  function playbackQuality() {
    var q = null; try { if (video.getVideoPlaybackQuality) q = video.getVideoPlaybackQuality(); } catch (e) { }
    if (q) return { decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames };
    if (video.webkitDecodedFrameCount != null) return { decoded: video.webkitDecodedFrameCount, dropped: video.webkitDroppedFrameCount || 0 };
    return null;
  }
  function renderStats() {
    if (!current) return; var rows = [], w = video.videoWidth, h = video.videoHeight;
    // bitrate: hls.js gives per-level bitrate + measured bandwidth; native: estimate from buffered bytes via webkitVideoDecodedByteCount when available
    var br = null, bw = null, codec = null, lat = null;
    if (hls) {
      var lv = hls.levels && hls.levels[hls.currentLevel]; if (lv) { br = lv.bitrate; codec = [lv.videoCodec, lv.audioCodec].filter(Boolean).join(' / '); }
      bw = hls.bandwidthEstimate; if (hls.latency != null && isFinite(hls.latency)) lat = hls.latency;
    } else {
      var bytes = (video.webkitVideoDecodedByteCount || 0) + (video.webkitAudioDecodedByteCount || 0), now = Date.now();
      if (statsPrev && bytes > statsPrev.bytes) br = (bytes - statsPrev.bytes) * 8 / ((now - statsPrev.t) / 1000);
      statsPrev = { bytes: bytes, t: now };
    }
    if (br) { brHist.push(br); if (brHist.length > 40) brHist.shift(); }
    var q = playbackQuality(), dropPct = q && q.decoded ? (q.dropped / q.decoded * 100) : 0;
    var ext = (current.url || '').split('?')[0].split('.').pop().toLowerCase(); if (ext.length > 5) ext = '';
    var container = { m3u8: 'HLS', ts: 'MPEG-TS', mp4: 'MP4', mkv: 'Matroska', avi: 'AVI', mpd: 'DASH' }[ext] || ext.toUpperCase();
    var res = w && h ? (w + '×' + h + (h >= 2100 ? ' (4K)' : h >= 1000 ? ' (FHD)' : h >= 700 ? ' (HD)' : ' (SD)')) : T('stats.unknown');
    rows.push([T('stats.res'), res]);
    rows.push([T('stats.bitrate'), fmtBits(br) + (bw ? ' · ↓ ' + fmtBits(bw) : ''), br ? (br > 12e6 ? 'good' : '') : '']);
    rows.push([T('stats.buffer'), bufferAhead().toFixed(1) + ' s', bufferAhead() < 2 ? 'warn' : 'good']);
    if (q) rows.push([T('stats.dropped'), q.dropped + ' / ' + q.decoded + ' (' + dropPct.toFixed(2) + '%)', dropPct > 5 ? 'bad' : dropPct > 1 ? 'warn' : 'good']);
    rows.push([T('stats.codec'), (codec ? codec + ' · ' : '') + (container || T('stats.unknown'))]);
    rows.push([T('stats.engine'), hls ? T('stats.hlsjs') : T('stats.native')]);
    if (manager && manager.diagnostics) {
      var metric = manager.diagnostics();
      /* INFO / BLUE is the existing developer diagnostic surface. Values are
         strictly source metadata and redacted origin, never passwords/tokens. */
      rows.push(['Provider', metric.provider || (current && current.provider) || '—']);
      rows.push(['Stream', [metric.protocol, metric.streamType || container].filter(Boolean).join(' · ') || '—']);
      if (metric.mimeType) rows.push(['MIME', metric.mimeType]);
      if (metric.hlsMaster) rows.push(['HLS master', metric.videoVariants + ' video / ' + metric.audioOnlyVariants + ' audio-only']);
      if (metric.nativeCompatibilityWarning) rows.push(['webOS HLS', metric.nativeCompatibilityWarning, 'warn']);
      rows.push(['Strategy', metric.strategy || (hls ? 'hls.js' : 'native')]);
      rows.push([T('stats.state'), metric.currentState || manager.state]);
      if (metric.lastEvent) rows.push(['Event', metric.lastEvent]);
      if (metric.httpStatus || metric.inspectionError) rows.push(['HTTP', metric.httpStatus ? String(metric.httpStatus) : 'probe unavailable', metric.httpStatus >= 400 ? 'bad' : '']);
      if (metric.redirects) rows.push(['Redirects', String(metric.redirects)]);
      if (metric.streamResolveTime) rows.push([T('stats.resolve'), metric.streamResolveTime + ' ms']);
      if (metric.startupDuration) rows.push([T('stats.startup'), metric.startupDuration + ' ms']);
      if (metric.timeToFirstFrame) rows.push(['First frame', metric.timeToFirstFrame + ' ms']);
      if (metric.bufferingCount) rows.push([T('stats.bufferEvents'), String(metric.bufferingCount), 'warn']);
      if (metric.bufferingDuration) rows.push([T('stats.bufferTime'), (metric.bufferingDuration / 1000).toFixed(1) + ' s', 'warn']);
      if (metric.recoveryCount) rows.push([T('stats.recoveries'), String(metric.recoveryCount), 'warn']);
      if (metric.retryCount) rows.push(['Retries', String(metric.retryCount), 'warn']);
      if (metric.lastErrorCode) rows.push([T('stats.error'), metric.lastErrorCode, 'warn']);
    }
    if (lat != null && lat < 90) rows.push([T('stats.latency'), lat.toFixed(1) + ' s']);
    if (manager && manager.attempts()) rows.push(['Retries', String(manager.attempts())]);
    rows.push([T('stats.url'), redactStreamUrl(current.url)]);
    var html = '<h4>' + U.esc(T('stats.title')) + '<span class="live-dot"></span></h4>' + rows.map(function (r) { return '<div class="sr"><span>' + U.esc(r[0]) + '</span><b class="' + (r[2] || '') + '">' + U.esc(r[1]) + '</b></div>'; }).join('');
    if (brHist.length > 1) { var mx = Math.max.apply(null, brHist), bars = []; for (var bi = 0; bi < 40; bi++) { var v = brHist[brHist.length - 40 + bi]; bars.push('<i style="height:' + (v == null ? 2 : Math.max(3, Math.round(v / mx * 100))) + '%;' + (v == null ? 'opacity:.15' : '') + '"></i>'); } html += '<div class="graph">' + bars.join('') + '</div>'; }
    els['stats-box'].innerHTML = html;
  }

  /* ---- key handling while player screen is active ---- */
  function handleKey(name, code) {
    if (!App.isScreen('player')) return false;
    var K = Nav.KEYS;
    if (trackMenuOpen) {
      if (name === 'BACK' || name === 'BACK2') { closeTrackMenu(); return true; }
      /* Picture sliders are adjusted directly with the remote arrows. They never
         require OK and the menu deliberately stays open after every change. */
      if (trackMenuKind === 'picture' && name === 'LEFT' && adjustFocusedPicture(-1)) return true;
      if (trackMenuKind === 'picture' && name === 'RIGHT' && adjustFocusedPicture(1)) return true;
      if (name === 'UP' || name === 'DOWN' || name === 'ENTER') { showOsd(true); return false; }
      return true;
    }
    if (zapOpen) {
      if (name === 'BACK' || name === 'BACK2' || name === 'LEFT') { toggleZapList(); return true; }
      if (name === 'UP' || name === 'DOWN') { Nav.move(name.toLowerCase()); var c = Nav.current(); if (c && c.getAttribute('data-nav') === 'zap') scrollZap(c); return true; }
      if (name === 'ENTER') return false;
      return true;
    }
    if (code >= 48 && code <= 57) { numberKey(String(code - 48)); return true; }
    if (zapPending) { if (name === 'ENTER') { commitZap(zapPending.idx, zapPending.n); return true; } if (name === 'BACK' || name === 'BACK2') { cancelZap(); return true; } }
    if (statsOpen && (name === 'BACK' || name === 'BACK2')) { toggleStats(false); return true; }
    if (autoNextOpen()) {
      if (name === 'ENTER' || name === 'PLAY' || name === 'PLAYPAUSE') { var pf = an.onPlay; hideAutoNext(); if (pf) pf(); return true; }
      if (name === 'BACK' || name === 'BACK2' || name === 'STOP') { var cf = an.onCancel; hideAutoNext(); if (cf) cf(); return true; }
    }
    switch (name) {
      case 'BACK': case 'BACK2': if (osdVisible() && Nav.current() && Nav.current().getAttribute('data-nav') === 'osd') { hideOsd(); return true; } App.closePlayer(); return true;
      case 'PLAY':
        if (manager && manager.state === PlaybackManager.STATES.ERROR) manager.retryNow();
        else { if (manager) manager.setUserPaused(false); video.play().catch(function (e) { if (manager) manager.mediaError({ message: e && e.message || 'Unable to resume playback' }); }); }
        showOsd(); return true;
      case 'PAUSE': if (manager) manager.setUserPaused(true); video.pause(); showOsd(); return true;
      case 'PLAYPAUSE': togglePlay(); return true;
      case 'STOP': App.closePlayer(); return true;
      case 'REW': seek(-30); return true;
      case 'FF': seek(30); return true;
      case 'NEXT': case 'CH_UP': next(); return true;
      case 'PREV': case 'CH_DOWN': prev(); return true;
      case 'INFO': toggleStats(); return true;
      case 'BLUE': toggleStats(); return true;
      case 'GREEN': cycleRatio(); return true;
      case 'YELLOW': recall(); return true;
      case 'ENTER':
        if (manager && manager.state === PlaybackManager.STATES.ERROR && current) { error(null); loading(true, T('retrying')); manager.retryNow(); return true; }
        /* The first OK always reveals the complete player bar and lands on Picture,
           so its remote-only LEFT / RIGHT controls are immediately discoverable. */
        if (!osdVisible() || !Nav.current() || Nav.current().getAttribute('data-nav') !== 'osd') { showOsd(); Nav.focus(els['osd-picture'] || els['osd-play']); return true; }
        return false;
      case 'UP': if (!osdVisible()) { if (current && current.type === 'live') next(); else { showOsd(); Nav.focus(els['osd-play']); } return true; } showOsd(); return false;
      case 'DOWN': if (!osdVisible()) { showOsd(); Nav.focus(els['osd-play']); return true; } showOsd(); return false;
      case 'LEFT': if (!osdVisible()) { if (current && current.type !== 'live') seek(-30); else if (current) toggleZapList(); return true; } showOsd(); return false;
      case 'RIGHT': if (!osdVisible()) { if (current && current.type !== 'live') seek(30); else showOsd(); return true; } showOsd(); return false;
    }
    return false;
  }
  function action(a) {
    switch (a) {
      case 'p-play': togglePlay(); break; case 'p-retry': if (manager) manager.retryNow(); break; case 'p-back': App.closePlayer(); break; case 'p-rew': seek(-30); break; case 'p-ffw': seek(30); break;
      case 'p-next': next(); break; case 'p-prev': prev(); break; case 'p-recall': recall(); break; case 'p-ratio': cycleRatio(); break;
      case 'p-audio': openTrackMenu('audio'); break; case 'p-subs': openTrackMenu('subs'); break; case 'p-picture': openPictureMenu(); break;
      case 'p-list': toggleZapList(); break; case 'p-stats': toggleStats(); break;
      case 'p-fav': if (current && current.type !== 'catchup') { var t = current.type === 'episode' ? 'series' : current.type; var id = current.type === 'episode' ? current.seriesId : current.id; var on = Store.toggleFav(App.account.id, { type: t, id: id, name: current.seriesName || current.name, logo: current.logo, poster: current.poster, ext: current.ext, cmd: current.cmd, url: current.url, catId: current.catId, num: current.num, epgId: current.epgId }); UI.toast(on ? 'Added to favorites' : 'Removed from favorites'); updateFavBtn(); } break;
    }
    showOsd();
  }
  function setOnEnded(fn) { onEnded = fn; }
  function getCurrent() { return current; }
  function reset() { zapOpen = false; trackMenuOpen = false; trackMenuKind = ''; trackReturnEl = null; toggleStats(false); cancelZap(); hideAutoNext(); els['zap-list'].classList.remove('show'); els['track-menu'].classList.remove('show'); els['track-menu'].classList.remove('picture-menu'); hideOsd(); }

  function setCanPlay(fn) { canPlay = fn; }
  function pause() { if (!video) return false; if (manager) manager.setUserPaused(true); video.pause(); return true; }
  function resume() { if (!video) return false; if (manager) manager.setUserPaused(false); video.play().catch(function (e) { if (manager) manager.mediaError({ message: e && e.message || 'Unable to resume playback' }); }); return true; }
  function retry() { return manager ? manager.retryNow() : false; }
  function setAspectRatio(mode) { var names = ['fit', 'fill', 'stretch'], i = names.indexOf(String(mode || '').toLowerCase()); if (i < 0) return false; ratioMode = i; Store.setSetting('aspectRatio', names[i]); applyRatio(); return true; }
  return { init: init, play: play, switchChannel: play, stop: stop, pause: pause, resume: resume, retry: retry, handleKey: handleKey, action: action, setOnEnded: setOnEnded, setCanPlay: setCanPlay, current: getCurrent, state: function () { return manager ? manager.state : 'IDLE'; }, getState: function () { return manager ? manager.state : 'IDLE'; }, session: function () { return manager ? manager.currentSession() : 0; }, diagnostics: function () { return manager && manager.diagnostics ? manager.diagnostics() : {}; }, getDiagnostics: function () { return manager && manager.diagnostics ? manager.diagnostics() : {}; }, capabilities: capabilities, getCapabilities: capabilities, setAspectRatio: setAspectRatio, showOsd: showOsd, reset: reset, autoNext: autoNext, hideAutoNext: hideAutoNext, video: function () { return video; } };
})();
