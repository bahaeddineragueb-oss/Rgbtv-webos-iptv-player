/* Settings migration checks for the visual system v2.8.
 * Run with: node tests/storage-design-migration.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var ROOT = __dirname + '/..';

function storeFor(settings, initial) {
  var values = initial || {};
  values['rgbtv:settings'] = JSON.stringify(settings);
  var localStorage = {
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null; },
    setItem: function (key, value) { values[key] = String(value); localStorage[key] = values[key]; },
    removeItem: function (key) { delete values[key]; delete localStorage[key]; }
  };
  Object.keys(values).forEach(function (key) { localStorage[key] = values[key]; });
  var context = { localStorage: localStorage, Date: Date, JSON: JSON, Object: Object, Array: Array, Math: Math, U: { randomMac: function () { return ''; }, sha1: function () { return ''; }, uuid: function () { return ''; } } };
  vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/storage.js', 'utf8'), context, { filename: 'storage.js' });
  return { Store: context.Store, raw: function () { return JSON.parse(values['rgbtv:settings']); }, has: function (key) { return Object.prototype.hasOwnProperty.call(values, key); } };
}

var oldGuide = storeFor({ theme: 'guidepro', layout: 'classic' });
assert.strictEqual(oldGuide.Store.settings().layout, 'guide', 'pre-v2.8 Guide Pro users keep their guide-first Home once');
assert.strictEqual(oldGuide.Store.settings().designSystemVersion, 2, 'migration marks the independent visual system');
oldGuide.Store.setSetting('layout', 'rail');
assert.strictEqual(oldGuide.raw().layout, 'rail', 'a migrated user can choose any new interface style');
assert.strictEqual(oldGuide.raw().designSystemVersion, 2, 'selection persists the migration marker');

var independent = storeFor({ theme: 'guidepro', layout: 'rail', designSystemVersion: 2 });
assert.strictEqual(independent.Store.settings().layout, 'rail', 'Guide Pro theme no longer overwrites an explicit interface choice');
var classic = storeFor({ theme: 'aurora', layout: 'classic' });
assert.strictEqual(classic.Store.settings().layout, 'classic', 'existing classic selection remains untouched');
var aliases = storeFor({ theme: 'astra', layout: 'guidefirst', designSystemVersion: 2 });
assert.strictEqual(aliases.Store.settings().layout, 'guide', 'guide-first aliases normalize to the canonical new ID');
var newInstall = storeFor({});
assert.strictEqual(newInstall.Store.settings().engine, 'shaka', 'new settings default to the selected capability-gated Shaka policy');
var oldEngine = storeFor({ engine: 'auto', designSystemVersion: 2 });
assert.strictEqual(oldEngine.Store.settings().engine, 'auto', 'an existing Auto preference stays native-first until the user changes it');


var profiles = storeFor({}, {
  'rgbtv:accounts': JSON.stringify([
    { id: 'x', type: 'xtream', name: 'Xtream', url: 'https://x.example', username: 'u', password: 'p' },
    { id: 'm', type: 'm3u', name: 'M3U', url: 'https://m.example/list.m3u' },
    { id: 'legacy', type: 'unsupported', name: 'Removed provider', url: 'https://old.example' }
  ]),
  'rgbtv:lastAccount': JSON.stringify('legacy'),
  'rgbtv:acc:legacy:favs': JSON.stringify([{ id: 'old-item' }]),
  'rgbtv:device': JSON.stringify({ id: 'obsolete' })
});
var retained = profiles.Store.accounts();
assert.strictEqual(retained.map(function (account) { return account.id; }).join(','), 'x,m', 'only Xtream and M3U profiles survive the profile migration');
assert.strictEqual(profiles.has('rgbtv:acc:legacy:favs'), false, 'removed-provider account data is cleared with its profile');
assert.strictEqual(profiles.Store.lastAccount(), null, 'a removed profile cannot stay selected for connection');
profiles.Store.settings();
assert.strictEqual(profiles.has('rgbtv:device'), false, 'obsolete device identity is removed during settings migration');

console.log('Settings and supported-profile migration checks passed');
