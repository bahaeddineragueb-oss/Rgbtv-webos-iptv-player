# RGBTv — webOS TV source (v2.2.1)

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
# → dist/com.rgbtv.app_2.2.1_all.ipk
```

Install on a TV in Developer Mode:

```bash
ares-setup-device            # add the TV (IP + passphrase from the Developer Mode app)
ares-install -d tv dist/com.rgbtv.app_2.2.2_all.ipk
ares-launch  -d tv com.rgbtv.app
```

or simply `./build.sh tv`.

## Notes
- Do not add ES6 syntax (arrow functions, let/const, template strings) in `app/js` — older webOS browsers will fail to parse.
- Avoid CSS `inset`, flex `gap`, `backdrop-filter`, `@supports`, and `Element.closest()` for the same reason.
- M3U supports quoted/unquoted attributes, relative stream URLs, stable item IDs, and an optional XMLTV EPG URL (or `url-tvg` declared in the playlist). The packaged Luna service is used automatically when a playlist/guide needs a CORS-safe fetch; direct browser XHR remains the fallback.
- Stalker/Ministra needs the Luna service for its MAG cookie and bearer-token handshake. It tries common portal roots (`/server/load.php`, `/c/server/load.php`, and `/stalker_portal/...`) before reporting a connection failure. HTTPS certificates are verified by default; a clearly labelled per-profile switch is available only for a self-signed portal you trust.
- The **Ramadan** theme has a dedicated emerald/gold skin and a Home prayer card. It uses the existing Prayer Times setting and does **not** turn notifications on when they were disabled.
- Live Player offers **Dual View** for two live channels: pressing Dual opens the next available live channel immediately, while **Choose 2nd** lets you replace it. The secondary channel begins muted and Yellow changes the audio source. It retries an HLS secondary stream with hls.js when native video does not start, and restores the main picture with a clear explanation after 20 seconds. Actual availability still depends on the TV and subscription permitting two simultaneous live streams.
- Selecting a live channel starts with a **classic receiver information banner**: number, logo, name, current programme, next programme and progress. Press **LEFT** (or select **Channels** in the player controls) to open the virtualized right-side channel panel; UP/DOWN browses, OK watches, and LEFT/BACK closes it. This remains responsive with large playlists.
- Navigation now uses protected, theme-specific docks so it never overlaps the clock/profile strip: Guide Pro and Ocean use a left rail; Receiver X, Sports Arena and Neo CRT use a bottom dock; Cyberpunk uses a right rail; the remaining themes use a safe lower top bar.
- Phone pairing is time-limited and QR-token protected; review the received profile on the TV before it is stored.
- Keep the package small: no bundled audio/video assets.
