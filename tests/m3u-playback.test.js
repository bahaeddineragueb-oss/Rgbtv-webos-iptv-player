/* Focused regression checks for M3U direct playback and HLS fallback.
 * Run with: node tests/m3u-playback.test.js
 * This deliberately uses small browser mocks so it remains dependency-free. */
'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var vm = require('vm');
var ROOT = __dirname + '/..';

function parsePlaylist() {
  var context = {
    console: console,
    Promise: Promise,
    window: {},
    Store: {},
    I18n: { t: function (key) { return key; } },
    U: {
      normUrl: function (value) { return value; },
      sha1: function (value) { return crypto.createHash('sha1').update(String(value)).digest('hex'); }
    }
  };
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/api/m3u.js', 'utf8'), context, { filename: 'm3u.js' });
  var provider = new context.M3UProvider({ id: 'm3u-test', type: 'm3u', url: 'https://provider.example/folder/list.m3u' });
  var list = provider._parse([
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="one" group-title="News",News One',
    '#EXTVLCOPT:http-user-agent=VLC%2F3.0',
    '#EXTVLCOPT:http-referrer=https%3A%2F%2Fportal.example%2Fwatch',
    'live/one.m3u8|User-Agent=RGBTv%20Player&Referer=https%3A%2F%2Fprovider.example%2F',
    '#EXTINF:-1 tvg-id="two",News Two',
    'https://edge.example/get.php?username=user&password=pass&output=m3u8'
  ].join('\n'));

  assert.strictEqual(list.length, 2, 'playlist parsing must retain direct M3U channels');
  assert.strictEqual(list[0].url, 'https://provider.example/folder/live/one.m3u8', 'URL|header annotation must never be passed to the player');
  assert.deepStrictEqual(Object.assign({}, list[0].streamHeaders), {
    'User-Agent': 'RGBTv Player',
    Referer: 'https://provider.example/'
  }, 'inline URL headers override EXTVLCOPT headers for this stream only');
  assert.strictEqual(list[1].url, 'https://edge.example/get.php?username=user&password=pass&output=m3u8');
  var stale = [{ type: 'live', url: 'https://cache.example/live.m3u8|User-Agent=Cached%20Player' }, { type: 'series', seasons: { 1: [{ url: 'https://cache.example/episode.m3u8|Referer=https%3A%2F%2Fcache.example%2F' }] } }];
  assert.strictEqual(provider._normalizeCachedItems(stale), true, 'cached entries from an older release must be migrated on upgrade');
  assert.strictEqual(stale[0].url, 'https://cache.example/live.m3u8');
  assert.strictEqual(stale[0].streamHeaders['User-Agent'], 'Cached Player');
  assert.strictEqual(stale[1].seasons[1][0].url, 'https://cache.example/episode.m3u8');
  assert.strictEqual(stale[1].seasons[1][0].streamHeaders.Referer, 'https://cache.example/');
  return { list: list, provider: provider };
}

function classList() {
  var names = {};
  return {
    add: function (name) { names[name] = true; },
    remove: function (name) { delete names[name]; },
    toggle: function (name, force) { if (force === undefined) force = !names[name]; if (force) names[name] = true; else delete names[name]; return !!force; },
    contains: function (name) { return !!names[name]; }
  };
}
function element() {
  return {
    classList: classList(), style: {}, textContent: '', innerHTML: '', className: '', children: [],
    appendChild: function (child) { this.children.push(child); this.firstChild = this.children[0]; return child; },
    setAttribute: function (key, value) { this[key] = String(value); },
    getAttribute: function (key) { return this[key] || null; }
  };
}
function playerHarness(canPlayType, playReturnsPromise, useShaka) {
  var nodes = {}, handlers = {}, intervals = [], hlsInstances = [], shakaInstances = [];
  var video = element();
  video.paused = false; video.ended = false; video.readyState = 0; video.currentTime = 0; video.duration = NaN;
  video.videoWidth = 0; video.videoHeight = 0; video.buffered = { length: 0 };
  video.canPlayType = function () { return canPlayType; };
  video.play = function () { video.paused = false; return playReturnsPromise === false ? undefined : Promise.resolve(); };
  video.pause = function () { video.paused = true; };
  video.load = function () {};
  video.removeAttribute = function (name) { if (name === 'src') video.src = ''; };
  video.addEventListener = function (name, fn) { (handlers[name] || (handlers[name] = [])).push(fn); };
  video.removeEventListener = function (name, fn) { handlers[name] = (handlers[name] || []).filter(function (saved) { return saved !== fn; }); };
  function emit(name) { (handlers[name] || []).slice().forEach(function (fn) { fn(); }); }
  function getNode(id) { return nodes[id] || (nodes[id] = element()); }
  var trackPrefs = {};
  function Hls(config) { this.config = config; this.events = {}; this.audioTracks = []; this.subtitleTracks = []; this.audioTrack = -1; this.subtitleTrack = -1; hlsInstances.push(this); }
  Hls.isSupported = function () { return true; };
  Hls.Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
  Hls.ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
  Hls.prototype.loadSource = function (url) { this.url = url; };
  Hls.prototype.attachMedia = function (media) { this.media = media; };
  Hls.prototype.on = function (event, fn) { this.events[event] = fn; };
  Hls.prototype.destroy = function () { this.destroyed = true; };
  Hls.prototype.startLoad = function () {};
  Hls.prototype.recoverMediaError = function () {};
  function ShakaPlayer(media) { this.media = media; this.events = {}; this.networking = { registerRequestFilter: function (fn) { this.filter = fn; } }; shakaInstances.push(this); }
  ShakaPlayer.isBrowserSupported = function () { return !!useShaka; };
  ShakaPlayer.prototype.configure = function (config) { this.config = config; };
  ShakaPlayer.prototype.getNetworkingEngine = function () { return this.networking; };
  ShakaPlayer.prototype.addEventListener = function (name, fn) { this.events[name] = fn; };
  ShakaPlayer.prototype.load = function (url) { this.url = url; return Promise.resolve(); };
  ShakaPlayer.prototype.destroy = function () { this.destroyed = true; return Promise.resolve(); };
  ShakaPlayer.prototype.getVariantTracks = function () { return this.variantTracks || []; };
  ShakaPlayer.prototype.getTextTracks = function () { return this.textTracks || []; };
  ShakaPlayer.prototype.getStats = function () { return { streamBandwidth: 1000000, estimatedBandwidth: 1500000 }; };
  ShakaPlayer.prototype.emitError = function (detail) { if (this.events.error) this.events.error({ detail: detail }); };
  var shakaApi = { Player: ShakaPlayer, polyfill: { installAll: function () {} }, util: { Error: { Severity: { CRITICAL: 2 } } } };

  var settingValues = { engine: 'auto', pictureMode: 'original', pictureBrightness: 100, pictureContrast: 100, pictureSaturation: 100, pictureTone: 0, pictureBlackLevel: 0, pictureGamma: 0 };
  var context = {
    console: console, Promise: Promise, Hls: Hls,
    window: { Hls: Hls, shaka: shakaApi, MediaSource: useShaka ? function () {} : undefined, addEventListener: function () {} },
    document: { getElementById: getNode },
    setTimeout: function () { return 1; }, clearTimeout: function () {},
    setInterval: function (fn) { intervals.push(fn); return intervals.length; }, clearInterval: function () {},
    I18n: { t: function (key) { return key; } },
    U: {
      $: function (selector) { return selector === '#video' ? video : getNode(selector); },
      $$: function () { return []; }, el: element, esc: function (s) { return s; },
      clamp: function (value, min, max) { return Math.max(min, Math.min(max, value)); },
      fmtTime: function () { return '0:00'; }, clock: function () { return '12:00'; }, hm: function () { return '12:00'; }
    },
    Store: {
      settings: function () { return settingValues; }, setSetting: function (key, value) { settingValues[key] = value; },
      isFav: function () { return false; }, pushHistory: function () {}, getPos: function () {}, setPos: function () {},
      trackPref: function (account, item) { return trackPrefs[item.type + ':' + item.id] || null; }, setTrackPref: function (account, item, kind, value) { var key = item.type + ':' + item.id; trackPrefs[key] = trackPrefs[key] || {}; trackPrefs[key][kind] = value; },
      toggleFav: function () { return false; }
    },
    App: { account: { id: 'test' }, isScreen: function () { return true; }, provider: { streamUrl: function (item) { return Promise.resolve(item.url); } } },
    UI: { toast: function () {}, toPlayable: function (item) { return item; } },
    Nav: { current: function () { return null; }, focus: function () {}, blur: function () {}, focusScope: function () {}, move: function () {}, KEYS: {} }
  };
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/playback-manager.js', 'utf8'), context, { filename: 'playback-manager.js' });
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/player.js', 'utf8'), context, { filename: 'player.js' });
  context.Player.init();
  return { player: context.Player, video: video, emit: emit, hls: hlsInstances, shaka: shakaInstances, nodes: nodes, trackPrefs: trackPrefs, settings: settingValues, context: context };
}

function flushPlayback() { return Promise.resolve().then(function () { return Promise.resolve(); }).then(function () { return Promise.resolve(); }).then(function () { return Promise.resolve(); }); }

async function testM3UStreamContract(parsed) {
  var stream = await parsed.provider.resolveStream(parsed.list[0]);
  assert.strictEqual(stream.provider, 'm3u');
  assert.strictEqual(stream.channelId, parsed.list[0].id);
  assert.strictEqual(stream.url, parsed.list[0].url, 'normalized M3U contract retains the exact original stream URL');
  assert.deepStrictEqual(Object.assign({}, stream.headers), Object.assign({}, parsed.list[0].streamHeaders));
}

async function testPlayerFallback(parsed) {
  var stream = parsed.list[0];
  var native = playerHarness('probably');
  await native.player.play({ type: 'live', id: stream.id, name: stream.name, url: stream.url, streamHeaders: stream.streamHeaders });
  assert.strictEqual(native.nodes['player-transition'].classList.contains('show'), true, 'channel handoff presents a transition layer instead of a featureless black frame');
  assert.strictEqual(native.video.src, stream.url, 'auto mode must keep the direct M3U channel on native webOS first');
  assert.strictEqual(native.hls.length, 0, 'native-capable webOS must not eagerly create an hls.js pipeline');
  /* webOS may canonicalize a source URL. The event remains owned by its stamped
     player session, rather than being rejected by an exact string comparison. */
  native.video.currentSrc = stream.url.replace('https://', 'https://edge-cache.');
  native.emit('canplay');
  assert.strictEqual(native.nodes['player-loading'].classList.contains('show'), false, 'a canonicalized native URL must still clear the loading layer on canplay');
  native.emit('playing');
  assert.strictEqual(native.nodes['player-transition'].classList.contains('show'), false, 'transition layer clears exactly when playback starts');

  /* webOS 1.x WebKit may return undefined from HTMLMediaElement.play(). The
     request is still valid; treating missing Promise.catch as a player failure
     incorrectly diverted valid native streams into recovery. */
  var legacyWebkit = playerHarness('probably', false);
  await legacyWebkit.player.play({ type: 'live', id: 'legacy-play', name: 'Legacy native play', url: stream.url });
  assert.strictEqual(legacyWebkit.video.src, stream.url, 'a non-Promise native play return still assigns the live source');
  assert.strictEqual(legacyWebkit.hls.length, 0, 'a non-Promise native play return never creates a synthetic fallback/error');
  native.video.error = { code: 4 };
  native.emit('error');
  assert.strictEqual(native.hls.length, 1, 'a rejected native HLS source must hand over once instead of beginning reconnects');
  assert.strictEqual(native.hls[0].url, stream.url, 'HLS fallback must retain the direct, stripped channel URL');
  var sent = [];
  native.hls[0].config.xhrSetup({ setRequestHeader: function (key, value) { sent.push([key, value]); } });
  assert.deepStrictEqual(sent, [['User-Agent', 'RGBTv Player'], ['Referer', 'https://provider.example/']], 'per-stream annotations must be available to direct hls.js requests');
  native.hls[0].audioTracks = [{ lang: 'ar', name: 'Arabic' }, { lang: 'en', name: 'English' }]; native.hls[0].audioTrack = 1;
  native.player.action('p-audio'); native.nodes['track-menu'].children[0].onclick();
  assert.strictEqual(native.hls[0].audioTrack, 0, 'Audio manager switches only an exposed HLS audio track');
  assert.strictEqual(native.trackPrefs['live:' + stream.id].audio.key, 'ar', 'chosen exposed audio track is remembered per channel');

  /* The selected Shaka policy stays capability-gated and attaches its MSE pipeline
     to the exact same video element. It has no Shaka UI or second decoder. */
  var mse = playerHarness('probably', undefined, true);
  mse.settings.engine = 'shaka';
  await mse.player.play({ type: 'live', id: 'mse', name: 'Shaka HLS', url: stream.url, streamHeaders: stream.streamHeaders }); await flushPlayback();
  assert.strictEqual(mse.shaka.length, 1, 'Shaka is preferred for an HLS source only when MSE support is present');
  assert.strictEqual(mse.shaka[0].media, mse.video, 'Shaka reuses the stable HTML5 video surface');
  assert.strictEqual(mse.shaka[0].url, stream.url, 'Shaka retains the exact normalized provider URL');
  assert.strictEqual(mse.hls.length, 0, 'a successful Shaka selection does not eagerly create hls.js');
  var shakaHeaders = { uris: [stream.url], headers: {} };
  mse.shaka[0].networking.filter(0, shakaHeaders);
  assert.deepStrictEqual(shakaHeaders.headers, { 'User-Agent': 'RGBTv Player', Referer: 'https://provider.example/' }, 'same-source M3U headers reach Shaka requests');
  var cdnHeaders = { uris: ['https://cdn.example/segment.ts?signature=private'], headers: {} };
  mse.shaka[0].networking.filter(0, cdnHeaders);
  assert.deepStrictEqual(cdnHeaders.headers, {}, 'provider headers do not leak from a manifest to a signed CDN segment');
  assert.strictEqual(cdnHeaders.allowCrossSiteCredentials, false, 'a signed CDN segment never receives portal credentials');

  /* Custom M3U credentials reach their exact source origin only. A Shaka
     failure then performs the single hls.js handoff through the manager. */
  mse.context.App.provider = {
    type: 'm3u',
    resolveStream: function () { return Promise.resolve({ url: 'https://portal.example/live/1.m3u8', provider: 'm3u', channelId: 'portal', type: 'hls', headers: { Authorization: 'Bearer private', Referer: 'https://portal.example/' }, cookies: 'sid=private', metadata: { live: true } }); }
  };
  await mse.player.play({ type: 'live', id: 'portal', name: 'Portal HLS' }); await flushPlayback();
  assert.strictEqual(mse.shaka.length, 2, 'a second channel destroys the former Shaka instance before creating one replacement');
  assert.strictEqual(mse.shaka[0].destroyed, true, 'the previous Shaka instance is destroyed before channel replacement');
  var portalHeaders = { uris: ['https://portal.example/live/1.m3u8'], headers: {} };
  mse.shaka[1].networking.filter(0, portalHeaders);
  assert.deepStrictEqual(portalHeaders.headers, { Authorization: 'Bearer private', Referer: 'https://portal.example/' }, 'same-source M3U headers are retained for the resolved media URL');
  assert.strictEqual(portalHeaders.allowCrossSiteCredentials, true, 'same-source M3U requests may use the active browser credentials');
  var leakedPortalHeaders = { uris: ['https://edge-cdn.example/part.ts?signature=private'], headers: {} };
  mse.shaka[1].networking.filter(0, leakedPortalHeaders);
  assert.deepStrictEqual(leakedPortalHeaders.headers, {}, 'custom bearer headers never leak to a CDN origin');
  assert.strictEqual(leakedPortalHeaders.allowCrossSiteCredentials, false, 'source cookies never leak to a CDN origin');
  mse.shaka[1].emitError({ severity: 2, category: 3, code: 3016 }); await flushPlayback();
  assert.strictEqual(mse.hls.length, 1, 'one critical Shaka HLS failure falls back to hls.js through the central manager');
  assert.strictEqual(mse.hls[0].url, 'https://portal.example/live/1.m3u8', 'the fallback uses the same resolved M3U URL');
  var fallbackPortalHeaders = [], fallbackPortalXhr = { setRequestHeader: function (name, value) { fallbackPortalHeaders.push([name, value]); } };
  mse.hls[0].config.xhrSetup(fallbackPortalXhr, 'https://portal.example/live/1.m3u8');
  assert.deepStrictEqual(fallbackPortalHeaders, [['Authorization', 'Bearer private'], ['Referer', 'https://portal.example/']], 'the hls.js fallback retains headers only for the safe portal origin');
  assert.strictEqual(fallbackPortalXhr.withCredentials, true, 'the hls.js fallback retains cookies only for the safe portal origin');
  var fallbackCdnHeaders = [], fallbackCdnXhr = { setRequestHeader: function (name, value) { fallbackCdnHeaders.push([name, value]); } };
  mse.hls[0].config.xhrSetup(fallbackCdnXhr, 'https://edge-cdn.example/part.ts?signature=private');
  assert.deepStrictEqual(fallbackCdnHeaders, [], 'hls.js does not forward custom headers to a CDN segment');
  assert.strictEqual(!!fallbackCdnXhr.withCredentials, false, 'hls.js does not forward source cookies to a CDN segment');

  var route = 'https://edge.example/get.php?username=user&password=pass&output=m3u8';
  var extensionless = playerHarness('probably');
  await extensionless.player.play({ type: 'live', id: 'route', name: 'HLS token route', url: route });
  assert.strictEqual(extensionless.video.src, route, 'extensionless HLS still starts native-first');
  extensionless.video.error = { code: 2 };
  extensionless.emit('error');
  assert.strictEqual(extensionless.hls.length, 1, 'output=m3u8 HLS token routes must receive the fallback');
  assert.strictEqual(extensionless.hls[0].url, route);
  extensionless.hls[0].subtitleTracks = [{ lang: 'fr', name: 'French' }];
  extensionless.player.action('p-subs'); extensionless.nodes['track-menu'].children[1].onclick();
  assert.strictEqual(extensionless.hls[0].subtitleTrack, 0, 'Subtitle manager switches only an exposed HLS subtitle track');
  assert.strictEqual(extensionless.trackPrefs['live:route'].subs.key, 'fr', 'chosen subtitle track is remembered per channel');

  var noNativeHls = playerHarness('');
  await noNativeHls.player.play({ type: 'live', id: 'forced', name: 'No native HLS', url: route });
  assert.strictEqual(noNativeHls.hls.length, 1, 'devices without native HLS must choose hls.js for extensionless HLS routes');

  var transport = playerHarness('');
  var tsUrl = 'https://edge.example/live/transport.ts?token=unchanged';
  await transport.player.play({ type: 'live', id: 'ts', name: 'MPEG TS', url: tsUrl });
  assert.strictEqual(transport.video.src, tsUrl, 'MPEG-TS stays on the webOS native media path when selected');
  assert.strictEqual(transport.hls.length, 0, 'MPEG-TS is never forced through an HLS adapter');
  transport.player.action('p-ratio');
  assert.strictEqual(transport.video.className, 'fill', 'the active aspect mode applies without replacing the player');
  assert.strictEqual(transport.settings.aspectRatio, 'fill', 'the supported aspect preference is persisted');

  var recall = playerHarness('probably'), first = { type: 'live', id: 'a', name: 'Alpha', url: 'https://edge.example/a.ts' }, second = { type: 'live', id: 'b', name: 'Bravo', url: 'https://edge.example/b.ts' }, channels = [first, second];
  await recall.player.play(first, { list: channels, index: 0 });
  await recall.player.play(second, { list: channels, index: 1 });
  recall.player.action('p-recall'); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(recall.video.src, first.url, 'Recall returns to the previous live channel through the same manager/video instance');
}

(async function () {
  var parsed = parsePlaylist();
  await testM3UStreamContract(parsed);
  await testPlayerFallback(parsed);
  console.log('M3U playback regression checks passed');
})().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
