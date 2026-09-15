# Troubleshooting

## Indonesia command center

**"First sweep pending" for more than a minute.** The engine starts four
seconds after the dev server listens and each source has a 30 s timeout, so
the first status normally arrives within 40 s. Check `GET /api/intel/status`:
`health[].state` names the failing source and `error` its reason. Sources
fail independently — one down source never blocks the others.

**A source shows ERROR / TIMEOUT.** Usually the upstream host, not the app:
`gdelt-indonesia` rate-limits to one request per 5 s and is flaky on some
networks; `bnpb-weekly` and `magma-volcano` are government servers that
occasionally answer 500 or slowly. The engine backs off and retries at a
quarter of the source's cadence (at least 2 min). Events already received
stay on the map with their original timestamps.

**ReliefWeb shows NOT CONFIGURED.** Expected without `RELIEFWEB_APPNAME`
(the API answers HTTP 410 to unregistered app names since Nov 2025).

**Alerts look empty.** Alerts are rule-based and time-bounded: felt quakes
must be M4+ within 24 h, M5+ within 3 days, volcano Level III/IV any time,
BNPB casualty reports within 14 days, severe forecasts within 24 h, plus
severity escalations between sweeps. Steady states (a volcano sitting at
Level II) are events, not alerts. Raised alerts persist in
`.gev-intel/hot.json` across restarts; delete that folder to reset.

**Events with no location.** GDELT headlines that mention no known
province/regency/city name stay in the EVENTS list without a map pin
(`raw.locationMethod = 'none'`); MAGMA volcanoes without a Wikidata position
keep their level without a pin (`meta.unplaced`).

## GIS map

**The GIS map opens but stays blank / grey.** The vector basemap is fetched
from `tiles.openfreemap.org`; on slow routes the style can take >20 s. The
map then switches itself to Esri World Imagery (raster) and logs
`[gis] … switching to Esri World Imagery`. You can also pick the basemap in
the SPATIAL ANALYSIS panel.

**Boundaries missing.** `GET /api/intel/boundaries/regencies` must return the
1.9 MB bundled GeoJSON. If it returns 404, run
`node scripts/build-indonesia-pack.mjs`, then
`node scripts/build-indonesia-provinces.mjs` for the province outlines
(`/api/intel/boundaries/provinces`). The pack is read once per server start,
so restart `npm run dev` after rebuilding it.

**Basemap draws, but no boundaries, events or airports (and no console
error).** MapLibre parses vector tiles and GeoJSON in a web worker that it
resolves relative to its own module URL; under Vite that file does not exist
next to the pre-bundled dep or the built chunk, so the worker never answers.
`src/gis/gisMap.js` therefore imports
`maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` and calls
`setWorkerUrl()`. If you upgrade `maplibre-gl`, keep that pairing and check
`map.isSourceLoaded('events')` in the console.

**The 3D globe looks frozen behind the map.** By design: the Cesium render
loop pauses while the GIS map is shown and resumes on "← 3D globe".

## CCTV

**"Only Bandung" in the camera dropdown.** The dropdown lists every loaded
camera grouped by city (`Yogyakarta (154)`, `Bandung (449)`, …); Bandung is the
largest Indonesian pack, so it fills the first screen. Scroll past it or use
NEAREST. `GET /api/cctv/sources` shows the full catalog; the
`[CCTV] <pack>: N cameras` lines in the server log (Pinokio:
`pinokio/logs/api/start.js/latest`) show which portals answered at boot.

**A city is missing.** Its portal was unreachable at boot (Yogyakarta and
Salatiga drop out regularly). Every successful catalog is cached in
`.gev-intel/cctv-catalog/<pack>.json` (30-day max age) and served when the
portal is down, so a city only disappears the very first time its portal is
down before it was ever seen. Camera frames are still fetched live — a cached
city whose portal is down shows placeholder monitors until it returns.

## Dev server

**`[vite] failed to connect to websocket` in the console.** Hot module
reload cannot connect when the page is opened on `localhost` while the server
listens on `127.0.0.1` (or the reverse). Open the URL Vite prints. The app
itself works; only live reload is affected.

**Editing `vite.config.js` reloads the page.** Vite restarts on config
changes; the intelligence engine restarts with it and re-sweeps.

**`npm test` says allocation budgets require Node 24.** The unit runner
calibrates two allocation probes on Node 24; use Node 24 (Pinokio ships it).

## Pinokio

Logs: `pinokio/logs/api/start.js/latest`. The launcher passes `{{port}}` to
Vite; if the port is busy, stop the other instance from the Pinokio UI.
