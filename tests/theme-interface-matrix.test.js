/* Visual system structural regression checks.
 * Run with: node tests/theme-interface-matrix.test.js
 * These tests are intentionally DOM/network free: visual styles must never
 * create a provider request or alter the playback contract. */
'use strict';
var assert = require('assert');
var fs = require('fs');
var ROOT = __dirname + '/..';
var index = fs.readFileSync(ROOT + '/app/index.html', 'utf8');
var app = fs.readFileSync(ROOT + '/app/js/app.js', 'utf8');
var css = fs.readFileSync(ROOT + '/app/css/theme-interface-suite.css', 'utf8');
var docs = fs.readFileSync(ROOT + '/docs/design-system-v2.8.md', 'utf8');
var themes = ['astra', 'receiverpro', 'liquidglass', 'livepulse', 'noormajlis'];
var interfaces = ['rail', 'command', 'guide', 'spotlight', 'mosaic'];

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function countBraces(s) { var n = 0, i; for (i = 0; i < s.length; i++) { if (s.charAt(i) === '{') n++; if (s.charAt(i) === '}') n--; assert.ok(n >= 0, 'CSS has no premature closing brace at character ' + i); } return n; }

assert.ok(index.indexOf('css/theme-interface-suite.css') > index.indexOf('css/theme-signatures.css'), 'final interface suite is loaded after prior theme contracts');
assert.strictEqual(countBraces(css), 0, 'final interface suite has balanced blocks');
assert.ok(/document\.body\.setAttribute\('data-interface', s\.layout \|\| 'classic'\)/.test(app), 'UI controller persists interface geometry separately from the theme');
assert.ok(/function isHub\(lay\) \{ return INTERFACE_IDS\.indexOf\(lay\) >= 0 && lay !== 'guide' && lay !== 'classic'; \}/.test(app), 'registered interface styles, not themes, decide Home architecture');
assert.ok(/if \(lay === 'guide'\) \{ renderGuideHome\(\); return; \}/.test(app), 'Guide First is selected by interface style');
assert.strictEqual(/Store\.settings\(\)\.theme === 'guidepro'/.test(app), false, 'Guide Pro theme no longer redirects Home');
assert.ok(/else if \(Store\.settings\(\)\.layout === 'guide'\) openGuide\(\)/.test(app), 'guide action follows the interface selection, not a theme');

themes.forEach(function (theme) {
  assert.ok(index.indexOf('data-theme-pick="' + theme + '"') >= 0, theme + ' is selectable in Settings');
  assert.ok(new RegExp("'" + esc(theme) + "'").test(app), theme + ' is known by theme cycling');
  assert.ok(css.indexOf('body[data-theme="' + theme + '"]') >= 0, theme + ' has a standalone visual contract');
  assert.ok(docs.indexOf('`' + theme + '`') >= 0, theme + ' is documented');
});
interfaces.forEach(function (layout) {
  assert.ok(index.indexOf('data-layout-pick="' + layout + '"') >= 0, layout + ' is selectable in Settings');
  assert.ok(new RegExp("'" + esc(layout) + "'").test(app), layout + ' is known by controller state');
  assert.ok(css.indexOf('body[data-interface="' + layout + '"]') >= 0, layout + ' has an authoritative geometry contract');
  assert.ok(docs.indexOf('`' + layout + '`') >= 0, layout + ' is documented');
});

/* A theme section which never checks data-interface plus an interface section
   which never checks data-theme proves every requested pairing is valid rather
   than hand-wiring only a favoured five combinations. */
var split = css.indexOf('/* All new interface styles');
assert.ok(split > 0, 'stylesheet explicitly separates the two axes');
function withoutComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ''); }
var themeCss = withoutComments(css.substring(0, split)), interfaceCss = withoutComments(css.substring(split));
assert.strictEqual(themeCss.indexOf('data-interface'), -1, 'theme layer contains no layout-specific rule');
assert.strictEqual(interfaceCss.indexOf('data-theme'), -1, 'interface layer contains no theme-specific rule');
themes.forEach(function (theme) {
  interfaces.forEach(function (layout) {
    assert.ok(themeCss.indexOf('body[data-theme="' + theme + '"]') >= 0 && interfaceCss.indexOf('body[data-interface="' + layout + '"]') >= 0, theme + ' × ' + layout + ' resolves through independent contracts');
  });
});

['classic', 'trio', 'dashboard'].forEach(function (legacy) {
  assert.ok(index.indexOf('data-layout-pick="' + legacy + '"') >= 0, 'saved ' + legacy + ' style remains selectable');
});
['rail', 'command', 'spotlight', 'mosaic'].forEach(function (hub) { assert.ok(css.indexOf('body.hub-root[data-interface="' + hub + '"]') >= 0, 'legacy theme geometry is overridden for ' + hub + ' Home'); });
assert.ok(css.indexOf('body.rtl[data-interface="rail"]') >= 0 && css.indexOf('body.rtl[data-interface="guide"]') >= 0, 'RTL mirrors side-rail interfaces');
assert.ok(css.indexOf('body.high-contrast[data-interface]') >= 0, 'high-contrast focus is retained across interface styles');
assert.ok(css.indexOf('body.large[data-interface="rail"]') >= 0, 'large UI receives rail-specific readable labels');
console.log('Theme × interface matrix structural checks passed (25 requested combinations)');
