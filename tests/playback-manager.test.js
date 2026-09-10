/* Provider-neutral playback lifecycle regression tests.
 * Run with: node tests/playback-manager.test.js
 * Uses no browser or Android APIs: the manager is exercised with a webOS-video
 * adapter seam, matching the packaged HTML5 architecture. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var ROOT = __dirname + '/..';

var context = {
  Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout,
  /* The manager's watchdog is separately tested through media errors; do not
     retain a real interval in this dependency-free test process. */
  setInterval: function () { return 1; }, clearInterval: function () {},
  window: {}, console: console, AbortController: AbortController
};
vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/playback-manager.js', 'utf8'), context, { filename: 'playback-manager.js' });

function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function stream(id, type) { return { url: 'https://stream.example/' + id + (type === 'hls' ? '.m3u8?token=private' : type === 'mpegts' ? '.ts' : '.mp4'), type: type || 'mp4', provider: 'fixture', channelId: id, headers: {}, metadata: { live: true } }; }
function harness(resolve) {
  var loads = [], states = [], errors = [], clears = 0, snapshot = { paused: false, ended: false, readyState: 0, currentTime: 0 };
  var manager = new context.PlaybackManager({
    resolve: resolve,
    adapter: {
      clear: function () { clears++; },
      load: function (source, session, engine) { loads.push({ source: source, session: session, engine: engine }); },
      snapshot: function () { return snapshot; },
      canUseHls: function () { return true; },
      canPlayDash: function () { return false; },
      recoverMedia: function () { loads.push({ recoveredMedia: true }); }
    },
    onState: function (state, detail, session) { states.push({ state: state, detail: detail, session: session }); },
    onError: function (error, attempts) { errors.push({ error: error, attempts: attempts }); }
  });
  manager.recovery.delays = [5, 8, 12];
  return { manager: manager, loads: loads, states: states, errors: errors, snapshot: snapshot, clears: function () { return clears; } };
}

async function testDetectionAndNormalization() {
  var D = context.StreamTypeDetector, R = context.StreamResolver;
  assert.strictEqual(D.detect('https://edge.example/live/1.m3u8?token=abc').type, 'hls');
  assert.strictEqual(D.detect('https://edge.example/get.php?output=ts').type, 'mpegts');
  assert.strictEqual(D.detect('https://edge.example/video.mp4').type, 'mp4');
  assert.strictEqual(D.detect('https://edge.example/manifest.mpd').type, 'dash');
  assert.strictEqual(D.detect('https://edge.example/opaque/token-route').type, 'unknown');
  assert.throws(function () { R.normalize('ftp://unsupported.example/live', { type: 'm3u' }, { id: 1 }); }, /Invalid or missing/);

  var m3u = await R.resolve({ type: 'm3u', resolveStream: function () { return Promise.resolve({ url: 'https://stream.example/a.m3u8?token=do-not-change', headers: { Referer: 'https://portal.example/' } }); } }, { id: 'a', type: 'live' }, {});
  var xtream = await R.resolve({ type: 'xtream', resolveStream: function () { return Promise.resolve({ url: 'https://stream.example/b.ts?username=private' }); } }, { id: 'b', type: 'live' }, {});
  var stalker = await R.resolve({ type: 'stalker', resolveStream: function () { return Promise.resolve({ url: 'https://stream.example/c.m3u8?token=private' }); } }, { id: 'c', type: 'live' }, {});
  assert.strictEqual(m3u.type, 'hls'); assert.strictEqual(m3u.url, 'https://stream.example/a.m3u8?token=do-not-change', 'normalization preserves exact M3U URLs');
  assert.strictEqual(m3u.headers.Referer, 'https://portal.example/');
  assert.strictEqual(xtream.type, 'mpegts'); assert.strictEqual(stalker.type, 'hls');
}

async function testSessionRaceAndRapidSwitching() {
  var resolveA, resolveB;
  var h = harness(function (item) {
    return new Promise(function (resolve) { if (item.id === 'A') resolveA = resolve; else resolveB = resolve; });
  });
  var oldRequest = h.manager.play({ id: 'A', type: 'live', name: 'A' }, {});
  var newRequest = h.manager.play({ id: 'B', type: 'live', name: 'B' }, {});
  resolveB(stream('B', 'hls')); await newRequest;
  resolveA(stream('A', 'hls')); await oldRequest;
  assert.strictEqual(h.loads.length, 1, 'late Channel A resolver must never overwrite Channel B');
  assert.strictEqual(h.loads[0].source.channelId, 'B');
  assert.strictEqual(h.loads[0].session, h.manager.currentSession());

  var delayed = {}, rapid = harness(function (item) {
    return new Promise(function (resolve) { delayed[item.id] = resolve; });
  });
  rapid.manager.play({ id: '1', type: 'live' }, {});
  rapid.manager.play({ id: '2', type: 'live' }, {});
  rapid.manager.play({ id: '3', type: 'live' }, {});
  delayed['3'](stream('3')); await wait(0); delayed['1'](stream('1')); delayed['2'](stream('2')); await wait(0);
  assert.deepStrictEqual(rapid.loads.map(function (x) { return x.source.channelId; }), ['3'], 'rapid zaps have exactly one winning source assignment');
}

async function testFallbackAndBoundedRecovery() {
  var h = harness(function () { return Promise.resolve(stream('hls', 'hls')); });
  await h.manager.play({ id: 'hls', type: 'live' }, {});
  assert.strictEqual(h.loads[0].engine, 'native', 'webOS native HTML5 HLS remains the first engine');
  h.manager.mediaError({ nativeCode: 4, message: 'source not supported' });
  assert.strictEqual(h.loads.length, 2);
  assert.strictEqual(h.loads[1].engine, 'hls', 'one native HLS failure performs exactly one hls.js handoff');
  h.manager.mediaError({ hls: true, type: 'networkError', message: 'segment network error' });
  await wait(320);
  assert.strictEqual(h.loads[2].engine, 'hls', 'recovery stays on the selected HLS adapter instead of oscillating decoders');

  var calls = 0, retry = harness(function () {
    calls++;
    if (calls === 1) return Promise.reject(new Error('Network timeout'));
    return Promise.resolve(stream('recovered', 'mpegts'));
  });
  await retry.manager.play({ id: 'recovered', type: 'live' }, {});
  await wait(320);
  assert.strictEqual(calls, 2, 'temporary network error retries through one central manager');
  assert.strictEqual(retry.loads.length, 1);
  assert.strictEqual(retry.manager.attempts(), 1, 'retry count is session-wide and is not reset by playing');

  var failures = 0, exhausted = harness(function () { failures++; return Promise.reject(new Error('Network error')); });
  await exhausted.manager.play({ id: 'bad', type: 'live' }, {});
  await wait(900);
  assert.strictEqual(failures, 4, 'initial attempt plus the fixed 3/3 recovery policy only');
  assert.strictEqual(exhausted.manager.state, context.PlaybackManager.STATES.ERROR);
  assert.strictEqual(exhausted.errors.length, 1);
}

async function testSmartBufferAndMetrics() {
  var h = harness(function () { return Promise.resolve(stream('metrics', 'mpegts')); });
  await h.manager.play({ id: 'metrics', type: 'live' }, {});
  assert.ok(h.states.some(function (entry) { return entry.state === context.PlaybackManager.STATES.RESOLVING; }) && h.states.some(function (entry) { return entry.state === context.PlaybackManager.STATES.STARTING; }), 'the explicit lifecycle distinguishes resolving from source start');
  h.manager.mediaEvent('loadstart', { networkState: 2 });
  h.manager.mediaEvent('loadedmetadata');
  h.manager.mediaEvent('canplay');
  h.manager.mediaEvent('playing');
  var metric = h.manager.diagnostics();
  assert.ok(metric.startupStartedAt > 0 && metric.sourceAssignedAt > 0 && metric.loadStartedAt > 0, 'V2 records startup/source/load timestamps');
  assert.ok(metric.metadataLoadedAt > 0 && metric.canPlayAt > 0 && metric.playingAt > 0, 'V2 records metadata/canplay/playing timestamps');
  assert.ok(metric.startupDuration >= 0 && metric.networkState === 2, 'startup duration and available network state are local diagnostics');
  h.manager.mediaEvent('waiting');
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.PLAYING, 'transient waiting does not immediately flash a buffering state');
  await wait(750);
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.BUFFERING, 'short live waiting becomes buffering only after the SmartBuffer grace period');
  assert.strictEqual(h.manager.diagnostics().bufferingCount, 1);
  h.manager.mediaEvent('progress', { progressed: true });
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.BUFFERING, 'buffer download alone does not hide the spinner while the media clock is stuck');
  h.manager.mediaEvent('timeupdate', { progressed: true, currentTime: 1 });
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.PLAYING, 'real media-clock progress clears buffering without a reconnect');
  assert.ok(h.manager.diagnostics().bufferingDuration > 0, 'buffer duration is captured for local diagnostics');
  h.manager.networkLost();
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.BUFFERING, 'offline signal presents a network-lost buffering state without opening another source');
  h.manager.mediaEvent('timeupdate', { progressed: true, currentTime: 2 });
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.PLAYING);
  h.manager.setUserPaused(true); h.manager.mediaEvent('pause');
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.PAUSED, 'user pause has an explicit state and is never interpreted as a failure');
  h.manager.setUserPaused(false); h.manager.mediaEvent('playing', { currentTime: 3 });
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.PLAYING);
  h.manager.stop();
  assert.strictEqual(h.manager.state, context.PlaybackManager.STATES.STOPPED, 'a deliberate stop has a terminal STOPPED state rather than looking like a playback error');
}

async function testAdaptiveRecoveryFingerprintWatchdogAndCircuit() {
  var calls = 0, adaptive = harness(function () { calls++; return Promise.resolve(stream('adaptive', 'mpegts')); }), reloads = 0, bufferNudges = 0;
  adaptive.manager.adapter.reload = function (source, session, engine) { reloads++; assert.strictEqual(source.url, 'https://stream.example/adaptive.ts'); assert.strictEqual(engine, 'native'); return true; };
  adaptive.manager.adapter.recoverBuffer = function () { bufferNudges++; return true; };
  await adaptive.manager.play({ id: 'adaptive', type: 'live' }, {});
  adaptive.manager.mediaError({ message: 'Network timeout' }); await wait(320);
  assert.strictEqual(calls, 1, 'first temporary transport recovery reloads the known source before another provider resolve');
  assert.strictEqual(reloads, 1, 'adaptive level two uses the stable adapter rather than replacing the video element');
  var bufferOnly = harness(function () { return Promise.resolve(stream('buffer-only', 'mpegts')); });
  bufferOnly.manager.adapter.recoverBuffer = function () { bufferNudges++; return true; };
  await bufferOnly.manager.play({ id: 'buffer-only', type: 'live' }, {});
  bufferOnly.manager.fail({ code: 'BUFFER_ERROR', message: 'Playback media clock stalled' }); await wait(320);
  assert.strictEqual(bufferNudges, 1, 'adaptive level one lets the HLS buffer recover before a source reload');

  var fingerprintCalls = 0, fingerprints = harness(function () { fingerprintCalls++; return Promise.resolve(stream('fingerprint', 'mpegts')); });
  await fingerprints.manager.play({ id: 'fingerprint', type: 'live' }, {});
  fingerprints.manager.sameSourceReloadTried = true;
  fingerprints.manager._retry(fingerprints.manager.currentSession(), 2, { code: 'NETWORK_ERROR' }); await wait(0);
  assert.strictEqual(fingerprintCalls, 2);
  assert.strictEqual(fingerprints.manager.diagnostics().sameStreamResolutions, 1, 'source fingerprint detects an unchanged re-resolved URL without exposing it');
  assert.strictEqual(fingerprints.loads.length, 1, 'an unchanged re-resolve does not reload identical decoder input again');
  fingerprints.manager.recovery.cancel();

  var watch = harness(function () { return Promise.resolve(stream('watch', 'mpegts')); });
  await watch.manager.play({ id: 'watch', type: 'live' }, {});
  watch.snapshot.readyState = 4; watch.snapshot.currentTime = 10; watch.manager.mediaEvent('playing', { currentTime: 10 });
  watch.manager.lastCurrentTimeAt = Date.now() - 13000; watch.manager._watchdog();
  assert.strictEqual(watch.manager.state, context.PlaybackManager.STATES.RECOVERING, 'independent watchdog detects a frozen media clock even when readyState still looks healthy');
  watch.manager.recovery.cancel();

  var breakerCalls = 0, breaker = harness(function () { breakerCalls++; return Promise.resolve(stream('circuit', 'mpegts')); });
  for (var i = 0; i < 4; i++) { await breaker.manager.play({ id: 'circuit', type: 'live' }, {}); breaker.manager.mediaError({ status: 404, message: 'HTTP 404' }); }
  assert.strictEqual(breaker.manager.diagnostics().lastErrorCode, 'CIRCUIT_OPEN', 'repeated failures open a short local circuit breaker');
  await breaker.manager.play({ id: 'circuit', type: 'live' }, {});
  assert.strictEqual(breakerCalls, 4, 'open circuit blocks a fifth immediate provider request');
  breaker.manager.circuit.entries['fixture:circuit'].openUntil = Date.now() - 1;
  await breaker.manager.play({ id: 'circuit', type: 'live' }, {});
  assert.strictEqual(breakerCalls, 5, 'circuit cooldown reopens the channel without retaining permanent failure state');
}

async function testCancellationAndErrorPolicy() {
  var calls = 0, h = harness(function (item) {
    calls++;
    if (item.id === 'old') return Promise.reject(new Error('Network error'));
    return Promise.resolve(stream('new'));
  });
  await h.manager.play({ id: 'old', type: 'live' }, {}); // schedules old retry
  await h.manager.play({ id: 'new', type: 'live' }, {}); // must cancel it
  await wait(320);
  assert.strictEqual(calls, 2, 'channel change cancels old recovery timer and resolver work');
  assert.strictEqual(h.loads.length, 1);
  assert.strictEqual(h.loads[0].source.channelId, 'new');

  var C = context.PlaybackErrorClassifier;
  [['HTTP 401', 'AUTH_ERROR', false], ['HTTP 403', 'AUTH_ERROR', false], ['HTTP 404', 'HTTP_ERROR', false], ['HTTP 503', 'HTTP_ERROR', true], ['Token expired', 'TOKEN_EXPIRED', true], ['Network timeout', 'TIMEOUT', true], ['HTTP 429 rate limited', 'HTTP_ERROR', true]].forEach(function (row) {
    var error = C(new Error(row[0]));
    assert.strictEqual(error.code, row[1], row[0] + ' has normalized error code');
    assert.strictEqual(error.retryable, row[2], row[0] + ' has correct retry policy');
  });
  var limited = C({ status: 429, response: { headers: { 'retry-after': '2' } } });
  assert.strictEqual(limited.retryAfter, 2000, 'Retry-After seconds are honored centrally');
  var dated = C({ status: 429, response: { headers: { 'Retry-After': new Date(Date.now() + 3000).toUTCString() } } });
  assert.ok(dated.retryAfter > 0 && dated.retryAfter <= 3000, 'Retry-After HTTP dates are honored centrally');
  assert.strictEqual(C({ nativeCode: 4 }).retryable, false, 'unsupported native format never reconnects forever');

  var tokenCalls = 0, token = harness(function () { tokenCalls++; return Promise.resolve(stream('token', 'mpegts')); });
  await token.manager.play({ id: 'token', type: 'live' }, {});
  token.manager.mediaError({ code: 'TOKEN_EXPIRED', message: 'Token expired' }); token.manager.retryNow(); await wait(0);
  assert.strictEqual(tokenCalls, 2, 'an explicit expired token gets one fresh stream resolve');
  token.manager.mediaError({ code: 'TOKEN_EXPIRED', message: 'Token expired' });
  assert.strictEqual(token.manager.state, context.PlaybackManager.STATES.ERROR, 'a second token refresh failure becomes a clear terminal auth error');
}


(async function () {
  await testDetectionAndNormalization();
  await testSessionRaceAndRapidSwitching();
  await testFallbackAndBoundedRecovery();
  await testSmartBufferAndMetrics();
  await testAdaptiveRecoveryFingerprintWatchdogAndCircuit();
  await testCancellationAndErrorPolicy();
  console.log('Playback manager regression checks passed');
})().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
