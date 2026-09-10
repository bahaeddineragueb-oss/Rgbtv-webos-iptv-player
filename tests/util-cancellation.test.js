/* Browser XHR cancellation/status propagation regression checks.
 * Run with: node tests/util-cancellation.test.js */
'use strict';
var assert = require('assert');
var fs = require('fs');
var vm = require('vm');
var ROOT = __dirname + '/..';
var requests = [];
function FakeXHR() { this.readyState = 0; this.status = 0; this.responseText = ''; this.headers = {}; requests.push(this); }
FakeXHR.prototype.open = function () {};
FakeXHR.prototype.setRequestHeader = function (key, value) { this.headers[key] = value; };
FakeXHR.prototype.getAllResponseHeaders = function () { return this.responseHeaders || ''; };
FakeXHR.prototype.send = function () { this.sent = true; };
FakeXHR.prototype.abort = function () { this.aborted = true; };
var context = {
  Promise: Promise, XMLHttpRequest: FakeXHR, AbortController: AbortController,
  window: { addEventListener: function () {} }, document: { getElementById: function () { return null; }, documentElement: { clientWidth: 0, clientHeight: 0, style: { setProperty: function () {} } }, body: { classList: { contains: function () { return false; } } } },
  setTimeout: setTimeout, clearTimeout: clearTimeout, Math: Math, Date: Date, unescape: unescape, encodeURIComponent: encodeURIComponent
};
vm.runInNewContext(fs.readFileSync(ROOT + '/app/js/util.js', 'utf8'), context, { filename: 'util.js' });
(async function () {
  var controller = new AbortController();
  var pending = context.U.http('https://portal.example/slow', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, function (error) { return error.name === 'AbortError' && error.code === 'USER_CANCELLED'; });
  assert.strictEqual(requests[0].aborted, true, 'XHR abort is invoked when the channel session is cancelled');

  var limited = context.U.http('https://portal.example/rate-limited', {}), xhr = requests[1];
  xhr.readyState = 4; xhr.status = 429; xhr.responseHeaders = 'Retry-After: 2\r\nX-Trace: fixture\r\n'; xhr.onreadystatechange();
  await assert.rejects(limited, function (error) {
    return error.status === 429 && error.response && error.response.headers['retry-after'] === '2';
  });
  console.log('Utility cancellation/status regression checks passed');
})().catch(function (error) { console.error(error.stack || error); process.exitCode = 1; });
