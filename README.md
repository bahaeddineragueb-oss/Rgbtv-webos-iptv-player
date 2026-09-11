# RGBTv — webOS TV source (v2.8.2)

RGBTv is a pure HTML5 IPTV app for LG webOS 1.x–3.x. It supports **Xtream Codes** and **M3U/M3U8 playlists** only. Application JavaScript is ES5-compatible and playback always uses one stable native `<video>` surface.

```text
RGBTv-webOS/
├─ app/
│  ├─ appinfo.json             application metadata
│  ├─ index.html               single-page TV interface
│  ├─ css/                     TV-safe themes, interfaces and RTL styling
│  └─ js/
│     ├─ api/xtream.js         Xtream Codes API
│     ├─ api/m3u.js            M3U/M3U8 playlists and XMLTV EPG
│     ├─ playback-manager.js   bounded playback lifecycle
│     ├─ player.js             one-video playback adapter and OSD
│     └─ lib/                  Shaka Player, hls.js and QR library
├─ services/com.rgbtv.app.service/
│  └─ service.js               bounded HTTP helper and phone pairing service
└─ build.sh                    package, optionally install and launch
```

## Build the IPK

```bash
npm install -g @webos-tools/cli
ares-package app services/com.rgbtv.app.service -o dist
```

Install on a Developer Mode TV:

```bash
ares-setup-device
ares-install -d tv dist/com.rgbtv.app_2.8.2_all.ipk
ares-launch -d tv com.rgbtv.app
```

Or run `./build.sh tv`.

## Providers and profiles

- **Xtream Codes:** server URL, username and password. A credential-bearing `get.php` URL can use the Xtream metadata route and safely fall back to its valid text playlist.
- **M3U/M3U8:** playlist URL, optional XMLTV guide URL, and optional documented User-Agent/Referer fields. Quoted attributes, relative URLs, per-stream header annotations, stable IDs, playlist caching and direct-stream playback are supported.
- Phone pairing accepts the same two profile types. Backup restore accepts only those types. On first profile access, unsupported historic profiles and their account-local data are removed while Xtream/M3U settings, favorites, history, lists, watch positions, reminders and channel customizations are retained.

The Luna service provides CORS-safe, bounded HTTP(S) downloading for provider APIs, playlists and guides. It has explicit size and timeout limits, verifies HTTPS certificates, retains only allowed custom headers, and reports HTTP, network and timeout failures separately.

## Playback engine

The player is provider-neutral:

```text
Provider → StreamResolver → normalized StreamSource → strategy adapter → PlaybackManager
```

New profiles prefer capability-gated **Shaka/MSE** for compatible HLS and DASH. Stored **Auto** settings remain native-first for HLS. MPEG-TS, MP4 and direct or unknown sources remain native. When appropriate, a failed HLS start receives one hls.js handoff, followed by bounded central recovery; no engine creates an independent retry loop. Shaka and hls.js reuse the same `#video` element and are safely destroyed before a replacement source begins.

Custom request headers and browser credentials are sent only to the exact normalized source origin. Redirected or signed CDN segment URLs receive neither those headers nor browser credentials. The on-screen Stats panel offers safe diagnostics without exposing account credentials or full stream URLs.

## Compatibility notes

- Keep `app/js` ES5-only: use `var` and regular functions, not arrow functions, `let`/`const`, classes, `fetch`, `async`/`await`, template literals, or destructuring.
- Legacy webOS support also avoids newer CSS and DOM features such as `inset`, `backdrop-filter`, `@supports`, and `Element.closest()`.
- Do not add a second video element. Many webOS TVs provide only one dependable hardware video plane.
- Profiles, favorites, recent items, EPG, categories, parental controls, settings, VOD, series, themes, remote navigation, RTL and the TV Guide remain part of the application.

See [`docs/design-system-v2.8.md`](docs/design-system-v2.8.md) for the visual-system contract and device audit checklist.
