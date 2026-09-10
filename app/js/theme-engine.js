/* RGBTv Theme Engine — presentation-only registry for instant, persistent theme worlds. */
var ThemeManager = (function () {
  'use strict';

  var DEFAULT_THEME = 'neon-cyber';
  var activeId = null;
  var previewBaseId = null;
  var REQUIRED = ['id', 'name', 'description', 'category', 'tokens', 'typography', 'navigation', 'cards', 'player', 'epg', 'animations', 'performanceLevel'];
  var TOKEN_NAMES = ['--rgb-bg', '--rgb-bg-alt', '--rgb-surface', '--rgb-surface-elevated', '--rgb-surface-glass', '--rgb-text', '--rgb-text-secondary', '--rgb-text-muted', '--rgb-accent', '--rgb-accent-secondary', '--rgb-focus', '--rgb-success', '--rgb-warning', '--rgb-error', '--rgb-border', '--rgb-shadow', '--rgb-radius-small', '--rgb-radius-medium', '--rgb-radius-large', '--rgb-card-radius', '--rgb-button-radius', '--rgb-spacing', '--rgb-transition-fast', '--rgb-transition-normal', '--rgb-transition-slow', '--rgb-glow', '--rgb-blur'];

  function theme(id, name, description, category, tokens, typography, navigation, cards, player, epg, animations, performanceLevel, identity) {
    return {
      id: id, name: name, description: description, category: category,
      visualIdentity: identity,
      tokens: tokens, typography: typography, navigation: navigation, cards: cards,
      player: player, epg: epg, animations: animations, performanceLevel: performanceLevel,
      density: navigation.density || 'comfortable', layoutMode: navigation.layout, visualEffects: tokens.background
    };
  }
  function T(bg, alt, surface, elevated, glass, text, secondary, muted, accent, accent2, focus, border, shadow, rs, rm, rl, cr, br, spacing, glow, blur, background) {
    return {
      '--rgb-bg': bg, '--rgb-bg-alt': alt, '--rgb-surface': surface, '--rgb-surface-elevated': elevated,
      '--rgb-surface-glass': glass, '--rgb-text': text, '--rgb-text-secondary': secondary, '--rgb-text-muted': muted,
      '--rgb-accent': accent, '--rgb-accent-secondary': accent2, '--rgb-focus': focus,
      '--rgb-success': '#51c98a', '--rgb-warning': '#f5bd45', '--rgb-error': '#ec6d77', '--rgb-border': border,
      '--rgb-shadow': shadow, '--rgb-radius-small': rs, '--rgb-radius-medium': rm, '--rgb-radius-large': rl,
      '--rgb-card-radius': cr, '--rgb-button-radius': br, '--rgb-spacing': spacing,
      '--rgb-transition-fast': '120ms', '--rgb-transition-normal': '220ms', '--rgb-transition-slow': '460ms',
      '--rgb-glow': glow, '--rgb-blur': blur, background: background
    };
  }

  /* Differentiation matrix: each record deliberately combines a distinct metaphor,
     navigation layout, geometry, card treatment, player mode and motion language. */
  var REGISTRY = [
    theme('neon-cyber', 'Neon Cyber', 'Digital entertainment HUD · luminous angular signal grid', 'Official',
      T('#05070d', '#0b1120', '#0b1220', '#121d31', 'rgba(5,13,26,.76)', '#ebfdff', '#b8d3e4', '#7190aa', '#27f3df', '#a855f7', '#6efff1', 'rgba(39,243,223,.45)', 'rgba(0,0,0,.72)', '2px', '6px', '12px', '7px', '4px', '18px', '0 0 24px rgba(39,243,223,.48)', '0px', 'scanline-grid'),
      { display: 'Orbitron, Rajdhani, "LG Smart UI", sans-serif', body: 'Rajdhani, "LG Smart UI", sans-serif', tracking: '.07em' },
      { layout: 'right-hud', variant: 'floating-sidebar', density: 'compact' }, { variant: 'angular-signal', ratio: 'mixed' }, { variant: 'hud', metadata: 'signal-stack' }, { variant: 'neon-grid', timeline: 'laser' }, { personality: 'digital', focus: 'pulse' }, 'HIGH', 'futuristic signal command deck'),
    theme('luxury-gold', 'Luxury Gold', 'Editorial cinema lounge · champagne detail and quiet refinement', 'Official',
      T('#121110', '#1c1a17', '#211e19', '#2b2720', 'rgba(29,26,21,.90)', '#fbf4e6', '#ded0b7', '#a89c86', '#d4ad62', '#f1d5a1', '#f5d48a', 'rgba(212,173,98,.42)', 'rgba(0,0,0,.56)', '5px', '13px', '24px', '16px', '14px', '28px', 'none', '0px', 'charcoal-linen'),
      { display: 'Georgia, "Times New Roman", serif', body: '"LG Smart UI", Georgia, serif', tracking: '.025em' },
      { layout: 'left-editorial', variant: 'vertical-rail', density: 'generous' }, { variant: 'editorial-poster', ratio: 'portrait' }, { variant: 'minimal-luxury', metadata: 'editorial-line' }, { variant: 'editorial-schedule', timeline: 'gold-rule' }, { personality: 'elegant', focus: 'slow-scale' }, 'MEDIUM', 'high-end hotel cinema'),
    theme('arctic-glass', 'Arctic Glass', 'Cold crystalline interface · ice planes and precise frosted geometry', 'Official',
      T('#dcebf3', '#c8dce8', 'rgba(242,250,255,.64)', 'rgba(255,255,255,.80)', 'rgba(230,247,255,.56)', '#142c42', '#31526a', '#5e7c90', '#287fae', '#70bce5', '#0d85ba', 'rgba(39,126,171,.34)', 'rgba(24,64,90,.20)', '2px', '10px', '20px', '11px', '9px', '24px', '0 10px 30px rgba(76,140,177,.18)', '14px', 'ice-facet'),
      { display: '"Trebuchet MS", "LG Smart UI", sans-serif', body: '"LG Smart UI", Arial, sans-serif', tracking: '.01em' },
      { layout: 'top-float', variant: 'frosted-dock', density: 'comfortable' }, { variant: 'crystal-panel', ratio: 'landscape' }, { variant: 'frosted', metadata: 'clean-columns' }, { variant: 'ice-grid', timeline: 'crystal-line' }, { personality: 'crystalline', focus: 'shimmer' }, 'HIGH', 'geometric winter observatory'),
    theme('crimson-cinema', 'Crimson Cinema', 'Dramatic theater · velvet darkness and cinematic poster focus', 'Official',
      T('#10090b', '#211013', '#241316', '#35191e', 'rgba(30,12,16,.92)', '#fff4ee', '#e7c9c0', '#ad8583', '#c9293b', '#ee765f', '#ff766b', 'rgba(201,41,59,.50)', 'rgba(0,0,0,.80)', '0px', '3px', '18px', '0px', '0px', '26px', '0 20px 50px rgba(0,0,0,.55)', '0px', 'theater-vignette'),
      { display: 'Georgia, "Times New Roman", serif', body: '"LG Smart UI", Arial, sans-serif', tracking: '.015em' },
      { layout: 'bottom-theater', variant: 'cinematic-ribbon', density: 'generous' }, { variant: 'dramatic-poster', ratio: 'portrait' }, { variant: 'cinematic', metadata: 'marquee' }, { variant: 'theater-timeline', timeline: 'crimson-curtain' }, { personality: 'cinematic', focus: 'reveal' }, 'MEDIUM', 'classic movie theater'),
    theme('ocean-deep', 'Ocean Deep', 'Calm underwater technology · fluid depth with wave-led hierarchy', 'Official',
      T('#041722', '#082a3a', '#0b3041', '#104258', 'rgba(5,37,50,.80)', '#edfaff', '#bfdce6', '#78a5b6', '#22b9c8', '#4cdbbd', '#65e0d4', 'rgba(80,208,217,.36)', 'rgba(0,14,22,.56)', '12px', '23px', '38px', '24px', '24px', '25px', '0 14px 36px rgba(0,12,22,.38)', '0px', 'deep-water'),
      { display: '"Trebuchet MS", "LG Smart UI", sans-serif', body: '"LG Smart UI", Arial, sans-serif', tracking: '.01em' },
      { layout: 'left-wave', variant: 'deep-floating-sidebar', density: 'comfortable' }, { variant: 'aquatic-layer', ratio: 'landscape' }, { variant: 'fluid', metadata: 'wave-bar' }, { variant: 'ocean-timeline', timeline: 'current' }, { personality: 'fluid', focus: 'drift' }, 'MEDIUM', 'immersive ocean depth'),
    theme('retro-80s', 'Retro 80s', 'VHS arcade television · chunky frames, synthwave and restrained scanlines', 'Official',
      T('#170d2d', '#2b174c', '#351957', '#4a246d', 'rgba(43,18,75,.90)', '#fff4fd', '#f3c8ee', '#c795cf', '#ff4fa3', '#2dc4ff', '#ffe566', 'rgba(255,79,163,.52)', 'rgba(0,0,0,.62)', '0px', '2px', '4px', '0px', '0px', '15px', '5px 5px 0 rgba(6,2,18,.75)', '0px', 'vhs-scanline'),
      { display: '"Arial Black", Impact, "LG Smart UI", sans-serif', body: '"Trebuchet MS", "LG Smart UI", sans-serif', tracking: '.04em' },
      { layout: 'bottom-arcade', variant: 'arcade-deck', density: 'compact' }, { variant: 'vhs-frame', ratio: 'mixed' }, { variant: 'arcade', metadata: 'rec-chip' }, { variant: 'retro-grid', timeline: 'pixel-line' }, { personality: 'retro', focus: 'arcade-jump' }, 'MEDIUM', 'synthwave broadcast arcade'),
    theme('emerald-nature', 'Emerald Nature', 'Organic premium forest · warm earth, quiet botanical rhythm', 'Official',
      T('#0b1710', '#142a19', '#1a3320', '#24452b', 'rgba(17,39,23,.88)', '#f4f2df', '#d9dfc1', '#a6b69b', '#5aa45c', '#b8c974', '#a8d978', 'rgba(113,173,92,.42)', 'rgba(0,0,0,.44)', '14px', '28px', '45px', '28px', '25px', '30px', '0 12px 26px rgba(0,0,0,.34)', '0px', 'botanical-shade'),
      { display: 'Georgia, "Times New Roman", serif', body: '"LG Smart UI", Arial, sans-serif', tracking: '.01em' },
      { layout: 'top-garden', variant: 'organic-top-rail', density: 'generous' }, { variant: 'soft-organic', ratio: 'landscape' }, { variant: 'natural', metadata: 'leaf-label' }, { variant: 'garden-schedule', timeline: 'vine' }, { personality: 'organic', focus: 'breathe' }, 'MEDIUM', 'premium organic forest'),
    theme('solar-orange', 'Solar Orange', 'Warm energetic entertainment · sunburst hierarchy and bold direction', 'Official',
      T('#121722', '#20253b', '#242b42', '#303c59', 'rgba(26,33,53,.90)', '#fff9ee', '#f1dfbd', '#bea987', '#ff8c24', '#ffd34e', '#ffba42', 'rgba(255,151,40,.48)', 'rgba(0,0,0,.48)', '4px', '13px', '25px', '14px', '12px', '19px', '0 12px 26px rgba(255,118,20,.20)', '0px', 'solar-ray'),
      { display: '"Arial Black", "LG Smart UI", sans-serif', body: '"LG Smart UI", Arial, sans-serif', tracking: '.015em' },
      { layout: 'left-energy', variant: 'bold-vertical', density: 'comfortable' }, { variant: 'accent-strip', ratio: 'mixed' }, { variant: 'energetic', metadata: 'bold-counter' }, { variant: 'sun-schedule', timeline: 'bright-path' }, { personality: 'energetic', focus: 'snap' }, 'LOW', 'sun-powered entertainment studio'),
    theme('minimal-white', 'Minimal White', 'Ultra-clean editorial operating system · whitespace and disciplined type', 'Official',
      T('#f6f6f3', '#ededE8', '#ffffff', '#fbfbf9', 'rgba(255,255,255,.92)', '#20231f', '#50554e', '#7b8178', '#20231f', '#6d7869', '#111311', 'rgba(30,35,30,.16)', 'rgba(35,39,33,.12)', '0px', '4px', '9px', '5px', '4px', '32px', '0 4px 12px rgba(25,28,23,.08)', '0px', 'paper'),
      { display: 'Arial, "Helvetica Neue", "LG Smart UI", sans-serif', body: 'Arial, "Helvetica Neue", "LG Smart UI", sans-serif', tracking: '-.01em' },
      { layout: 'top-minimal', variant: 'editorial-header', density: 'generous' }, { variant: 'clean-poster', ratio: 'portrait' }, { variant: 'minimal', metadata: 'quiet-type' }, { variant: 'editorial-table', timeline: 'graphite-rule' }, { personality: 'minimal', focus: 'quiet' }, 'LOW', 'premium minimal operating system'),
    theme('space-galaxy', 'Space Galaxy', 'Cosmic exploration · starfield depth and expansive orbital navigation', 'Official',
      T('#070b20', '#10123b', '#151743', '#22205a', 'rgba(14,16,51,.82)', '#f3f2ff', '#d0cef1', '#9494c3', '#8b70ff', '#df83ff', '#bea9ff', 'rgba(139,112,255,.42)', 'rgba(0,0,0,.70)', '16px', '26px', '42px', '25px', '24px', '28px', '0 0 36px rgba(114,90,255,.23)', '0px', 'starfield'),
      { display: 'Georgia, "Times New Roman", serif', body: '"Trebuchet MS", "LG Smart UI", sans-serif', tracking: '.035em' },
      { layout: 'right-orbit', variant: 'cosmic-rail', density: 'comfortable' }, { variant: 'atmospheric', ratio: 'landscape' }, { variant: 'cosmic', metadata: 'orbital-stack' }, { variant: 'constellation', timeline: 'star-path' }, { personality: 'atmospheric', focus: 'orbit' }, 'HIGH', 'deep space observatory'),
    theme('glass-aurora', 'Glass Aurora', 'Flowing northern lights · colorful atmospheric glass and soft light', 'Official',
      T('#0b1023', '#17204a', 'rgba(27,37,78,.54)', 'rgba(52,59,111,.63)', 'rgba(69,84,143,.46)', '#f8f8ff', '#deddf8', '#bab9df', '#7cf0dc', '#c279ff', '#f0b5ff', 'rgba(190,142,255,.42)', 'rgba(0,0,0,.48)', '18px', '31px', '48px', '30px', '28px', '24px', '0 14px 46px rgba(93,105,255,.27)', '18px', 'aurora-flow'),
      { display: '"Trebuchet MS", "LG Smart UI", sans-serif', body: '"LG Smart UI", Arial, sans-serif', tracking: '.015em' },
      { layout: 'bottom-glass', variant: 'aurora-dock', density: 'comfortable' }, { variant: 'layered-glass', ratio: 'mixed' }, { variant: 'glass', metadata: 'ambient-stack' }, { variant: 'aurora-grid', timeline: 'luminous-flow' }, { personality: 'flowing', focus: 'bloom' }, 'HIGH', 'colorful aurora glass lounge'),
    theme('tactical-dark', 'Tactical Dark', 'Precise command console · graphite data surfaces and lime status logic', 'Official',
      T('#0c0f10', '#151a1b', '#171d1e', '#202728', 'rgba(18,23,24,.96)', '#edf1e9', '#cbd2c8', '#879187', '#b4e653', '#6d9c42', '#d1ff70', 'rgba(180,230,83,.36)', 'rgba(0,0,0,.76)', '0px', '2px', '4px', '1px', '1px', '12px', 'none', '0px', 'tactical-grid'),
      { display: '"Arial Narrow", "Roboto Condensed", "LG Smart UI", sans-serif', body: '"Arial Narrow", "LG Smart UI", sans-serif', tracking: '.06em' },
      { layout: 'left-command', variant: 'tactical-sidebar', density: 'dense' }, { variant: 'technical-cell', ratio: 'landscape' }, { variant: 'hud-technical', metadata: 'status-rail' }, { variant: 'tactical-grid', timeline: 'signal-line' }, { personality: 'technical', focus: 'lock' }, 'LOW', 'professional tactical command center'),
    /* The two explicitly preserved RGBTV identities remain available as heritage worlds. */
    theme('ramadan', 'Ramadan', 'Emerald and gold prayer-led television · geometric arches and Hijri rhythm', 'Heritage',
      T('#082f2a', '#0d453a', '#10483d', '#165648', 'rgba(9,47,42,.92)', '#fff3c9', '#ead99c', '#bdad77', '#d4af37', '#f2d37a', '#ffe39b', 'rgba(212,175,55,.44)', 'rgba(0,0,0,.56)', '8px', '20px', '40px', '22px', '18px', '26px', '0 12px 32px rgba(212,175,55,.17)', '0px', 'ramadan-geometry'),
      { display: 'Georgia, "Times New Roman", serif', body: 'Georgia, "Times New Roman", serif', tracking: '.02em' },
      { layout: 'top-arch', variant: 'ramadan-arch', density: 'generous' }, { variant: 'gold-arch', ratio: 'portrait' }, { variant: 'majlis-player', metadata: 'prayer-label' }, { variant: 'ramadan-schedule', timeline: 'golden-crescent' }, { personality: 'serene', focus: 'lantern' }, 'MEDIUM', 'Ramadan majlis and prayer rhythm'),
    theme('majlis', 'Majlis', 'Warm Arab hospitality · woven textiles, ivory text and intimate salon layout', 'Heritage',
      T('#211711', '#382419', '#402c20', '#553b2a', 'rgba(54,35,25,.93)', '#fff4de', '#ead5b3', '#bb9c77', '#cf8d45', '#dab86c', '#f5ca77', 'rgba(207,141,69,.42)', 'rgba(0,0,0,.55)', '7px', '16px', '34px', '16px', '12px', '27px', '0 14px 34px rgba(0,0,0,.34)', '0px', 'woven-majlis'),
      { display: 'Georgia, "Times New Roman", serif', body: 'Georgia, "Times New Roman", serif', tracking: '.018em' },
      { layout: 'left-salon', variant: 'majlis-sidebar', density: 'generous' }, { variant: 'woven-frame', ratio: 'landscape' }, { variant: 'salon', metadata: 'ornament-line' }, { variant: 'majlis-schedule', timeline: 'brass-line' }, { personality: 'warm', focus: 'candle' }, 'MEDIUM', 'warm majlis salon')
  ];

  var byId = {}, DIFFERENTIATION_MATRIX = [];
  REGISTRY.forEach(function (entry) {
    byId[entry.id] = entry;
    /* Keep the anti-cloning decision auditable in runtime data, rather than in a
       design document that can fall out of sync with the shipped registry. */
    DIFFERENTIATION_MATRIX.push({
      id: entry.id, metaphor: entry.visualIdentity, navigation: entry.navigation.layout,
      card: entry.cards.variant, player: entry.player.variant, epg: entry.epg.variant,
      motion: entry.animations.personality, density: entry.density
    });
  });

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function valid(entry) {
    if (!entry || REQUIRED.some(function (key) { return !entry[key]; })) return false;
    return TOKEN_NAMES.every(function (key) { return Object.prototype.hasOwnProperty.call(entry.tokens, key); });
  }
  function resolve(id) { return byId[id] && valid(byId[id]) ? byId[id] : byId[DEFAULT_THEME]; }
  function lowPower() {
    var cores = Number(navigator.hardwareConcurrency || 4), memory = Number(navigator.deviceMemory || 4);
    return cores <= 2 || memory <= 1;
  }
  function projectLegacyTokens(tokens) {
    /* The application predates this engine. Projection keeps every legacy component
       consuming semantic values during the incremental CSS migration. */
    return {
      '--bg': tokens['--rgb-bg'], '--bg2': tokens['--rgb-bg-alt'], '--bg3': tokens['--rgb-surface-elevated'],
      '--panel': tokens['--rgb-surface'], '--card': tokens['--rgb-surface-elevated'], '--text': tokens['--rgb-text'],
      '--muted': tokens['--rgb-text-muted'], '--line': tokens['--rgb-border'], '--accent': tokens['--rgb-accent'],
      '--accent2': tokens['--rgb-accent-secondary'], '--frame': tokens['--rgb-border'], '--fglow': tokens['--rgb-glow'],
      '--glowc': tokens['--rgb-glow'], '--glow1': 'transparent', '--glow2': 'transparent', '--radius': tokens['--rgb-card-radius'],
      '--ease': 'cubic-bezier(.2,.75,.2,1)', '--fring': tokens['--rgb-focus']
    };
  }
  function dispatch(entry, preview) {
    try { document.dispatchEvent(new CustomEvent('rgbtv:themechange', { detail: { theme: clone(entry), preview: !!preview } })); } catch (e) { }
  }
  function apply(id, options) {
    options = options || {};
    var entry = resolve(id), body = document.body, vars = {}, key;
    for (key in entry.tokens) if (key.indexOf('--') === 0) vars[key] = entry.tokens[key];
    var legacy = projectLegacyTokens(entry.tokens); for (key in legacy) vars[key] = legacy[key];
    body.setAttribute('data-theme', entry.id);
    body.setAttribute('data-theme-layout', entry.navigation.layout);
    body.setAttribute('data-theme-performance', entry.performanceLevel.toLowerCase());
    body.classList.toggle('theme-low-power', lowPower() && entry.performanceLevel === 'HIGH');
    body.classList.toggle('ramadan-mode', entry.id === 'ramadan');
    body.classList.toggle('tstruct', entry.id === 'ramadan');
    Object.keys(vars).forEach(function (name) { body.style.setProperty(name, vars[name]); });
    activeId = entry.id;
    if (options.persist && window.Store) Store.setSetting('theme', entry.id);
    dispatch(entry, options.preview);
    return clone(entry);
  }
  function getStoredId() {
    var s = window.Store && Store.settings ? Store.settings() : null;
    return s && isThemeAvailable(s.theme) ? s.theme : DEFAULT_THEME;
  }
  function setTheme(id) { if (!isThemeAvailable(id)) return null; previewBaseId = null; return apply(id, { persist: true }); }
  function previewTheme(id) {
    if (!isThemeAvailable(id)) return null;
    if (previewBaseId === null) previewBaseId = getStoredId();
    return apply(id, { preview: true });
  }
  function cancelPreview() {
    if (previewBaseId === null) return getTheme();
    var previous = previewBaseId; previewBaseId = null;
    return apply(previous, { preview: false });
  }
  function commitPreview() {
    var id = activeId || DEFAULT_THEME; previewBaseId = null;
    return apply(id, { persist: true });
  }
  function resetTheme() { previewBaseId = null; return apply(DEFAULT_THEME, { persist: true }); }
  function getTheme() { return clone(resolve(activeId || getStoredId())); }
  function getAvailableThemes() { return REGISTRY.map(clone); }
  function isThemeAvailable(id) { return !!byId[id] && valid(byId[id]); }
  function isPreviewing() { return previewBaseId !== null; }
  function getPreviewBase() { return previewBaseId; }
  function register(entry) {
    if (!valid(entry) || byId[entry.id]) return false;
    REGISTRY.push(entry); byId[entry.id] = entry; return true;
  }

  return {
    DEFAULT_THEME: DEFAULT_THEME, apply: apply, setTheme: setTheme, getTheme: getTheme,
    getAvailableThemes: getAvailableThemes, previewTheme: previewTheme, cancelPreview: cancelPreview,
    commitPreview: commitPreview, resetTheme: resetTheme, isThemeAvailable: isThemeAvailable,
    isPreviewing: isPreviewing, getPreviewBase: getPreviewBase, getDifferentiationMatrix: function () { return clone(DIFFERENTIATION_MATRIX); }, register: register, validate: valid
  };
})();
