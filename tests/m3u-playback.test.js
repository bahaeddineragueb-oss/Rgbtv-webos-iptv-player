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
  return list;
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
  function Hls(config) { this.config = config; this.events = {}; hlsInstances.push(this); }
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
      toggleFav: function () { return false; }
    },
    App: { account: { id: 'test' }, isScreen: function () { return true; }, provider: { streamUrl: function (item) { return Promise.resolve(item.url); } } },
    UI: { toast: function () {}, toPlayable: function (item) { return item; } },
    Nav: { current: function () { return null; }, focus: function () {}, blur: function () {}, focusScope: function () {}, move: function () {}, KEYS: {} }
  };
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/player.js', 'utf8'), context, { filename: 'player.js' });
  context.Player.init();
  return { player: context.Player, video: video, emit: emit, hls: hlsInstances };
}

async function testPlayerFallback(parsed) {
  var stream = parsed[0];
  var native = playerHarness('probably');
  await native.player.play({ type: 'live', id: stream.id, name: stream.name, url: stream.url, streamHeaders: stream.streamHeaders });
  assert.strictEqual(native.video.src, stream.url, 'auto mode must keep the direct M3U channel on native webOS first');
  assert.strictEqual(native.hls.length, 0, 'native-capable webOS must not eagerly create an hls.js pipeline');
  native.video.error = { code: 4 };
  native.emit('error');
  assert.strictEqual(native.hls.length, 1, 'a rejected native HLS source must hand over once instead of beginning reconnects');
  assert.strictEqual(native.hls[0].url, stream.url, 'HLS fallback must retain the direct, stripped channel URL');
  var sent = [];
  native.hls[0].config.xhrSetup({ setRequestHeader: function (key, value) { sent.push([key, value]); } });
  assert.deepStrictEqual(sent, [['User-Agent', 'RGBTv Player'], ['Referer', 'https://provider.example/']], 'per-stream annotations must be available to direct hls.js requests');

  var route = 'https://edge.example/get.php?username=user&password=pass&output=m3u8';
  var extensionless = playerHarness('probably');
  await extensionless.player.play({ type: 'live', id: 'route', name: 'HLS token route', url: route });
  assert.strictEqual(extensionless.video.src, route, 'extensionless HLS still starts native-first');
  extensionless.video.error = { code: 2 };
  extensionless.emit('error');
  assert.strictEqual(extensionless.hls.length, 1, 'output=m3u8 HLS token routes must receive the fallback');
  assert.strictEqual(extensionless.hls[0].url, route);

  var noNativeHls = playerHarness('');
  await noNativeHls.player.play({ type: 'live', id: 'forced', name: 'No native HLS', url: route });
  assert.strictEqual(noNativeHls.hls.length, 1, 'devices without native HLS must choose hls.js for extensionless HLS routes');
}

(async function () {
  var parsed = parsePlaylist();
  await testPlayerFallback(parsed);
  console.log('M3U playback regression checks passed');
})().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
