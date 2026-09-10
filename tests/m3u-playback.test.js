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
function playerHarness(canPlayType) {
  var nodes = {}, handlers = {}, intervals = [], hlsInstances = [];
  var video = element();
  video.paused = false; video.ended = false; video.readyState = 0; video.currentTime = 0; video.duration = NaN;
  video.videoWidth = 0; video.videoHeight = 0; video.buffered = { length: 0 };
  video.canPlayType = function () { return canPlayType; };
  video.play = function () { video.paused = false; return Promise.resolve(); };
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

  var settingValues = { engine: 'auto', pictureMode: 'original', pictureBrightness: 100, pictureContrast: 100, pictureSaturation: 100, pictureTone: 0, pictureBlackLevel: 0, pictureGamma: 0 };
  var context = {
    console: console, Promise: Promise, Hls: Hls,
    window: { Hls: Hls, addEventListener: function () {} },
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
    App: { account: { id: 'test' }, isScreen: function () { return true; }, provider: { streamUrl: function (item) { return Promise.resolve(item.url); }, shortEPG: function () { var now = Math.floor(Date.now() / 1000); return Promise.resolve([{ start: now - 300, end: now + 3300, title: 'Live fixture' }, { start: now + 3300, end: now + 6900, title: 'Next fixture' }]); } } },
    UI: { toast: function () {}, toPlayable: function (item) { return item; } },
    Nav: { current: function () { return null; }, focus: function () {}, blur: function () {}, focusScope: function () {}, move: function () {}, KEYS: {} }
  };
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/playback-manager.js', 'utf8'), context, { filename: 'playback-manager.js' });
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/player.js', 'utf8'), context, { filename: 'player.js' });
  context.Player.init();
  return { player: context.Player, video: video, emit: emit, hls: hlsInstances, nodes: nodes, trackPrefs: trackPrefs, settings: settingValues };
}

async function testM3UStreamContract(parsed) {
  var stream = await parsed.provider.resolveStream(parsed.list[0]);
  assert.strictEqual(stream.provider, 'm3u');
  assert.strictEqual(stream.channelId, parsed.list[0].id);
  assert.strictEqual(stream.url, parsed.list[0].url, 'normalized M3U contract retains the exact original stream URL');
  assert.deepStrictEqual(Object.assign({}, stream.headers), Object.assign({}, parsed.list[0].streamHeaders));
}

async function testRemoteUiPath() {
  var h = playerHarness('probably'), list = [];
  for (var i = 1; i <= 105; i++) list.push({ type: 'live', id: 'remote-' + i, num: i, name: 'Channel ' + i, catName: 'News', url: 'https://stream.example/remote-' + i + '.m3u8' });
  await h.player.play(list[0], { list: list, index: 0 }); h.emit('playing');
  h.player.handleKey('CH_UP', 33); await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(h.video.src, list[1].url, 'CH+ switches only to the adjacent cached channel through the central player path');
  assert.strictEqual(h.nodes['zap-preview'].classList.contains('show'), true, 'CH+ displays a compact channel zapper without waiting for EPG');
  h.player.handleKey(null, 49); h.player.handleKey(null, 48); h.player.handleKey(null, 53);
  assert.ok(/105/.test(h.nodes['zap-preview'].innerHTML), 'numeric remote input provides immediate visual feedback for channel 105');
  h.player.handleKey('LEFT', 37);
  assert.strictEqual(h.nodes.osd.classList.contains('show'), true, 'a direction key only opens controls when the overlay is hidden');
  h.player.handleKey('BACK', 461);
  assert.strictEqual(h.nodes.osd.classList.contains('show'), true, 'BACK first cancels pending numeric entry without interrupting playback');
  h.player.handleKey('BACK', 461);
  assert.strictEqual(h.nodes.osd.classList.contains('show'), false, 'BACK then hides the player overlay before leaving playback');
}

async function testPlayerFallback(parsed) {
  var stream = parsed.list[0];
  var native = playerHarness('probably');
  await native.player.play({ type: 'live', id: stream.id, name: stream.name, url: stream.url, streamHeaders: stream.streamHeaders });
  assert.strictEqual(native.nodes['player-transition'].classList.contains('show'), true, 'channel handoff presents a transition layer instead of a featureless black frame');
  assert.strictEqual(native.video.src, stream.url, 'auto mode must keep the direct M3U channel on native webOS first');
  assert.strictEqual(native.hls.length, 0, 'native-capable webOS must not eagerly create an hls.js pipeline');
  native.emit('playing');
  assert.strictEqual(native.nodes['player-transition'].classList.contains('show'), false, 'transition layer clears exactly when playback starts');
  native.player.handleKey('UP', 38);
  assert.strictEqual(native.nodes.osd.classList.contains('show'), true, 'a direction key first reveals the remote overlay without zapping the channel');
  native.player.action('p-mute');
  assert.strictEqual(native.video.muted, true, 'mute is routed through the player controller and never replaces the active source');
  native.player.action('p-volume');
  assert.strictEqual(native.video.muted, false, 'volume feedback unmutes through the controller without a playback reload');
  assert.ok(native.video.volume > 0, 'the persisted stream volume is applied to the stable media element');
  native.player.action('p-settings');
  assert.strictEqual(native.nodes['player-panel'].classList.contains('show'), true, 'settings opens as an in-player panel over the stable video');
  native.player.handleKey('BACK', 461);
  assert.strictEqual(native.nodes['player-panel'].classList.contains('show'), false, 'BACK closes the in-player settings panel before exiting playback');
  native.player.action('p-epg'); await Promise.resolve();
  assert.ok(/Live fixture/.test(native.nodes['player-panel-content'].innerHTML), 'in-player EPG is populated asynchronously without changing the video source');
  native.player.handleKey('BACK', 461);
  native.video.error = { code: 4 };
  native.emit('error');
  assert.strictEqual(native.hls.length, 1, 'a rejected native HLS source must hand over once instead of beginning reconnects');
  assert.strictEqual(native.hls[0].url, stream.url, 'HLS fallback must retain the direct, stripped channel URL');
  var sent = [];
  native.hls[0].config.xhrSetup({ setRequestHeader: function (key, value) { sent.push([key, value]); } });
  assert.deepStrictEqual(sent, [['User-Agent', 'RGBTv Player'], ['Referer', 'https://provider.example/']], 'per-stream annotations must be available to direct hls.js requests');
  native.hls[0].audioTracks = [{ lang: 'ar', name: 'Arabic' }, { lang: 'en', name: 'English' }]; native.hls[0].audioTrack = 1;
  native.hls[0].levels = [{ height: 720, bitrate: 2000000 }, { height: 1080, bitrate: 4000000 }]; native.hls[0].currentLevel = -1;
  native.player.action('p-settings');
  assert.ok(/p\.quality/.test(native.nodes['player-panel-content'].innerHTML), 'Quality is exposed only after real adaptive HLS variants are reported');
  assert.strictEqual(native.player.setQuality(1), true, 'the controller accepts only a real reported adaptive level');
  assert.strictEqual(native.hls[0].currentLevel, 1);
  native.player.action('p-audio'); native.nodes['track-menu'].children[0].onclick();
  assert.strictEqual(native.hls[0].audioTrack, 0, 'Audio manager switches only an exposed HLS audio track');
  assert.strictEqual(native.trackPrefs['live:' + stream.id].audio.key, 'ar', 'chosen exposed audio track is remembered per channel');

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
  await testRemoteUiPath();
  await testPlayerFallback(parsed);
  console.log('M3U playback regression checks passed');
})().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
