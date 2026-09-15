# Integration architecture — CAKRAWALA × Crucix × GeoLibre, Indonesia first

Status: living document. Written 2026-09-15 after auditing all three
repositories (`docs/LICENSE-AUDIT.md` has the license side).

## 1. What was audited

| Repository | Shape | What matters for this integration |
| --- | --- | --- |
| **CAKRAWALA** (God's Eye View, this repo) | Vanilla JS + Vite. Cesium 1.138 globe (`src/main.js`), `DataLayerManager` (`src/data/manager.js`) with a strict layer lifecycle, 16 data layers, world-overlay label host, voice agent (OpenAI Realtime, tools defined server-side in `vite.config.js` and executed by `src/voice/gevActions.js`), 20 dev-server proxy plugins in `vite.config.js`, 2 853 unit tests, Pinokio launcher. | Everything is kept. New work plugs into the same manager/plugin/tool seams. |
| **Crucix** (AGPL) | Express server + one 1 782-line HTML dashboard. 29 OSINT `briefing()` source adapters run in parallel every 15 min with a 30 s timeout each; a delta engine compares sweeps; hot/cold JSON memory; Telegram/Discord alerts; optional LLM. | Concept source for the **intelligence engine** (sweep, normalise, delta, alerts, brief, source health). No code reused. |
| **GeoLibre** (MIT) | React/TypeScript monorepo: MapLibre + Cesium dual engine behind a capability interface, Turf vector tools, DuckDB-WASM, ~80 plugins, plugin/assistant tool registry. | Pattern source for the **GIS bridge** (MapLibre 2D mode, capability seam, Turf toolbox). Only `maplibre-gl` and `@turf/*` are added as dependencies. |

## 2. Rule zero: the running application is not rebuilt

The user's instruction and the master prompt agree: CAKRAWALA works, so the
integration is **additive**. Concretely:

- No existing layer, proxy, panel, keyboard shortcut, share-link token, or
  voice tool changes behaviour. New layers get new ids and new share tokens.
- New UI lives in new DOM blocks (`#indonesia-panel`, `#gis-root`,
  `#intel-timeline`) that reuse the existing `.panel-collapsible` chrome.
- New server code lives in `src/intelligence/`, `src/providers/`, `src/gis/`,
  `src/indonesia/`, and one new Vite plugin `intelligenceProxy()` appended to
  the plugin list.
- Anything that would degrade the current look or feel is dropped rather than
  "adapted" (user instruction: "kalau ada yang diganti menjadi jelek/rusak,
  tidak usah").

## 3. Target architecture

```
                 ┌──────────────────────────────────────────┐
                 │  CAKRAWALA client (index.html, src/)      │
                 │  Cesium 3D globe ── GIS map (MapLibre)    │
                 │  Data layers ── Indonesia panel ── Voice  │
                 └───────────────┬──────────────────────────┘
                                 │ /api/*
        ┌────────────────────────┼──────────────────────────┐
        │ existing proxies       │ NEW intelligenceProxy()   │
        │ (opensky, firms, …)    │ /api/intel/status         │
        │                        │ /api/intel/events         │
        │                        │ /api/intel/alerts         │
        │                        │ /api/intel/brief          │
        │                        │ /api/intel/weather        │
        │                        │ /api/intel/boundaries/*   │
        │                        │ /api/intel/stream (SSE)   │
        └────────────────────────┼──────────────────────────┘
                                 │
                   src/intelligence/  (engine core, browser-safe)
                   ├─ eventSchema.js   normalised event + validation
                   ├─ geo.js           bbox, point-in-polygon, area locator
                   ├─ sweep.js         parallel provider sweep, timeouts, health
                   ├─ delta.js         change detection between sweeps
                   ├─ alerts.js        INFO…CRITICAL rules, cooldown, escalations
                   ├─ correlate.js     spatial/temporal "related signals"
                   ├─ brief.js         rule-based Indonesia / region brief
                   └─ server.js        engine (cadence, retention, alerts, queries)
                   server/intelligence/ (Node only)
                   ├─ memory.js        hot/cold run history + alerts on disk
                   ├─ pack.js          Indonesia data-pack loader + locators
                   └─ vitePlugin.js    /api/intel/* middlewares, SSE
                                 │
                   src/providers/      (one adapter per source)
                   ├─ provider.js      interface + helpers
                   ├─ bmkgQuakes.js    BMKG TEWS autogempa/terkini/dirasakan
                   ├─ usgsIndonesia.js USGS bbox query
                   ├─ bnpbWeekly.js    BNPB Kejadian Bencana Mingguan
                   ├─ magmaVolcano.js  PVMBG activity levels (web table)
                   ├─ gdeltIndonesia.js news (rate-limited, cached)
                   ├─ bmkgWeather.js   official forecast by adm4 code
                   ├─ openMeteo.js     weather + air quality fallback
                   ├─ worldBank.js     Indonesia indicators
                   ├─ frankfurter.js   IDR reference rate
                   └─ reliefweb.js     NOT CONFIGURED without appname
                                 │
                   src/data/indonesia/ (bundled snapshots, offline capable)
                   ├─ provinces.json   38 provinces: code, name, capital, view
                   ├─ cities.json      city presets
                   ├─ volcanoes.json   Wikidata CC0 positions
                   ├─ airports.json    OurAirports (ID only)
                   └─ weatherPoints.json BMKG adm4 codes for major cities
```

### 3.1 Provider interface (`src/providers/provider.js`)

```js
{
  id, name, category,           // category: disaster|earthquake|volcano|weather|news|economy|transport|…
  region: 'ID' | 'GLOBAL',
  auth: 'keyless' | 'free-key' | 'paid',
  envKey?: 'RELIEFWEB_APPNAME',  // when auth !== 'keyless'
  intervalMs,                   // sweep cadence for this provider
  attribution, license, sourceUrl,
  isConfigured(env) → boolean,
  fetch({ fetchImpl, signal, env, cache }) → { events: Event[], metrics: {}, meta: {} }
}
```

`fetch` never throws for bad upstream data: it returns fewer events. The
sweep wraps it in a timeout and records `ok | error | skipped(not-configured)`.

### 3.2 Event schema (`src/intelligence/eventSchema.js`)

The normalised record required by the master prompt §8. Every provider emits
it; the client, alerts, correlation, and brief consume only this shape.

```js
{
  id, source, sourceUrl, type, subtype,
  timestamp,                      // ISO, UTC
  location: { lat, lon, depthKm? },
  geometry?,                      // GeoJSON when the source has one (BNPB polygons)
  title, description,
  severity: 'info'|'low'|'medium'|'high'|'critical',
  confidence: 0..1,
  status: 'live'|'delayed'|'modeled'|'estimated'|'historical',
  entities: [], region, country, province, city,
  raw,                            // compact provenance
  attribution
}
```

### 3.3 Data-freshness vocabulary

`live` (upstream timestamp < 2× interval old), `delayed`, `modeled`
(Open-Meteo, CAMS), `estimated`, `historical`. The client renders the label
next to every count; the layer manager already exposes
`nominal/stale/degraded/fallback/unavailable` chip states and the new layers
feed those from the same status.

### 3.4 GIS bridge (`src/gis/`)

- `gisMap.js` — a MapLibre GL map in `#gis-root`, hidden by default, using
  the keyless OpenFreeMap vector style (attribution kept). Admin boundaries
  come from `/api/intel/boundaries/{provinces|regencies}` (BNPB hosted
  Kemendagri polygons, simplified server-side, cached on disk).
- `mapModeController.js` — `3d ↔ gis` switch. Reads the Cesium camera
  (centre, height → zoom, heading), applies it to MapLibre, and back. The
  selected region, enabled event types, and timeline range are shared state
  (`src/indonesia/indonesiaState.js`).
- `spatialTools.js` — Turf-backed toolbox: buffer, distance, bearing, area,
  centroid, point-in-polygon, nearest, bbox, intersect, union, GeoJSON/CSV
  export. Pure functions with unit tests.

### 3.5 Indonesia mode (`src/indonesia/`)

- `indonesiaState.js` — `{ enabled, province, regency, timeline, eventTypes }`
  with subscribe/notify; persisted like layer state (own key).
- `indonesiaPanel.js` — the 🇮🇩 panel (right rail): Alert Center, Disaster
  Center filters, Recent Indonesia Earthquakes, Weather (province/city/click),
  Indonesia Brief, provider health. Reuses `.panel-collapsible`.
- Default region: with no share link the first flight goes to an
  Indonesia-wide view instead of Austin (`flyToIndonesia`); the Austin/global
  presets remain one click away.
- Province and city presets: `provinces.json` (38, Kemendagri codes) and
  `cities.json` (14 cities from the master prompt) drive the location bar and
  the `fly_to_location` voice tool.

### 3.6 New Cesium data layers (registered in `DataLayerManager`)

| id | token | content | source |
| --- | --- | --- | --- |
| `id-disasters` | `n` | BNPB weekly disaster events (polygon centroids + counts), BMKG felt quakes, volcano alert levels | BNPB, BMKG, PVMBG/Wikidata |
| `id-news` | `j` | GDELT geolocated Indonesia news points (metadata + link only) | GDELT |

Tokens are new letters not used by `LAYER_STATE_REGISTRY`. The existing
`earthquakes` (USGS world) and `local-firms` layers are untouched; the panel
shows Indonesia subsets through `/api/intel/events`.

### 3.7 Voice / AI tools

New tools are added to the server-side tool list (`vite.config.js`) and
handled in `src/voice/gevActions.js`, following the existing
`name === '…'` dispatch: `get_indonesia_summary`, `get_region_summary`,
`query_events`, `query_nearby_events`, `set_indonesia_mode`,
`set_map_mode`, `get_data_source_status`, `spatial_buffer`,
`measure_distance`, `set_timeline_range`. Each returns structured JSON and
never claims success without a result.

## 4. What is *not* integrated (and why)

| Item | Reason |
| --- | --- |
| Crucix dashboard, globe.gl, Telegram/Discord bots, trade ideas, market feeds | AGPL; different product; finance advice excluded by policy |
| GeoLibre React app, DuckDB-WASM, deck.gl, Whitebox | Size and framework mismatch with a vanilla Cesium app; follow-up candidate for large local files |
| MAGMA per-volcano reports, BMKG maritime API, data.go.id CKAN | Not exposed as JSON (HTML only / 404 at audit time) |
| Air-quality station networks (OpenAQ, WAQI, IQAir) | Keys required; Open-Meteo CAMS (modeled, labelled) is the keyless fallback |

## 5. Implementation checklist

Phase order follows the master prompt §70. ☑ = done in this branch.

- [x] P1 Audit all repositories
- [x] P2 License audit (`docs/LICENSE-AUDIT.md`)
- [x] P3 Unified architecture (this document)
- [x] P4 Branch `feature/cakrawala-indonesia-integration` + baseline commit
- [x] P5 Baseline: 2 853 unit tests pass before any integration code
- [x] P6 Intelligence engine (`src/intelligence/`, `/api/intel/*`, 13 unit tests + live end-to-end run)
- [x] P7 GIS engine (`src/gis/`: MapLibre map, 3D↔GIS mode controller, Turf toolbox, tests)
- [x] P8 Provider architecture (`src/providers/`: 9 sweep providers + Open-Meteo on demand, health, retention, cooldowns)
- [x] P9 Indonesia data pack (`src/data/indonesia/`, `local_data/indonesia/regencies.geojson`, `/api/intel/boundaries`)
- [x] P10 Disaster / weather / volcano / earthquake views (EVENTS + WEATHER tabs, `id-events` layer, GIS layers)
- [~] P11 Aviation / maritime / transport: 624 Indonesian airports in the GIS map and buffer tool; aircraft/vessel layers unchanged (OpenSky, adsb.lol, AISStream already cover Indonesian airspace and straits); no Indonesian rail/port/toll dataset with a public API was found (see INDONESIA-DATA-SOURCES.md)
- [x] P12 Event aggregation + correlation (`correlate.js`: related signals, clusters; `/events/:id`)
- [x] P13 Timeline (window presets 1 h–30 d, scrub, playback; shared by globe, drawer, GIS)
- [x] P14 GIS analysis panel (measure, buffer, nearest, province focus, point weather, GeoJSON/CSV export)
- [x] P15 AI tools (9 tools in `vite.config.js` schema + `src/voice/indonesiaTools.js`, tests)
- [x] P16 Alerts + Indonesia Brief (rule-based, cooldowns, persisted; brief per Indonesia/province)
- [x] P17 Performance: point primitives + shared label host for events, lazy MapLibre import, pre-bundled deps, paused globe in GIS mode
- [x] P18 Security/privacy: keys server-side only, no PII, public/official sources only, SSRF-safe proxies unchanged, no face/person features
- [x] P19 Tests (`npm test` green; browser QA of drawer, layers, GIS mode)
- [x] P20 Documentation (README, DATA_SOURCES, INDONESIA-DATA-SOURCES, API-SETUP, TROUBLESHOOTING, DEVELOPMENT, ARCHITECTURE, THIRD_PARTY_NOTICES)
- [x] P21 Production build (`npm run build` passes)

Also delivered after the first pass: province outlines as a bundled dataset (dissolved from the regency polygons because BNPB `Admin_Prov` returns HTTP 500), a severity-weighted event heatmap layer in the GIS map (MapLibre `heatmap`, off by default), share-link support for Indonesia mode / province / GIS mode via one allowlisted `idn` hash field (`ShareLinkManager.setExtraStateProvider`; core camera and visual fields can never be overridden by it), and ReliefWeb in the in-app Provider Settings panel.

Not done in this phase (documented follow-ups): DuckDB-WASM local file analysis, deck.gl layers (the GIS map uses MapLibre circle/heatmap layers; the globe uses point primitives), LLM-written briefs (rule-based brief only).
