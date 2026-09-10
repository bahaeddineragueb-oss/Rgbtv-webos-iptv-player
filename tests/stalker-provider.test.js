/* Stalker / Ministra progressive catalogue regression tests.
 * Run with: node tests/stalker-provider.test.js
 * Fixture replies imitate documented portal envelope variants only; no fixture
 * channel is part of the application catalogue. */
'use strict';

var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
var vm = require('vm');
var ROOT = __dirname + '/..';

function qs(params) {
  return Object.keys(params || {}).map(function (key) { return encodeURIComponent(key) + '=' + encodeURIComponent(params[key]); }).join('&');
}
function actionOf(url) { return new URL(url).searchParams.get('action'); }
function pageOf(url) { return Number(new URL(url).searchParams.get('p') || 1); }
function freshProvider(reply, accountPatch) {
  var calls = [], cache = {}, getJSON = reply || function () { return Promise.resolve({ data: { js: { data: [] } }, status: 200, headers: {} }); };
  var context = {
    console: console, Promise: Promise, Date: Date, setInterval: function () { return 1; }, clearInterval: function () {},
    window: {},
    I18n: { t: function (key) { return key; } },
    Store: {
      cacheGet: function (id, key) { return cache[id + ':' + key] || null; },
      cacheSet: function (id, key, value) { cache[id + ':' + key] = value; },
      device: function () { return { serial: 'fixture-device' }; },
      updateAccount: function () {}
    },
    U: {
      normUrl: function (value) { return String(value).replace(/\/$/, ''); },
      randomMac: function () { return '00:1A:79:11:22:33'; },
      uuid: function () { return 'fixture-uuid'; },
      sha1: function (value) { return crypto.createHash('sha1').update(String(value)).digest('hex').toUpperCase(); },
      qs: qs,
      getJSON: function (url, headers, opt) { calls.push({ url: url, headers: headers, opt: opt }); return getJSON(url, headers, opt, calls.length); }
    }
  };
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/api/stalker.js', 'utf8'), context, { filename: 'stalker.js' });
  var account = { id: 'stalker-test', url: 'https://portal.example/stalker_portal/server/load.php', mac: '00:1A:79:AA:BB:CC' }, key;
  for (key in accountPatch || {}) account[key] = accountPatch[key];
  var provider = new context.StalkerProvider(account);
  provider.endpoint = 'https://portal.example/stalker_portal/server/load.php';
  provider.base = 'https://portal.example';
  provider.token = 'fixture-token';
  return { provider: provider, calls: calls, context: context };
}
function meta(body, headers) { return { data: body, status: 200, headers: headers || {} }; }
function channel(id, name) { return { id: id, name: name || ('Channel ' + id), number: id, tv_genre_id: '7', cmd: 'ffmpeg http://stream.example/' + id, logo: 'logo' + id + '.png' }; }

async function testEnvelopeVariantsAndNormalizer() {
  var direct = freshProvider(null, { url: 'https://portal.example/c/portal.php?device=test' });
  assert.strictEqual(direct.provider.base, 'https://portal.example', 'direct /c/portal.php normalizes its common-root base');
  assert.strictEqual(direct.provider.endpoints[0], 'https://portal.example/c/portal.php', 'a user-provided direct endpoint is tried before endpoint discovery');
  var variants = [
    { js: { data: [channel(1, 'One')], total_items: 1, max_page_items: 1 } },
    { channels: [channel(2, 'Deux')], total: 1, page_size: 1 },
    { items: [channel(3, 'ثلاثة')], total_count: 1, per_page: 1 },
    [channel(4, 'Bare Array')],
    { data: { result: { items: [channel(5, 'Nested')], recordsTotal: 1, limit: 1 } } }
  ];
  for (var i = 0; i < variants.length; i++) {
    var h = freshProvider((function (reply) { return function () { return Promise.resolve(meta(reply)); }; })(variants[i]));
    var page = await h.provider.livePage(null, 1);
    assert.strictEqual(page.items.length, 1, 'must find a channel array in envelope variant ' + i);
    assert.ok(page.items[0].id, 'channel must retain/derive a stable key');
    assert.ok(page.items[0].name, 'channel must remain visible when optional metadata differs');
    assert.strictEqual(h.calls.length, 1, 'one page must use one request');
  }
  var map = freshProvider();
  var missingOptional = map.provider._mapLiveChannel({ ch_id: 99, title: 'No logo/genre/cmd' }, null, 1);
  assert.strictEqual(missingOptional.id, '99');
  assert.strictEqual(missingOptional.name, 'No logo/genre/cmd');
  assert.strictEqual(missingOptional.logo, '');
}

async function testOnePageForLargeCatalogues() {
  var totals = [1000, 5000, 10000, 23000, 50000];
  for (var i = 0; i < totals.length; i++) {
    var total = totals[i];
    var h = freshProvider(function (url) {
      assert.strictEqual(actionOf(url), 'get_ordered_list');
      assert.strictEqual(new URL(url).searchParams.get('genre'), '*', 'All Channels uses the server wildcard');
      return Promise.resolve(meta({ js: { data: [channel(1), channel(2)], total_items: total, max_page_items: 100 } }));
    });
    var page = await h.provider.livePage(null, 1);
    assert.strictEqual(page.items.length, 2);
    assert.strictEqual(page.total, total);
    assert.strictEqual(page.hasMore, true);
    assert.strictEqual(h.calls.length, 1, total + ' channels must not trigger a full-library request for page one');
    assert.strictEqual(actionOf(h.calls[0].url), 'get_ordered_list');
  }
}

async function testPaginationAndExplicitLegacyFallback() {
  var h = freshProvider(function (url) {
    var action = actionOf(url), p = pageOf(url);
    if (action === 'get_ordered_list') return Promise.resolve(meta({ js: { data: [channel(p * 10 + 1), channel(p * 10 + 2)], total_items: 23000, max_page_items: 2 } }));
    throw new Error('unexpected ' + action);
  });
  var first = await h.provider.livePage('7', 1), second = await h.provider.livePage('7', 2);
  assert.strictEqual(new URL(h.calls[0].url).searchParams.get('genre'), '7', 'category is server-filtered through genre');
  assert.strictEqual(first.items[0].id, '11');
  assert.strictEqual(second.items[0].id, '21');
  assert.strictEqual(h.calls.length, 2);

  var fallback = freshProvider(function (url) {
    if (actionOf(url) === 'get_ordered_list') return Promise.resolve(meta({ js: { error: 'Unknown action get_ordered_list' } }));
    if (actionOf(url) === 'get_all_channels') return Promise.resolve(meta({ js: { channels: [channel(31), channel(32)] } }));
    throw new Error('unexpected action');
  });
  var legacy = await fallback.provider.livePage(null, 1);
  assert.strictEqual(legacy.legacy, true, 'full endpoint is a compatibility fallback only after explicit rejection');
  assert.strictEqual(legacy.items.length, 2, 'legacy envelope must be normalized too');
  assert.deepStrictEqual(fallback.calls.map(function (c) { return actionOf(c.url); }), ['get_ordered_list', 'get_all_channels']);

  var empty = freshProvider(function () { return Promise.resolve(meta({ js: { data: [], total_items: 0, max_page_items: 100 } })); });
  var blank = await empty.provider.livePage('empty', 1);
  assert.strictEqual(blank.items.length, 0);
  assert.strictEqual(empty.calls.length, 1, 'a real empty genre must never fall back to get_all_channels');
}

async function testQueueDedupe429AndSingleRefresh() {
  var release, active = 0, maxActive = 0, h = freshProvider(function (url) {
    active++; maxActive = Math.max(maxActive, active);
    return new Promise(function (resolve) { release = function () { active--; resolve(meta({ js: { data: [] } })); }; });
  });
  var sameA = h.provider._call({ type: 'itv', action: 'get_ordered_list', p: 1 });
  var sameB = h.provider._call({ type: 'itv', action: 'get_ordered_list', p: 1 });
  assert.strictEqual(sameA, sameB, 'identical in-flight portal calls are shared');
  await Promise.resolve();
  assert.strictEqual(h.calls.length, 1);
  release(); await sameA;
  assert.strictEqual(maxActive, 1, 'provider has one serialized portal request at a time');

  var limited = freshProvider(function () { return Promise.reject(new Error('HTTP 429')); });
  await assert.rejects(function () { return limited.provider._call({ type: 'itv', action: 'get_ordered_list', p: 1 }); }, /provider\.http429/);
  assert.strictEqual(limited.calls.length, 1, 'a 429 never starts an extra handshake/retry burst');

  var phases = [], refresh = freshProvider(function (url, headers) {
    var action = actionOf(url); phases.push(action);
    if (action === 'get_ordered_list' && phases.filter(function (x) { return x === action; }).length === 1) return Promise.reject(new Error('HTTP 401'));
    if (action === 'handshake') return Promise.resolve(meta({ js: { token: 'fresh-token' } }, { 'set-cookie': 'sid=abc123; Path=/; HttpOnly' }));
    assert.strictEqual(headers.Cookie.indexOf('sid=abc123') >= 0, true, 'renewed request receives in-memory portal session cookie');
    return Promise.resolve(meta({ js: { data: [channel(77)], total_items: 1, max_page_items: 1 } }));
  });
  var renewed = await refresh.provider.livePage(null, 1);
  assert.strictEqual(renewed.items.length, 1);
  assert.strictEqual(refresh.provider.token, 'fresh-token');
  assert.deepStrictEqual(phases, ['get_ordered_list', 'handshake', 'get_ordered_list'], 'expired token gets exactly one handshake and exactly one retry');
}

async function testStalkerStreamContract() {
  var h = freshProvider(function (url) {
    assert.strictEqual(actionOf(url), 'create_link');
    return Promise.resolve(meta({ js: { cmd: 'ffmpeg https://stream.example/live.m3u8?token=private' } }));
  });
  var resolved = await h.provider.resolveStream({ type: 'live', id: 'stalker-live', name: 'Stalker Live', cmd: 'ffmpeg http://old.example/live' });
  assert.strictEqual(resolved.provider, 'stalker');
  assert.strictEqual(resolved.channelId, 'stalker-live');
  assert.strictEqual(resolved.url, 'https://stream.example/live.m3u8?token=private');
}

async function testLoadedIndexSearch() {
  var h = freshProvider();
  h.provider._rememberAllLive([
    h.provider._mapLiveChannel(channel('101', 'France Évasion'), null, 1),
    h.provider._mapLiveChannel(channel('202', 'الأخبار العربية'), null, 2),
    h.provider._mapLiveChannel(channel('303', 'English News'), null, 3)
  ]);
  h.provider._allLive.complete = true;
  assert.strictEqual((await h.provider.searchLive('evasion')).length, 1, 'French accent-insensitive search uses local index');
  assert.strictEqual((await h.provider.searchLive('الاخبار')).length, 1, 'Arabic hamza-insensitive search uses local index');
  assert.strictEqual((await h.provider.searchLive('303')).length, 1, 'channel identifiers are searchable');
  assert.strictEqual(h.calls.length, 0, 'loaded index search makes no catalogue network call');
}

(async function () {
  await testEnvelopeVariantsAndNormalizer();
  await testOnePageForLargeCatalogues();
  await testPaginationAndExplicitLegacyFallback();
  await testQueueDedupe429AndSingleRefresh();
  await testStalkerStreamContract();
  await testLoadedIndexSearch();
  console.log('Stalker progressive catalogue regression checks passed');
})().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
