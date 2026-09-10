/* Theme Engine contract regression checks: no browser, provider or video decoder required. */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function createRuntime() {
  const style = { values: {}, setProperty(k, v) { this.values[k] = v; } };
  const classes = new Set();
  const body = {
    style,
    attrs: {},
    classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; }
  };
  let saved = { theme: 'neon-cyber' };
  const context = {
    console,
    navigator: { hardwareConcurrency: 4, deviceMemory: 4 },
    document: { body, dispatchEvent() {} },
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init.detail; },
    Store: { settings() { return Object.assign({}, saved); }, setSetting(k, v) { saved[k] = v; } }
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('app/js/theme-engine.js', 'utf8'), context, { filename: 'theme-engine.js' });
  return { manager: context.ThemeManager, body, saved: () => Object.assign({}, saved) };
}

const runtime = createRuntime();
const manager = runtime.manager;
const requiredOfficial = ['neon-cyber', 'luxury-gold', 'arctic-glass', 'crimson-cinema', 'ocean-deep', 'retro-80s', 'emerald-nature', 'solar-orange', 'minimal-white', 'space-galaxy', 'glass-aurora', 'tactical-dark'];
const worlds = manager.getAvailableThemes();
assert.strictEqual(worlds.length, 14, 'the 12 official worlds plus the two explicitly preserved heritage worlds are registered');
assert.deepStrictEqual(Array.from(worlds.slice(0, 12), (x) => x.id), requiredOfficial, 'official Theme Registry order must stay stable');
assert.deepStrictEqual(Array.from(worlds.slice(12), (x) => x.id), ['ramadan', 'majlis'], 'only Ramadan and Majlis survive from the retired theme collection');
worlds.forEach((world) => assert.strictEqual(manager.validate(world), true, world.name + ' satisfies ThemeContract'));
const matrix = manager.getDifferentiationMatrix();
assert.strictEqual(matrix.length, worlds.length, 'the shipped anti-cloning matrix covers every available world');
const structuralFingerprints = new Set(matrix.map((world) => [world.navigation, world.card, world.player, world.epg, world.motion].join('|')));
assert.strictEqual(structuralFingerprints.size, worlds.length, 'every world has a unique structural differentiation fingerprint');
const themeCss = fs.readFileSync('app/css/theme-engine.css', 'utf8');
worlds.forEach((world) => assert.ok(themeCss.includes('body[data-theme="' + world.id + '"]'), world.name + ' has its own CSS layout/player integration'));
const retiredSelector = /data-theme="(?:dark|aurora|midnight|oled|ocean|crimson|emerald|sunset|royal|cinema|glass|arcade|mono|guidepro|receiver|sports|family|neocrt|cyberpunk)"/;
assert.strictEqual(retiredSelector.test(fs.readFileSync('app/css/style.css', 'utf8')), false, 'retired theme selectors do not leak from base CSS');
assert.strictEqual(manager.isThemeAvailable('cyberpunk'), false, 'retired IDs are not active themes');
assert.strictEqual(manager.setTheme('not-a-theme'), null, 'unknown themes safely refuse instead of producing an undefined visual state');
worlds.forEach((world) => { manager.setTheme(world.id); assert.strictEqual(manager.getTheme().id, world.id); assert.strictEqual(runtime.body.getAttribute('data-theme'), world.id); assert.ok(runtime.body.style.values['--rgb-focus'], world.name + ' supplies a visible focus token'); });
manager.resetTheme();
assert.strictEqual(manager.getTheme().id, 'neon-cyber');

const gold = manager.setTheme('luxury-gold');
assert.strictEqual(gold.id, 'luxury-gold');
assert.strictEqual(runtime.saved().theme, 'luxury-gold', 'apply persists without an application reload');
assert.strictEqual(runtime.body.getAttribute('data-theme'), 'luxury-gold');
assert.strictEqual(runtime.body.style.values['--rgb-accent'], '#d4ad62', 'semantic token is projected into the active DOM');
assert.strictEqual(runtime.body.style.values['--accent'], '#d4ad62', 'legacy component alias receives the semantic token');

manager.previewTheme('retro-80s');
assert.strictEqual(manager.getTheme().id, 'retro-80s', 'preview changes the visual world immediately');
assert.strictEqual(runtime.saved().theme, 'luxury-gold', 'preview never persists until Apply');
assert.strictEqual(manager.isPreviewing(), true);
manager.cancelPreview();
assert.strictEqual(manager.getTheme().id, 'luxury-gold', 'cancel restores the previous persisted world');
assert.strictEqual(manager.isPreviewing(), false);
manager.previewTheme('arctic-glass');
manager.commitPreview();
assert.strictEqual(runtime.saved().theme, 'arctic-glass', 'committing a preview persists its active world');
manager.resetTheme();
assert.strictEqual(manager.getTheme().id, 'neon-cyber');
assert.strictEqual(runtime.saved().theme, 'neon-cyber');
console.log('Theme Engine contract regression checks passed');
