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
  var DEFAULTS = { liveFormat: 'm3u8', engine: 'auto', parental: true, autostart: false, theme: 'aurora', tmdbKey: '', preview: true, lang: 'en', refreshHours: 6, layout: 'classic', focusStyle: 'glow', largeUi: false, liveGrid: false, ambient: true, weather: true, autoNext: true, accent: 'auto', pointer: 'click', corners: 'round', glow: true, wxMode: 'auto', wxUnit: 'c', adhan: true, adhanMethod: 'algeria' };
  var THEME_MIGRATE = { dark: 'aurora' }, LAYOUT_MIGRATE = { viu: 'spotlight', ibo: 'trio' };
  function settings() { var s = get('settings', {}); for (var k in DEFAULTS) if (!(k in s)) s[k] = DEFAULTS[k]; if (THEME_MIGRATE[s.theme]) s.theme = THEME_MIGRATE[s.theme]; if (LAYOUT_MIGRATE[s.layout]) s.layout = LAYOUT_MIGRATE[s.layout]; return s; }
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
  function favorites(accId) { return get(accKey(accId, 'favs'), []); }
  function isFav(accId, type, id) { return favorites(accId).some(function (f) { return f.type === type && String(f.id) === String(id); }); }
  function toggleFav(accId, item) {
    var l = favorites(accId), idx = -1;
    l.forEach(function (f, i) { if (f.type === item.type && String(f.id) === String(item.id)) idx = i; });
    if (idx >= 0) l.splice(idx, 1); else l.unshift(item);
    set(accKey(accId, 'favs'), l.slice(0, 300));
    return idx < 0;
  }
  function history(accId) { return get(accKey(accId, 'history'), []); }
  function pushHistory(accId, item) {
    var l = history(accId).filter(function (h) { return !(h.type === item.type && String(h.id) === String(item.id)); });
    item.at = Date.now(); l.unshift(item); set(accKey(accId, 'history'), l.slice(0, 60));
  }
  function positions(accId) { return get(accKey(accId, 'pos'), {}); }
  function getPos(accId, key) { return positions(accId)[key] || null; }
  function setPos(accId, key, pos, dur) {
    var p = positions(accId);
    if (dur && pos / dur > 0.96) delete p[key]; else p[key] = { pos: pos, dur: dur, at: Date.now() };
    var keys = Object.keys(p); if (keys.length > 200) { keys.sort(function (a, b) { return p[a].at - p[b].at; }); delete p[keys[0]]; }
    set(accKey(accId, 'pos'), p);
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
      data.data[a.id] = { favs: favorites(a.id), history: history(a.id), locked: lockedIds(a.id), hiddenChannels: hiddenChannels(a.id), channelOrder: channelOrder(a.id), pos: positions(a.id) };
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
      set(accKey(newId, 'history'), Array.isArray(state.history) ? state.history.slice(0, 60) : []);
      set(accKey(newId, 'locked'), state.locked && typeof state.locked === 'object' ? state.locked : {});
      set(accKey(newId, 'hiddenChannels'), state.hiddenChannels && typeof state.hiddenChannels === 'object' ? state.hiddenChannels : {});
      set(accKey(newId, 'channelOrder'), Array.isArray(state.channelOrder) ? state.channelOrder.slice(0, 10000) : []);
      set(accKey(newId, 'pos'), state.pos && typeof state.pos === 'object' ? state.pos : {});
    }
    if (!imported.length) throw new Error('Backup has no valid profiles');
    saveAccounts(imported); set('settings', data.settings && typeof data.settings === 'object' ? data.settings : settings()); del('lastAccount');
    return { count: imported.length, needsCredentials: imported.some(function (x) { return x.needsCredentials; }) };
  }

  return { get: get, set: set, del: del, device: device, accounts: accounts, addAccount: addAccount, updateAccount: updateAccount, removeAccount: removeAccount, getAccount: getAccount, lastAccount: lastAccount, setLastAccount: setLastAccount, settings: settings, setSetting: setSetting, favorites: favorites, isFav: isFav, toggleFav: toggleFav, history: history, pushHistory: pushHistory, getPos: getPos, setPos: setPos, cacheGet: cacheGet, cacheSet: cacheSet, clearCache: clearCache, isLocked: isLocked, toggleLock: toggleLock, lockedIds: lockedIds, hiddenChannels: hiddenChannels, isChannelHidden: isChannelHidden, toggleChannelHidden: toggleChannelHidden, clearHiddenChannels: clearHiddenChannels, sortChannels: sortChannels, moveChannel: moveChannel, clearChannelOrder: clearChannelOrder, snapshot: snapshot, setSnapshot: setSnapshot, exportBackup: exportBackup, importBackup: importBackup };
})();
