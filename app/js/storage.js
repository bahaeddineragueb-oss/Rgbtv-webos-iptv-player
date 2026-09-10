/* RGBTv — persistent storage: accounts, settings, favorites, watch history, cache */
var Store = (function () {
  var PREFIX = 'rgbtv:';
  function get(k, def) { try { var v = localStorage.getItem(PREFIX + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
  function set(k, v) { try { var str = JSON.stringify(v); if (str.length > 1500000) return false; localStorage.setItem(PREFIX + k, str); return true; } catch (e) { return false; /* quota */ } }
  function del(k) { try { localStorage.removeItem(PREFIX + k); } catch (e) { } }

  /* ---- device identity (used for Stalker) ---- */
  function device() {
    var d = get('device');
    if (!d) {
      d = { mac: U.randomMac(), sn: U.sha1(U.uuid()).substr(0, 13), deviceId: U.sha1(U.uuid()), deviceId2: U.sha1(U.uuid()) };
      set('device', d);
    }
    return d;
  }

  /* ---- accounts ---- */
  function accounts() { return get('accounts', []); }
  function saveAccounts(list) { set('accounts', list); }
  function addAccount(acc) { var l = accounts(); acc.id = acc.id || U.uuid(); acc.createdAt = Date.now(); l.push(acc); saveAccounts(l); return acc; }
  function updateAccount(acc) { var l = accounts().map(function (a) { return a.id === acc.id ? acc : a; }); saveAccounts(l); }
  function removeAccount(id) {
    saveAccounts(accounts().filter(function (a) { return a.id !== id; }));
    Object.keys(localStorage).forEach(function (k) { if (k.indexOf(PREFIX + 'acc:' + id + ':') === 0) localStorage.removeItem(k); });
    if (get('lastAccount') === id) del('lastAccount');
  }
  function getAccount(id) { return accounts().filter(function (a) { return a.id === id; })[0] || null; }
  function lastAccount() { return get('lastAccount', null); }
  function setLastAccount(id) { set('lastAccount', id); }

  /* ---- settings ---- */
  var DEFAULTS = { liveFormat: 'm3u8', engine: 'auto', parental: true, autostart: false, theme: 'aurora', tmdbKey: '', preview: true, lang: 'en', refreshHours: 6, layout: 'classic', focusStyle: 'glow', largeUi: false, highContrast: false, liveGrid: false, ambient: true, weather: true, autoNext: true, accent: 'auto', pointer: 'click', corners: 'round', glow: true, wxMode: 'auto', wxUnit: 'c', adhan: true, adhanMethod: 'algeria', pictureMode: 'original', pictureBrightness: 100, pictureContrast: 100, pictureSaturation: 100, pictureTone: 0, pictureBlackLevel: 0, pictureGamma: 0 };
  var THEME_MIGRATE = { dark: 'aurora' }, LAYOUT_MIGRATE = { viu: 'spotlight', ibo: 'trio' };
  function settings() { var s = get('settings', {}); if (Object.prototype.hasOwnProperty.call(s, 'performance')) delete s.performance; for (var k in DEFAULTS) if (!(k in s)) s[k] = DEFAULTS[k]; if (THEME_MIGRATE[s.theme]) s.theme = THEME_MIGRATE[s.theme]; if (LAYOUT_MIGRATE[s.layout]) s.layout = LAYOUT_MIGRATE[s.layout]; return s; }
  /* per-account locked channels (ids) */
  function lockedIds(accId) { return get(accKey(accId, 'locked'), {}); }
  function isLocked(accId, id) { return !!lockedIds(accId)[String(id)]; }
  function toggleLock(accId, id) { var l = lockedIds(accId); if (l[String(id)]) delete l[String(id)]; else l[String(id)] = 1; set(accKey(accId, 'locked'), l); return !!l[String(id)]; }
  /* content snapshot for change detection (auto refresh) */
  function snapshot(accId) { return get(accKey(accId, 'snapshot'), null); }
  function setSnapshot(accId, snap) { set(accKey(accId, 'snapshot'), snap); }
  function setSetting(k, v) { var s = settings(); s[k] = v; set('settings', s); }

  /* ---- live-channel personalisation (never changes the provider playlist) ---- */
  function hiddenChannels(accId) { return get(accKey(accId, 'hiddenChannels'), {}); }
  function isChannelHidden(accId, id) { return !!hiddenChannels(accId)[String(id)]; }
  function toggleChannelHidden(accId, id) { var hidden = hiddenChannels(accId), key = String(id); if (hidden[key]) delete hidden[key]; else hidden[key] = 1; set(accKey(accId, 'hiddenChannels'), hidden); return !!hidden[key]; }
  function clearHiddenChannels(accId) { del(accKey(accId, 'hiddenChannels')); }
  /* Groups can be hidden independently of individual channels. This is local-only
     and uses provider category IDs, so the source playlist is never altered. */
  function hiddenCategories(accId) { return get(accKey(accId, 'hiddenCategories'), {}); }
  function isCategoryHidden(accId, id) { return id != null && !!hiddenCategories(accId)[String(id)]; }
  function toggleCategoryHidden(accId, id) { if (id == null) return false; var hidden = hiddenCategories(accId), key = String(id); if (hidden[key]) delete hidden[key]; else hidden[key] = 1; set(accKey(accId, 'hiddenCategories'), hidden); return !!hidden[key]; }
  function clearHiddenCategories(accId) { del(accKey(accId, 'hiddenCategories')); }
  function channelOrder(accId) { return get(accKey(accId, 'channelOrder'), []); }
  function sortChannels(accId, list) {
    var order = channelOrder(accId), rank = {}, copy = (list || []).slice();
    order.forEach(function (id, i) { rank[String(id)] = i; });
    copy.sort(function (a, b) {
      var ai = rank[String(a.id)], bi = rank[String(b.id)];
      if (ai == null && bi == null) return (Number(a.num) || 999999) - (Number(b.num) || 999999);
      if (ai == null) return 1; if (bi == null) return -1; return ai - bi;
    });
    return copy;
  }
  function moveChannel(accId, list, id, delta) {
    var ids = sortChannels(accId, list).map(function (x) { return String(x.id); }), at = ids.indexOf(String(id)), next = at + delta;
    if (at < 0 || next < 0 || next >= ids.length) return false;
    var tmp = ids[at]; ids[at] = ids[next]; ids[next] = tmp; set(accKey(accId, 'channelOrder'), ids); return true;
  }
  function clearChannelOrder(accId) { del(accKey(accId, 'channelOrder')); }

  /* ---- per-account: favorites / history / cache ---- */
  function accKey(accId, k) { return 'acc:' + accId + ':' + k; }
  var DEFAULT_FAV_LIST = 'default';
  function favoriteLists(accId) {
    var raw = get(accKey(accId, 'favLists'), []), out = [{ id: DEFAULT_FAV_LIST, name: 'My List' }], used = { 'default': 1 };
    (Array.isArray(raw) ? raw : []).forEach(function (x) {
      var id = String(x && x.id || ''), name = String(x && x.name || '').replace(/^\s+|\s+$/g, '');
      if (id && id !== DEFAULT_FAV_LIST && !used[id] && name && name.length <= 32 && out.length < 12) { used[id] = 1; out.push({ id: id, name: name }); }
    });
    return out;
  }
  function saveFavoriteLists(accId, lists) { set(accKey(accId, 'favLists'), (lists || []).filter(function (x) { return x.id !== DEFAULT_FAV_LIST; }).slice(0, 11)); }
  function createFavoriteList(accId, name) {
name = String(name || '').replace(/^\s+|\s+$/g, '').slice(0, 32);
    var lists = favoriteLists(accId), lower = name.toLowerCase();
    if (!name || lists.some(function (x) { return x.name.toLowerCase() === lower; }) || lists.length >= 12) return null;
    var item = { id: 'list-' + U.uuid(), name: name }; lists.push(item); saveFavoriteLists(accId, lists); return item;
  }
  function renameFavoriteList(accId, id, name) {
    id = String(id || ''); name = String(name || '').replace(/^\s+|\s+$/g, '').slice(0, 32);
    if (!name || id === DEFAULT_FAV_LIST) return false;
    var lists = favoriteLists(accId), target = null, lower = name.toLowerCase();
    if (lists.some(function (x) { return x.id !== id && x.name.toLowerCase() === lower; })) return false;
    lists.forEach(function (x) { if (x.id === id) target = x; }); if (!target) return false;
    target.name = name; saveFavoriteLists(accId, lists); return true;
  }
  function removeFavoriteList(accId, id) {
    id = String(id || ''); if (!id || id === DEFAULT_FAV_LIST) return false;
    var exists = favoriteLists(accId).some(function (x) { return x.id === id; }); if (!exists) return false;
    saveFavoriteLists(accId, favoriteLists(accId).filter(function (x) { return x.id !== id; }));
    /* Keep the titles rather than deleting them: a removed collection returns them to My List. */
    var l = favorites(accId), changed = false;
    l.forEach(function (x) { if ((x.favList || DEFAULT_FAV_LIST) === id) { x.favList = DEFAULT_FAV_LIST; changed = true; } });
    if (changed) set(accKey(accId, 'favs'), l.slice(0, 300));
    return true;
  }
  function favorites(accId, listId) {
    var list = get(accKey(accId, 'favs'), []); if (!Array.isArray(list)) return [];
    if (listId == null || listId === 'all') return list;
    return list.filter(function (f) { return (f.favList || DEFAULT_FAV_LIST) === String(listId); });
  }
  function isFav(accId, type, id, listId) {
    return favorites(accId, listId).some(function (f) { return f.type === type && String(f.id) === String(id); });
  }
  function toggleFavInList(accId, item, listId) {
    var id = String(listId || DEFAULT_FAV_LIST), lists = favoriteLists(accId), l = favorites(accId), idx = -1, copy = {}, k;
    if (!lists.some(function (x) { return x.id === id; })) id = DEFAULT_FAV_LIST;
    for (k in item) if (Object.prototype.hasOwnProperty.call(item, k)) copy[k] = item[k];
    copy.favList = id;
    l.forEach(function (f, i) { if ((f.favList || DEFAULT_FAV_LIST) === id && f.type === copy.type && String(f.id) === String(copy.id)) idx = i; });
    if (idx >= 0) l.splice(idx, 1); else l.unshift(copy);
    set(accKey(accId, 'favs'), l.slice(0, 300));
    return idx < 0;
  }
  /* Legacy RED/star actions remain a single global toggle: remove an item from
     every collection, or put it into My List when it has not been saved before. */
  function toggleFav(accId, item) {
    var l = favorites(accId), found = false;
    l = l.filter(function (f) { var same = f.type === item.type && String(f.id) === String(item.id); found = found || same; return !same; });
    if (found) { set(accKey(accId, 'favs'), l); return false; }
    return toggleFavInList(accId, item, DEFAULT_FAV_LIST);
  }
  function history(accId) { return get(accKey(accId, 'history'), []); }
  function pushHistory(accId, item) {
    var l = history(accId).filter(function (h) { return !(h.type === item.type && String(h.id) === String(item.id)); });
    item.at = Date.now(); l.unshift(item); set(accKey(accId, 'history'), l.slice(0, 60));
  }
  /* Counts are local ranking hints, not analytics. They are bounded to keep storage
     and Smart Playlist sorting fast even after years of use. */
  function watchStats(accId) { var w = get(accKey(accId, 'watchStats'), {}); return w && typeof w === 'object' ? w : {}; }
  function recordWatch(accId, item) {
    if (!accId || !item || !item.id) return false;
    var w = watchStats(accId), key = String(item.type || '') + ':' + String(item.id), keys;
    w[key] = w[key] || { count: 0, last: 0 }; w[key].count = Math.min(9999, Number(w[key].count || 0) + 1); w[key].last = Date.now();
    keys = Object.keys(w); if (keys.length > 500) { keys.sort(function (a, b) { return (w[a].last || 0) - (w[b].last || 0); }); delete w[keys[0]]; }
    return set(accKey(accId, 'watchStats'), w);
  }
  function positions(accId) { return get(accKey(accId, 'pos'), {}); }
  function getPos(accId, key) { return positions(accId)[key] || null; }
  function setPos(accId, key, pos, dur) {
    var p = positions(accId);
    if (dur && pos / dur > 0.96) delete p[key]; else p[key] = { pos: pos, dur: dur, at: Date.now() };
    var keys = Object.keys(p); if (keys.length > 200) { keys.sort(function (a, b) { return p[a].at - p[b].at; }); delete p[keys[0]]; }
    set(accKey(accId, 'pos'), p);
  }

  /* Track preferences are tiny metadata records. The browser may expose tracks late,
     so the player keeps a label/language as well as an index fallback. */
  function trackPrefs(accId) { var p = get(accKey(accId, 'tracks'), {}); return p && typeof p === 'object' ? p : {}; }
  function trackPref(accId, item) { return trackPrefs(accId)[String(item.type || '') + ':' + String(item.id || '')] || null; }
  function setTrackPref(accId, item, kind, value) {
    if (!accId || !item || !kind) return false;
    var p = trackPrefs(accId), key = String(item.type || '') + ':' + String(item.id || '');
    p[key] = p[key] || {}; p[key][kind] = value; p[key].at = Date.now();
    var keys = Object.keys(p);
    if (keys.length > 120) { keys.sort(function (a, b) { return (p[a].at || 0) - (p[b].at || 0); }); delete p[keys[0]]; }
    return set(accKey(accId, 'tracks'), p);
  }

  /* A reminder is deliberately local and fires while the app is running. IPTV
     providers do not offer a portable, standard server-side recording/reminder API. */
  function reminders(accId) { var r = get(accKey(accId, 'reminders'), []); return Array.isArray(r) ? r : []; }
  function reminderKey(channel, programme) { return String(channel && channel.id || '') + '@' + String(programme && programme.start || ''); }
  function isReminder(accId, channel, programme) { var key = reminderKey(channel, programme); return reminders(accId).some(function (r) { return r.key === key; }); }
  function toggleReminder(accId, channel, programme) {
    if (!accId || !channel || !programme || !programme.start) return false;
    var key = reminderKey(channel, programme), list = reminders(accId), at = -1;
    list.forEach(function (r, i) { if (r.key === key) at = i; });
    if (at >= 0) { list.splice(at, 1); set(accKey(accId, 'reminders'), list); return false; }
    list.unshift({ key: key, id: String(channel.id), epgId: String(channel.epgId || channel.id), channel: String(channel.name || ''), title: String(programme.title || ''), start: Number(programme.start), end: Number(programme.end) || 0, createdAt: Date.now(), notified: false });
    /* Drop old completed reminders first, then keep a small TV-safe set. */
    list = list.filter(function (r) { return !r.end || r.end > Date.now() / 1000 - 86400; }).slice(0, 80);
    set(accKey(accId, 'reminders'), list); return true;
  }
  function dueReminders(accId, now) {
    now = Number(now) || Date.now() / 1000; var list = reminders(accId), due = [], changed = false;
    list.forEach(function (r) { if (!r.notified && r.start - now <= 60 && r.end > now - 60) { r.notified = true; due.push(r); changed = true; } });
    if (changed) set(accKey(accId, 'reminders'), list); return due;
  }
  function upcomingReminders(accId, limit) { var now = Date.now() / 1000; return reminders(accId).filter(function (r) { return r.end > now; }).sort(function (a, b) { return a.start - b.start; }).slice(0, limit || 12); }

  /* Diagnostic summaries contain timings and friendly errors only, never account
     secrets or raw stream URLs. */
  function health(accId) { var h = get(accKey(accId, 'health'), {}); return h && typeof h === 'object' ? h : {}; }
  function setHealth(accId, patch) { var h = health(accId), k; for (k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) h[k] = patch[k]; h.at = Date.now(); return set(accKey(accId, 'health'), h); }
  function cacheInfo(accId) {
    var pre = PREFIX + accKey(accId, 'cache:'), n = 0, bytes = 0;
    Object.keys(localStorage).forEach(function (k) { if (k.indexOf(pre) === 0) { n++; try { bytes += String(localStorage.getItem(k) || '').length; } catch (e) { } } });
    return { entries: n, bytes: bytes };
  }
  function cacheGet(accId, k, maxAgeMs) {
    var c = get(accKey(accId, 'cache:' + k)); if (!c) return null;
    if (maxAgeMs && Date.now() - c.at > maxAgeMs) return null; return c.data;
  }
  function cacheSet(accId, k, data) { set(accKey(accId, 'cache:' + k), { at: Date.now(), data: data }); }
  function clearCache(accId) { Object.keys(localStorage).forEach(function (k) { if (k.indexOf(PREFIX + accKey(accId, 'cache:')) === 0 || k.indexOf(PREFIX + 'tmdb:') === 0) localStorage.removeItem(k); }); }

  /* ---- portable backup code: profiles, settings and personal lists; caches are intentionally excluded ---- */
  function utf8b64(s) { try { return btoa(unescape(encodeURIComponent(s))); } catch (e) { return ''; } }
  function b64utf8(s) { try { return decodeURIComponent(escape(atob(s))); } catch (e) { return ''; } }
  function safeAccountCopy(acc, includeSecrets) {
    var out = {}, k;
    for (k in acc) if (Object.prototype.hasOwnProperty.call(acc, k)) out[k] = acc[k];
    delete out.token; delete out.endpoint; delete out.lastLogin; delete out.expires;
    if (!includeSecrets) {
      delete out.username; delete out.password; delete out.m3uUserAgent; delete out.m3uReferer;
      /* An M3U URL itself often embeds subscription credentials. Keep the profile shell, not that secret. */
      if (out.type === 'm3u') { out.url = ''; out.needsCredentials = true; }
    }
    return out;
  }
  function exportBackup(includeSecrets) {
    var data = { schema: 'rgbtv-backup', version: 1, createdAt: Date.now(), settings: settings(), accounts: [], data: {} };
    accounts().forEach(function (a) {
      data.accounts.push(safeAccountCopy(a, !!includeSecrets));
      data.data[a.id] = { favs: favorites(a.id), favLists: favoriteLists(a.id), history: history(a.id), locked: lockedIds(a.id), hiddenChannels: hiddenChannels(a.id), hiddenCategories: hiddenCategories(a.id), channelOrder: channelOrder(a.id), pos: positions(a.id), tracks: trackPrefs(a.id), reminders: reminders(a.id), watchStats: watchStats(a.id) };
    });
    return utf8b64(JSON.stringify(data));
  }
  function validImportedAccount(a) { return a && /^(xtream|stalker|m3u)$/.test(a.type) && typeof a.name === 'string' && a.name.length > 0 && a.name.length <= 80; }
  function importBackup(code) {
    var raw = b64utf8(String(code || '').replace(/\s/g, '')), data, imported = [], used = {}, i, a, state, newId;
    if (!raw || raw.length > 1500000) throw new Error('Invalid or oversized backup code');
    try { data = JSON.parse(raw); } catch (e) { throw new Error('Invalid backup code'); }
    if (!data || data.schema !== 'rgbtv-backup' || Number(data.version) !== 1 || !Array.isArray(data.accounts)) throw new Error('Unsupported backup format');
    for (i = 0; i < data.accounts.length && imported.length < 20; i++) {
      a = data.accounts[i]; if (!validImportedAccount(a)) continue;
      a = safeAccountCopy(a, true); newId = String(a.id || U.uuid());
      while (used[newId]) newId = U.uuid(); used[newId] = 1; a.id = newId; a.createdAt = a.createdAt || Date.now();
      delete a.token; delete a.endpoint; imported.push(a);
      state = data.data && data.data[data.accounts[i].id] || {};
      set(accKey(newId, 'favs'), Array.isArray(state.favs) ? state.favs.slice(0, 300) : []);
      saveFavoriteLists(newId, Array.isArray(state.favLists) ? state.favLists : []);
      set(accKey(newId, 'history'), Array.isArray(state.history) ? state.history.slice(0, 60) : []);
      set(accKey(newId, 'locked'), state.locked && typeof state.locked === 'object' ? state.locked : {});
      set(accKey(newId, 'hiddenChannels'), state.hiddenChannels && typeof state.hiddenChannels === 'object' ? state.hiddenChannels : {});
      set(accKey(newId, 'hiddenCategories'), state.hiddenCategories && typeof state.hiddenCategories === 'object' ? state.hiddenCategories : {});
      set(accKey(newId, 'channelOrder'), Array.isArray(state.channelOrder) ? state.channelOrder.slice(0, 10000) : []);
      set(accKey(newId, 'pos'), state.pos && typeof state.pos === 'object' ? state.pos : {});
      set(accKey(newId, 'tracks'), state.tracks && typeof state.tracks === 'object' ? state.tracks : {});
      set(accKey(newId, 'reminders'), Array.isArray(state.reminders) ? state.reminders.slice(0, 80) : []);
      set(accKey(newId, 'watchStats'), state.watchStats && typeof state.watchStats === 'object' ? state.watchStats : {});
    }
    if (!imported.length) throw new Error('Backup has no valid profiles');
    saveAccounts(imported); set('settings', data.settings && typeof data.settings === 'object' ? data.settings : settings()); del('lastAccount');
    return { count: imported.length, needsCredentials: imported.some(function (x) { return x.needsCredentials; }) };
  }

  return { get: get, set: set, del: del, device: device, accounts: accounts, addAccount: addAccount, updateAccount: updateAccount, removeAccount: removeAccount, getAccount: getAccount, lastAccount: lastAccount, setLastAccount: setLastAccount, settings: settings, setSetting: setSetting, favoriteLists: favoriteLists, createFavoriteList: createFavoriteList, renameFavoriteList: renameFavoriteList, removeFavoriteList: removeFavoriteList, favorites: favorites, isFav: isFav, toggleFav: toggleFav, toggleFavInList: toggleFavInList, history: history, pushHistory: pushHistory, watchStats: watchStats, recordWatch: recordWatch, getPos: getPos, setPos: setPos, trackPref: trackPref, setTrackPref: setTrackPref, reminders: reminders, isReminder: isReminder, toggleReminder: toggleReminder, dueReminders: dueReminders, upcomingReminders: upcomingReminders, health: health, setHealth: setHealth, cacheInfo: cacheInfo, cacheGet: cacheGet, cacheSet: cacheSet, clearCache: clearCache, isLocked: isLocked, toggleLock: toggleLock, lockedIds: lockedIds, hiddenChannels: hiddenChannels, isChannelHidden: isChannelHidden, toggleChannelHidden: toggleChannelHidden, clearHiddenChannels: clearHiddenChannels, hiddenCategories: hiddenCategories, isCategoryHidden: isCategoryHidden, toggleCategoryHidden: toggleCategoryHidden, clearHiddenCategories: clearHiddenCategories, sortChannels: sortChannels, moveChannel: moveChannel, clearChannelOrder: clearChannelOrder, snapshot: snapshot, setSnapshot: setSnapshot, exportBackup: exportBackup, importBackup: importBackup };
})();
