# RGBTv v2.8 visual system

## Principle

The visual product now has two independent choices:

1. **Theme** (`data-theme`) supplies visual language only: palette, surface depth, card treatment, typography character, focus colour, overlays and player/guide chrome.
2. **Interface style** (`data-interface`) supplies geometry only: navigation dock, safe content bounds and Home information architecture.

There is no theme-to-layout mapping. A user may select any of the five new themes with Side Rail, Command Center, Guide First, Spotlight or Mosaic/App Grid. The CSS is intentionally split that way: the theme section has no `data-interface` selectors, and the interface section has no `data-theme` selectors.

## New themes

| Theme ID | Product character | What changes everywhere |
|---|---|---|
| `astra` — Astra OS | Calm, premium system UI in midnight navy with cyan and mint telemetry accents. | Cool layered background, thin technical dividers, precise section labels, cyan/mint selection glow, clean guide and player panels. |
| `receiverpro` — Receiver Pro | A modern set-top-box instrument panel in graphite and signal orange. | Hardware-like solid panels, tight orange borders, uppercase navigational treatment, beveled buttons, warm player controls. |
| `liquidglass` — Liquid Glass TV | A soft, luminous glass interface in blue-violet with pearl highlights. | Translucent fallback-safe surfaces, hairline white edges, layered indigo glow, bright glass focus ring, matching player overlay. |
| `livepulse` — Live Pulse | A high-energy broadcast control identity in live red, magenta and broadcast blue. | Red live accents, pulse-style live indicator, high-contrast programme/card edges, urgent but restrained playback chrome. |
| `noormajlis` — Noor Majlis | A refined warm-night salon identity in espresso, emerald and gold. | Gold-lined surfaces, warm readable text, subtle green/gold ambient light, dignified guide/player framing. |

The pre-existing theme IDs remain supported and selectable. Similar old labels (`receiver`, `glass`, `majlis`) are not aliases for the new designs; the new concepts use their own IDs so an existing selection is never silently replaced.

## New interface styles

| Interface ID | Navigation | Home hierarchy | Intended remote use |
|---|---|---|---|
| `rail` — Side Rail | Persistent left rail, mirrored in RTL; content reserves the full rail width. | Profile/status block plus one large live route and four quick routes. | Find a destination with predictable Up/Down then OK. |
| `command` — Command Center | Compact horizontal command dock below the status row. | Profile status and clock at left; a large Live command plus operational content routes. | Fast high-level control without giving up account status. |
| `guide` — Guide First | Persistent left rail, mirrored in RTL. | Home becomes a live-guide landing surface: guide title/action and a channel row, with the full guide one OK press away. | Live TV and programme discovery are the first task. |
| `spotlight` — Spotlight | Compact centered horizontal dock. | One cinematic Live decision with four supporting destinations and a continue-watching strip. | A simple, visually focused return-to-TV experience. |
| `mosaic` — Mosaic / App Grid | Compact centered horizontal dock. | Eight equal, remote-friendly destination tiles. | Explore all core routes quickly with directional keys. |

`classic`, `trio` and `dashboard` are retained as **legacy selectable** styles. Saved settings and imported backups therefore retain their existing behaviour. The previous `viu` and `ibo` aliases still normalize to their established legacy values in storage.

## Accessibility and interaction contract

- The existing focus modes (Glow, Ring and Zoom) remain the only focus policy. New themes provide variables and do not change the keyboard/remote handler.
- High contrast adds an explicit black navigation dock, white selected route and yellow focus outline over every new interface style.
- Large UI enlarges rail labels and command-dock labels instead of hiding them.
- RTL mirrors both side rails **and** reserves the corresponding content edge; tile positioning and icon spacing are mirrored as well.
- Home tile elements preserve existing `data-nav`, `data-section` and `data-action` contracts. There are no duplicate players, no change to playback routes and no network work added by a visual selection.

## Verification matrix

The automated `tests/theme-interface-matrix.test.js` guards the structural matrix:

- all 5 themes are present in the selector, controller and final stylesheet;
- all 5 interfaces are present in the selector, controller and final stylesheet;
- `data-interface` is applied separately from `data-theme`;
- Guide First is chosen by layout ID and the old `guidepro` theme redirect is absent;
- every one of the 25 pairs is represented by an independent theme token contract plus an independent interface geometry contract;
- legacy layout IDs remain selectable.

Manual device audit should additionally select each style with each theme, then visit Live, Guide, Movies, Series, Search, Favorites, Settings and Player. Confirm directional focus, BACK return, language/RTL, Large UI and High Contrast in each style. This is visual work only: provider storage, favorites, recent history, parental settings and playback modules are intentionally untouched.
