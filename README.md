# RGBTv — webOS TV source (v2.8.0)

Pure HTML5 web app for LG webOS (3.0+): ES5 JavaScript, legacy-safe CSS, native <video> + hls.js.

```
RGBTv-webOS/
├─ app/                      the application (packaged as-is)
│  ├─ appinfo.json           id com.rgbtv.app, version, icons, permissions
│  ├─ index.html             single page, all screens
│  ├─ css/style.css          base themes, hub styles, RTL, TV-safe layout (1920×1080 stage scaled to any TV)
│  ├─ css/theme-layout-contract.css  legacy geometry compatibility layer
│  ├─ css/theme-interface-suite.css  final v2.8 theme tokens + independent interface geometry
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
# → dist/com.rgbtv.app_2.3.0_all.ipk
```

Install on a TV in Developer Mode:

```bash
ares-setup-device            # add the TV (IP + passphrase from the Developer Mode app)
ares-install -d tv dist/com.rgbtv.app_2.3.0_all.ipk
ares-launch  -d tv com.rgbtv.app
```

or simply `./build.sh tv`.

## Notes
- Do not add ES6 syntax (arrow functions, let/const, template strings) in `app/js` — older webOS browsers will fail to parse.
- Avoid CSS `inset`, flex `gap`, `backdrop-filter`, `@supports`, and `Element.closest()` for the same reason.
- M3U supports quoted/unquoted attributes, relative stream URLs, stable item IDs, and an optional XMLTV EPG URL (or `url-tvg` declared in the playlist). It downloads the text playlist once with a 120-second timeout, caches parsed items for six hours, and sends the parsed direct stream URL to the player without a per-channel control request. The packaged Luna service is preferred for CORS-safe playlist/guide fetches; it retains same-origin redirect cookies, requests identity encoding, handles gzip/deflate responses, accepts downloads up to 64 MiB, and allows the full 120-second timeout. The app reports login-page, HTTP-status, network, and timeout failures separately. A credential-bearing `get.php` M3U URL first tries the compatible Xtream API through the same Luna/native-safe path for fast metadata, then falls back automatically to the valid text playlist if the API or a large catalogue request is unavailable. Xtream and Stalker catalogue pages receive a 120-second budget; the Movies and Series screens first load a concrete category so the TV can render titles without waiting for an entire provider catalogue.
- Stalker/Ministra needs the Luna service for its MAG cookie and bearer-token handshake. It tries common portal roots (`/server/load.php`, `/c/server/load.php`, and `/stalker_portal/...`) before reporting a connection failure. HTTPS certificates are verified by default; a clearly labelled per-profile switch is available only for a self-signed portal you trust.
- The **Ramadan** theme supplies emerald-and-gold surfaces, crescent branding and the five-prayer/Hijri strip on its compatible Home surface; it reuses the cached AlAdhan calendar, clearly reports disabled or unavailable times, and does **not** turn notifications on when they were disabled. The selected interface style, not Ramadan, owns navigation geometry.
- The player deliberately uses one video decoder because many webOS TVs expose only one reliable hardware video plane. This keeps channel zapping and playback predictable.
- Selecting a live channel starts with a **classic receiver information banner**: number, logo, name, current programme, next programme and progress. Press **LEFT** (or select **Channels** in the player controls) to open the virtualized right-side channel panel; UP/DOWN browses, OK watches, and LEFT/BACK closes it. This remains responsive with large playlists.
- **Visual system v2.8:** `theme-interface-suite.css` is loaded last and makes visual theme and interface geometry independent. Astra OS, Receiver Pro, Liquid Glass TV, Live Pulse and Noor Majlis each work with Side Rail, Command Center, Guide First, Spotlight and Mosaic/App Grid. The legacy `theme-layout-contract.css` remains only as a compatibility layer for old selections; the final suite takes geometry authority for every new interface. RTL mirrors the side rail and its content reservation; Large UI and High Contrast retain visible labels and focus.
- The detailed visual contract, migration behaviour and manual device audit checklist are in [`docs/design-system-v2.8.md`](docs/design-system-v2.8.md).
- Phone pairing is time-limited and QR-token protected; review the received profile on the TV before it is stored.
- **Performance mode** defaults to Fast: it disables the optional preview decoder and expensive decorative motion while browsing. Live, Movies and Series category changes are request-versioned so a slow stale response cannot overwrite the latest selection; short EPG requests are coalesced for five minutes.
- The expanded TV Guide fetches a long schedule only for the channel the user asks to inspect. It supports one-minute **local reminders** and catch-up playback only when the provider marks the channel as archive-enabled. Reminders appear while RGBTv is running; IPTV does not expose a portable server-side reminder standard.
- Favorites support named personal collections (including a default **My List**), per-channel hide/order controls, and portable backup/restore. Audio/subtitle choices are remembered per item when the webOS player exposes tracks; manual quality selection is presented only for adaptive HLS streams.
- **Connection diagnostics** reports the selected provider, declared capabilities, cache footprint, last login timing and a user-triggered safe catalogue/playback-link check. It never starts a second stream, and it never displays credentials or a full stream URL.
- Keep the package small: no bundled audio/video assets.

## Playback Engine (v2.7.7)

Live playback uses one stable HTML5 `<video>` surface through a provider-neutral pipeline:

```
Provider → authentication → StreamResolver → normalized StreamSource →
webOS strategy adapter → PlaybackManager state machine
```

Xtream and Stalker return the same normalized source contract (`streamUrl`, stream type, MIME/protocol/container, headers, in-memory cookie/token context and metadata). Provider API logic never enters the player adapter. The manager has isolated session IDs, aborts obsolete resolver work while zapping, destroys the prior hls.js instance/source before replacement, and uses bounded recovery: player reinitialization, fresh resolution, then one Stalker session refresh. It reaches `TIMEOUT` and then a bounded retry/error path rather than retaining an infinite loading state.

The existing **Stats** panel (INFO / BLUE) is the developer diagnostics surface. It exposes safe metadata only—provider, redacted source origin, protocol, MIME, stream type, selected strategy, current state/event, HLS variant facts, HTTP response metadata when explicitly probed, retry count and time to first frame. Opening it requests only an opt-in 4 KiB Range probe after playback begins; normal playback performs neither a HEAD request nor a stream prefetch.

For Stalker, `create_link` is required to produce a fresh URL. A failed or empty result is reported as `STREAM_RESOLUTION_ERROR` rather than falling back to a stale `cmd`. Same-origin links retain their active MAG headers/cookies/token in memory; credentials are deliberately not forwarded to a different CDN origin. HLS is native-first on capable webOS hardware, with one hls.js fallback only when native playback fails or source authentication requires it. Mixed audio-only/video HLS manifests are parsed from the real hls.js manifest and start on a video rendition; WebOS compatibility warnings are recorded in diagnostics.

Validation is automated with provider, resolver, state-machine, cancellation, buffering, HLS fallback, deadline and Stalker-session tests. Final device acceptance still requires testing the subscriber's actual streams on their target LG webOS version, because portal authorization and codec support cannot be proven from a development fixture.

### Stalker resolver repair (v2.7.2)

The Stalker live resolver now accepts `cmd`, `command`, `url`, string `data`, nested `data`, and nested `result` create-link envelopes; normalizes `ffmpeg`/pipe command output into the actual media URL; and reports a missing link as `STREAM_RESOLUTION_ERROR` instead of attempting an expired channel command. MAG MAC cookies retain literal colon notation, and implicit HTTPS port 443 matches an explicitly returned `:443` stream origin so the active Stalker session is not accidentally dropped. Opaque signed live URLs that lack `.m3u8` receive one controlled hls.js fallback after native `SRC_NOT_SUPPORTED`, rather than being prematurely declared non-HLS.

### Stalker large-catalogue repair (v2.7.6)

Stalker Live now explicitly requests bounded 100-channel ITV pages (`page_size` and `limit`) while preserving the portal's own pagination metadata. If an old portal ignores pagination and returns a giant channel array, mapping is sliced across event-loop turns instead of blocking the TV UI. A new page-cache namespace ensures an upgrade cannot revive an old giant channel cache from localStorage. The Home dashboard also stops scanning enormous Stalker VOD/Series catalogues merely to render decorative counts; those catalogues load only when their own screens are opened, leaving the first Live page and fresh `create_link` request free to start immediately.

### Stalker localhost stream repair (v2.7.5)

Some MAG portals return `create_link` commands such as `ffmpeg http://localhost/ch/512_`. `localhost` is an internal proxy alias understood by MAG firmware, not by a webOS browser application; assigning it to the stable video element attempts playback against the TV itself. Live resolution now rewrites only loopback aliases (`localhost`, `127.0.0.1`, `::1`, and `0.0.0.0`) to the authenticated portal host while retaining the channel path, query and any explicit gateway port. Remote stream URLs are never rewritten.

### Stalker live-priority and renewal repair (v2.7.4)

Stalker portal traffic keeps ordinary catalogue work serialized to remain respectful of rate-limited MAG servers, but `create_link` now receives one dedicated high-priority lane alongside an already-running background catalogue request. A selected channel can therefore no longer wait behind a long VOD/Series page until the playback resolver expires. Renewal handshakes omit the known-expired `Authorization` bearer, recognise nested `data`/`result` token envelopes, retain session cookies, and preserve an installed portal's actual `/stalker_portal/c/` or custom `/c/` Referer path. The native adapter also accepts legacy webOS implementations where `HTMLMediaElement.play()` returns no Promise, avoiding a synthetic player failure after a valid Stalker source assignment.

### Native event ownership repair (v2.7.3)

Native webOS media events are now associated with a session marker set immediately before `video.src`. The previous exact `currentSrc === providerUrl` comparison rejected legitimate `canplay` and `playing` events after Blink/WebOS canonicalized a signed or credential-bearing Xtream URL. As a result, video could visibly play while the loading overlay was never dismissed. The event marker invalidates before source cleanup and is renewed only for the winning channel, preserving stale-event protection without relying on URL string equality.
