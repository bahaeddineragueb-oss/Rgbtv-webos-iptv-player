/* Xtream live source contract regression check.
 * Run with: node tests/xtream-stream-contract.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var ROOT = __dirname + '/..';
var context = {
  Promise: Promise,
  U: { normUrl: function (value) { return String(value).replace(/\/$/, ''); }, qs: function (obj) { return Object.keys(obj).map(function (key) { return key + '=' + obj[key]; }).join('&'); }, b64dec: function (value) { return value; }, getJSON: function () { return Promise.resolve({}); }, pad: function (n) { return n < 10 ? '0' + n : String(n); } },
  Store: { settings: function () { return { liveFormat: 'm3u8' }; }, cacheGet: function () { return null; }, cacheSet: function () {} }
};
vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/api/xtream.js', 'utf8'), context, { filename: 'xtream.js' });
(async function () {
  var provider = new context.XtreamProvider({ id: 'x', url: 'https://panel.example', username: 'account', password: 'secret' });
  provider.userInfo = { allowed_output_formats: ['m3u8', 'ts'] };
  var stream = await provider.resolveStream({ type: 'live', id: '42', name: 'News' });
  assert.strictEqual(stream.provider, 'xtream');
  assert.strictEqual(stream.channelId, '42');
  assert.strictEqual(stream.url, 'https://panel.example/live/account/secret/42.m3u8');
  assert.strictEqual(stream.metadata.live, true);
  console.log('Xtream stream contract regression checks passed');
})().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
