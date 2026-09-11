/* Virtual-list capacity regression checks for large IPTV channel metadata.
 * Run with: node tests/vlist-large.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var ROOT = __dirname + '/..';

function classes() { var all = {}; return { add: function (n) { all[n] = true; }, remove: function (n) { delete all[n]; }, contains: function (n) { return !!all[n]; } }; }
function node(fragment) {
  var children = [], attrs = {};
  var out = { style: {}, classList: classes(), children: children, isFragment: !!fragment, className: '', _item: null,
    appendChild: function (child) {
      if (child && child.isFragment) { while (child.children.length) children.push(child.children.shift()); }
      else children.push(child);
      return child;
    },
    setAttribute: function (key, value) { attrs[key] = String(value); },
    getAttribute: function (key) { return attrs[key] || null; },
    querySelector: function (selector) { var match = /data-i="(\d+)"/.exec(selector); if (!match) return null; return children.filter(function (c) { return c.getAttribute && c.getAttribute('data-i') === match[1]; })[0] || null; }
  };
  Object.defineProperty(out, 'innerHTML', { get: function () { return ''; }, set: function () { children.splice(0, children.length); } });
  return out;
}

var current = null;
var context = {
  console: console, window: {},
  document: { createElement: function () { return node(false); }, createDocumentFragment: function () { return node(true); }, body: { contains: function () { return true; } } },
  U: { $$: function () { return []; } },
  App: { isScreen: function () { return false; } },
  Nav: { current: function () { return current; }, focus: function (el) { current = el; }, onKey: function () {} }
};
vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/vlist.js', 'utf8'), context, { filename: 'vlist.js' });

[1000, 5000, 10000, 23000, 50000].forEach(function (count) {
  var host = node(false); host.clientHeight = 528; // six normal Live TV rows
  var list = new context.VList({ container: host, itemH: 88, cols: 1, overscan: 2, render: function () { return node(false); } });
  var items = Array.from({ length: count }, function (_, i) { return { id: i, name: 'Channel ' + i }; });
  list.setItems(items);
  assert.strictEqual(list.items.length, count, 'logical metadata list retains all ' + count + ' requested records');
  assert.ok(list.inner.children.length <= 11, 'initial DOM window remains bounded at ' + count + ' records');
  list.focusIndex(count - 1);
  assert.strictEqual(list.index, count - 1, 'remote focus can reach final record at ' + count);
  assert.ok(list.inner.children.length <= 11, 'final DOM window remains bounded at ' + count + ' records');
  assert.ok(list.first > Math.max(0, count - 20), 'window is recycled near final record at ' + count);
});
console.log('VList large catalogue regression checks passed');
