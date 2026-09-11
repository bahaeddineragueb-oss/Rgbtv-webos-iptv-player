/* RGBTv — Smart Playlist Engine
 * A local, deterministic organizer for large IPTV lists. It never sends playlist
 * metadata away and it never guesses replacement streams. It only removes entries
 * that are demonstrably unusable (empty/unsupported URL) or exact URL duplicates.
 * ES5 deliberately: webOS 3+ parses this file without a build step. */
var SmartPlaylist = (function () {
  var TYPE_ORDER = ['sports', 'news', 'movies', 'kids', 'music', 'entertainment', 'regional'];
  var TYPE_NAMES = { sports: 'Sports', news: 'News', movies: 'Movies', kids: 'Kids', music: 'Music', entertainment: 'Entertainment', regional: 'Regional' };
  var TYPE_RE = {
    sports: /sport|football|soccer|basket|tennis|formula|f1|nba|bein|esport|رياض|كرة|مباريات/i,
    news: /news|info|journal|cnn|bbc|al ?jazeera|sky news|france 24|أخبار|اخبار|الجزيرة/i,
    movies: /movie|film|cinema|vod|box ?office|aflam|أفلام|افلام|سينما/i,
    kids: /kids?|junior|cartoon|disney|nick|baby|طفل|أطفال|اطفال|كرتون/i,
    music: /music|radio|mtv|trace|melody|musiq|موسيقى|اغاني|أغاني/i,
    entertainment: /entertainment|general|show|series|drama|comedy|reality|منوعات|ترفيه|مسلسلات/i
  };
  var LANGS = [
    ['arabic', 'Arabic', /arabic|arab|arabe|عربي|العربية/i], ['french', 'French', /french|france|français|francais|vf|vostfr|فرنسي/i],
    ['english', 'English', /english|uk|usa|us |british|en\b|انجليزي|إنجليزي/i], ['spanish', 'Spanish', /spanish|español|espanol|latino|es\b/i],
    ['turkish', 'Turkish', /turkish|türk|turk|تركي/i], ['german', 'German', /german|deutsch|de\b|ألماني|الماني/i],
    ['italian', 'Italian', /italian|italia|it\b/i], ['portuguese', 'Portuguese', /portuguese|portugal|brasil|brazil|pt\b/i]
  ];
  var COUNTRIES = [
    ['algeria', 'Algeria', /algeria|algerie|\bdz\b|الجزائر/i], ['france', 'France', /france|français|francais|\bfr\b/i],
    ['uk', 'United Kingdom', /united kingdom|british|\buk\b|england/i], ['usa', 'United States', /united states|america|\busa\b|\bus\b/i],
    ['canada', 'Canada', /canada|\bca\b/i], ['morocco', 'Morocco', /morocco|maroc|المغرب/i],
    ['tunisia', 'Tunisia', /tunisia|tunis|تونس/i], ['egypt', 'Egypt', /egypt|مصر/i], ['saudi', 'Saudi Arabia', /saudi|ksa|السعودية/i],
    ['uae', 'UAE', /united arab emirates|\buae\b|emirates|الإمارات|الامارات/i], ['qatar', 'Qatar', /qatar|قطر/i], ['turkey', 'Turkey', /turkey|turkish|\btr\b|تركيا/i],
    ['spain', 'Spain', /spain|spanish|españa|espana/i], ['italy', 'Italy', /italy|italian|italia/i], ['germany', 'Germany', /germany|german|deutsch/i]
  ];

  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function normal(s) { return trim(s).toLowerCase().replace(/[_\s\-\.]+/g, ' '); }
  function safeUrl(url) {
    url = trim(url);
    /* Live URL schemes that webOS/IPTV backends commonly hand through. An item
       without a URL belongs to Xtream/M3U and is resolved by its provider. */
    return !url || /^(https?|rtsp|rtmp|udp):\/\//i.test(url);
  }
  function cleanName(name) {
    var s = trim(name).replace(/[\u0000-\u001f]+/g, ' ').replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ');
    /* Remove repeated provider wrappers such as [FR] | or (4K) - but retain the
       real title and keep quality separately as a badge/search hint. */
    s = s.replace(/^\s*(?:(?:\[[^\]]{1,28}\]|\([^)]{1,28}\))\s*[|:\-]*\s*)+/g, '');
    s = s.replace(/^\s*(?:\d{1,4}\s*[\.\-:|]\s*)+/g, '');
    s = s.replace(/^\s*(?:live\s*[-|:]\s*)+/i, '');
    s = trim(s.replace(/[|\-:]+\s*$/g, ''));
    return s || 'Unnamed channel';
  }
  function qualityOf(text) {
    var m = String(text || '').match(/\b(4k|uhd|2160p|1080p|fhd|720p|hd|sd)\b/i); return m ? m[1].toUpperCase() : '';
  }
  function detect(text) {
    var out = { types: {}, language: null, country: null }, i;
    text = normal(text);
    for (i = 0; i < TYPE_ORDER.length; i++) if (TYPE_RE[TYPE_ORDER[i]] && TYPE_RE[TYPE_ORDER[i]].test(text)) out.types[TYPE_ORDER[i]] = true;
    for (i = 0; i < LANGS.length; i++) if (LANGS[i][2].test(text)) { out.language = { id: LANGS[i][0], name: LANGS[i][1] }; break; }
    for (i = 0; i < COUNTRIES.length; i++) if (COUNTRIES[i][2].test(text)) { out.country = { id: COUNTRIES[i][0], name: COUNTRIES[i][1] }; break; }
    if (out.country) out.types.regional = true;
    return out;
  }
  function decorate(item) {
    if (!item) return item;
    var raw = item._smartRawName || item.name || item.title || '', group = item.catName || item.group || '', d;
    /* A portal can add the category label after a cached all-channel home row
       has been rendered. Reclassify only when that label changes. */
    if (item._smartDone && item._smartGroup === group) return item;
    d = detect(raw + ' ' + group);
    item._smartRawName = raw; item.name = cleanName(raw); item._smart = d; item._smartGroup = group;
    item.quality = item.quality || qualityOf(raw); item._smartDone = 1; return item;
  }
  function duplicateKey(item) {
    var url = trim(item.url || '');
    /* Query values can be the channel identity on some portals. Only collapse
       byte-for-byte duplicate direct URLs; never guess that two routes match. */
    if (url) return 'url:' + url;
    /* Providers resolve routes later. Do not collapse similarly named Xtream/M3U
       channels because they can point to intentionally different streams. */
    return '';
  }
  function natural(a, b) {
    var an = Number(a.num), bn = Number(b.num), aa = isFinite(an) && an > 0, bb = isFinite(bn) && bn > 0;
    if (aa && bb && an !== bn) return an - bn;
    if (aa !== bb) return aa ? -1 : 1;
    return normal(a.name).localeCompare(normal(b.name));
  }
  function prepare(list, opt) {
    var out = [], seen = {}, stats = { input: (list || []).length, kept: 0, duplicates: 0, broken: 0, cleaned: 0 }, i, item, key, before;
    opt = opt || {};
    for (i = 0; i < (list || []).length; i++) {
      item = list[i]; if (!item) continue;
      before = String(item.name || '');
      if (opt.urls !== false && item.url && !safeUrl(item.url)) { stats.broken++; continue; }
      decorate(item); if (before !== item.name) stats.cleaned++;
      key = duplicateKey(item);
      if (key && seen[key]) { stats.duplicates++; continue; }
      if (key) seen[key] = 1;
      out.push(item);
    }
    out.sort(natural); stats.kept = out.length;
    return { list: out, stats: stats };
  }
  function smartLabel(id, fallback) {
    var key = 'smart.' + String(id || '').replace(':', '.'), value;
    try { value = window.I18n && I18n.t(key); } catch (e) { value = null; }
    return value && value !== key ? value : fallback;
  }
  function smartCategory(id, name, sourceIds) { return { id: '@smart:' + id, name: '✦ ' + smartLabel(id, name), smart: id, sourceIds: sourceIds || [] }; }
  function pushBucket(buckets, key, id) { if (!buckets[key]) buckets[key] = []; if (buckets[key].indexOf(id) < 0) buckets[key].push(id); }
  /* Builds smart sections from category labels, not from a forced full catalogue
     download. This is why Xtream opens quickly even with tens of thousands of items. */
  function categoryHints(cats) {
    var buckets = {}, langs = {}, countries = {}, result = [smartCategory('favorites', 'Favorites'), smartCategory('recent', 'Recently watched'), smartCategory('most', 'Most watched'), smartCategory('added', 'Recently added')], i, c, d, t, l, co;
    for (i = 0; i < (cats || []).length; i++) {
      c = cats[i]; if (!c || c.id == null) continue; d = detect(c.name || '');
      for (t = 0; t < TYPE_ORDER.length; t++) if (d.types[TYPE_ORDER[t]]) pushBucket(buckets, TYPE_ORDER[t], c.id);
      if (d.language) { l = d.language; if (!langs[l.id]) langs[l.id] = { name: l.name, ids: [] }; if (langs[l.id].ids.indexOf(c.id) < 0) langs[l.id].ids.push(c.id); }
      if (d.country) { co = d.country; if (!countries[co.id]) countries[co.id] = { name: co.name, ids: [] }; if (countries[co.id].ids.indexOf(c.id) < 0) countries[co.id].ids.push(c.id); }
    }
    for (t = 0; t < TYPE_ORDER.length; t++) if (buckets[TYPE_ORDER[t]] && buckets[TYPE_ORDER[t]].length) result.push(smartCategory(TYPE_ORDER[t], TYPE_NAMES[TYPE_ORDER[t]], buckets[TYPE_ORDER[t]]));
    Object.keys(langs).sort().slice(0, 8).forEach(function (key) { result.push(smartCategory('lang:' + key, langs[key].name, langs[key].ids)); });
    Object.keys(countries).sort().slice(0, 10).forEach(function (key) { result.push(smartCategory('country:' + key, countries[key].name, countries[key].ids)); });
    return result;
  }
  function inSmart(item, smart) {
    var d = decorate(item)._smart || {}, key = String(smart || '');
    if (key.indexOf('lang:') === 0) return d.language && d.language.id === key.slice(5);
    if (key.indexOf('country:') === 0) return d.country && d.country.id === key.slice(8);
    return !!d.types[key];
  }
  function byAdded(a, b) { return (Number(b.added) || 0) - (Number(a.added) || 0) || natural(a, b); }
  function byMostWatched(a, b, stats) { var aa = stats[String(a.type) + ':' + String(a.id)] || {}, bb = stats[String(b.type) + ':' + String(b.id)] || {}; return (bb.count || 0) - (aa.count || 0) || (bb.last || 0) - (aa.last || 0) || natural(a, b); }
  function filter(items, smart, accountId) {
    var all = (items || []).slice(), history, favs, ids = {}, stats = Store.watchStats ? Store.watchStats(accountId) : {};
    if (smart === 'favorites') { favs = Store.favorites(accountId).filter(function (x) { return x.type === 'live'; }); return prepare(favs, { urls: false }).list; }
    if (smart === 'recent') { history = Store.history(accountId).filter(function (x) { return x.type === 'live'; }); return prepare(history, { urls: false }).list; }
    if (smart === 'most') { return all.filter(function (x) { return (stats[String(x.type) + ':' + String(x.id)] || {}).count; }).sort(function (a, b) { return byMostWatched(a, b, stats); }); }
    if (smart === 'added') return all.sort(byAdded);
    return all.filter(function (x) { return inSmart(x, smart); }).sort(natural);
  }
  function summary(stats) {
    stats = stats || {}; return { input: stats.input || 0, kept: stats.kept || 0, duplicates: stats.duplicates || 0, broken: stats.broken || 0, cleaned: stats.cleaned || 0 };
  }
  return { prepare: prepare, decorate: decorate, categoryHints: categoryHints, filter: filter, inSmart: inSmart, summary: summary, cleanName: cleanName };
})();
