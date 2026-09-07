# RGBTv — webOS TV source (v2.1.0)

Pure HTML5 web app for LG webOS (3.0+): ES5 JavaScript, legacy-safe CSS, native <video> + hls.js.

```
RGBTv-webOS/
├─ app/                      the application (packaged as-is)
│  ├─ appinfo.json           id com.rgbtv.app, version, icons, permissions
│  ├─ index.html             single page, all screens
│  ├─ css/style.css          themes, hub styles, RTL, TV-safe layout (1920×1080 stage scaled to any TV)
│  ├─ img/                   icon / largeIcon / splash / bg
│  └─ js/
│     ├─ util.js             DOM helpers, HTTP (XHR + Luna proxy), fitScreen, SHA-1
│     ├─ i18n.js             English + Arabic strings
│     ├─ storage.js          profiles, settings, favorites, history (localStorage)
│     ├─ nav.js              spatial navigation for the remote + Magic Remote (click-only)
│     ├─ vlist.js            virtual lists/grids for very large playlists
│     ├─ api/xtream.js       Xtream Codes API
│     ├─ api/stalker.js      Stalker Portal (MAC / token handshake)
│     ├─ api/m3u.js          M3U / M3U8 playlists + XMLTV EPG
│     ├─ player.js           playback, OSD, reconnect/stall watchdog, stats, ratio, zap list
│     ├─ ui.js               screens, rows, grids, modals, toasts
│     ├─ keyboard.js         on-screen keyboard
│     ├─ weather.js          Open-Meteo forecast page + topbar chip
│     ├─ adhan.js            prayer times (AlAdhan API) — visual banner only
│     ├─ tmdb.js             optional TMDB artwork/ratings
│     ├─ avatars.js          profile avatars
│     ├─ lib/hls.min.js      hls.js
│     ├─ lib/qrcode.min.js   QR for "Add from phone"
│     └─ app.js              boot, screens flow, key routing
├─ services/com.rgbtv.app.service/   Node.js Luna service (JS service, runs on the TV)
│  ├─ service.js             HTTP proxy with custom headers (Stalker cookies/UA) + "Add from phone" LAN server :8765
│  ├─ services.json / package.json
└─ build.sh                  ares-package (+ optional install/launch on a device)
```

## Build the .ipk

```bash
npm install -g @webos-tools/cli          # once
ares-package app services/com.rgbtv.app.service -o dist
# → dist/com.rgbtv.app_2.1.0_all.ipk
```

Install on a TV in Developer Mode:

```bash
ares-setup-device            # add the TV (IP + passphrase from the Developer Mode app)
ares-install -d tv dist/com.rgbtv.app_2.1.0_all.ipk
ares-launch  -d tv com.rgbtv.app
```

or simply `./build.sh tv`.

## Notes
- Do not add ES6 syntax (arrow functions, let/const, template strings) in `app/js` — older webOS browsers will fail to parse.
- Avoid CSS `inset`, flex `gap`, `backdrop-filter`, `@supports`, and `Element.closest()` for the same reason.
- The Luna service is required for Stalker portals and for "Add from phone"; Xtream/M3U work without it.
- Keep the package small: no bundled audio/video assets.
