# License audit — CAKRAWALA integration of Crucix and GeoLibre

Audited 2026-09-15 against the repositories' `LICENSE` files and `package.json`
manifests (cloned at that date). This document decides what may be copied,
what must be reimplemented, and what attribution the result carries.

| Project | Upstream | License | Verdict |
| --- | --- | --- | --- |
| God's Eye View (this app, CAKRAWALA) | github.com/bilawalsidhu/gods-eye-view | MIT | Primary application. Unchanged license. |
| GeoLibre | github.com/opengeos/GeoLibre | MIT (Copyright (c) 2026 Qiusheng Wu) | Code and ideas may be reused. Any copied file or function keeps the MIT notice in `THIRD_PARTY_NOTICES.md`. |
| Crucix | github.com/calesthio/Crucix | **AGPL-3.0-only** | **No source code is copied.** Only the *concepts* (sweep, delta, alert tiers, memory, briefing) are reimplemented independently from the published README and from reading the code for behaviour, not for text. |

## Why Crucix code is not copied

The MIT license of this application does not survive an AGPL-3.0 merge:

- Copying Crucix source (or a close translation of it) into `src/` would make
  the combined work a derivative of Crucix, and AGPL-3.0 §5 / §13 would then
  govern the whole application, including the network-use disclosure duty.
- Running Crucix as a separate service that this app talks to over HTTP is the
  only way to use its *code* without relicensing. That is not what this
  integration needs: the intelligence engine has to sit inside the same Vite
  dev server so `npm run dev` stays the single start command.

Decision: **clean-room reimplementation** in `src/intelligence/`. The module
was written from the following behavioural notes, without carrying any Crucix
text, identifiers, thresholds tables, or prompt files across:

| Crucix concept (observed) | CAKRAWALA implementation |
| --- | --- |
| Parallel source sweep with a per-source timeout and `allSettled` health summary | `src/intelligence/sweep.js` (`runProviderSweep`) |
| Delta engine: numeric %-thresholds, count thresholds, severity tiers, "new" signals with stable-key dedup | `src/intelligence/delta.js` — thresholds are per provider metric, defined by each provider |
| Hot/cold run memory with atomic writes and alert cooldown decay | `server/intelligence/memory.js` (`.gev-intel/` on disk, git-ignored) |
| SSE push of sweep results, `/api/data`, `/api/status` | `/api/intel/*` middlewares in `vite.config.js` (`intelligenceProxy`) |
| Briefing text | `src/intelligence/brief.js` — rule-based, source-stamped; LLM optional |
| Region filters on a globe.gl dashboard | Not integrated. CAKRAWALA already has a Cesium globe. |
| Telegram / Discord bots, trade-idea generation, market data (yfinance, FRED, etc.) | Not integrated. Out of scope for a geospatial platform; financial idea generation is deliberately excluded. |

Crucix is credited in `docs/INTEGRATION-ARCHITECTURE.md` and the README as the
design inspiration for the intelligence engine. No AGPL obligation attaches
because no AGPL code is distributed.

## GeoLibre reuse

GeoLibre is MIT. Its packages, however, are React 19 + Zustand + TypeScript
workspaces with ~80 MapLibre plugins and a DuckDB-WASM/Whitebox-WASM
toolchain. Importing `@geolibre/*` wholesale would add React and several tens
of megabytes of WASM to a vanilla-JS Cesium app, so the integration takes
GeoLibre's *approach* and its lightweight dependencies rather than its
packages:

| GeoLibre element | Used how |
| --- | --- |
| MapLibre GL JS as the 2D GIS engine | `maplibre-gl` (BSD-3-Clause) added as a direct dependency; `src/gis/gisMap.js` |
| Turf-based vector tools (`packages/processing/src/vector-tools.ts`: buffer, centroid, clip, intersection, union, spatial join, select-by-location) | The same `@turf/*` packages (MIT) drive `src/gis/spatialTools.js`. Tool semantics follow GeoLibre's; code is written for this app. |
| `MapEngine` capability interface (`packages/map/src/map-engine.ts`) | Pattern for `src/gis/mapModeController.js`: the 3D globe and the GIS map expose the same `getView()/applyView()` seam so switching keeps the location. |
| Nominatim provider rules (`packages/core/src/geocoding.ts`: public host, ≥1.1 s between requests) | Honoured by the existing regional-brief proxy; no new Nominatim traffic added. |
| DuckDB-WASM Spatial, deck.gl, Whitebox WASM | **Not integrated** in this phase (size, and Cesium already renders the heavy layers). Documented as a follow-up. |

Any function ported from GeoLibre keeps a `// Ported from GeoLibre (MIT)`
comment at the definition and an entry in `THIRD_PARTY_NOTICES.md`.

## New third-party dependencies

| Package | License | Purpose |
| --- | --- | --- |
| `maplibre-gl` | BSD-3-Clause | 2D GIS map |
| `@turf/buffer`, `@turf/distance`, `@turf/bearing`, `@turf/area`, `@turf/centroid`, `@turf/boolean-point-in-polygon`, `@turf/nearest-point`, `@turf/bbox`, `@turf/intersect`, `@turf/union`, `@turf/helpers` | MIT | Spatial toolbox |

## Data licenses (Indonesia data pack)

Data is not covered by the MIT code license. Every provider records its own
license and attribution in `src/providers/*.js` (`attribution`, `license`)
and in `docs/INDONESIA-DATA-SOURCES.md`. Summary:

| Source | License / terms | Attribution string |
| --- | --- | --- |
| BMKG (gempa TEWS JSON, prakiraan cuaca API) | Public data of BMKG; attribution required | "Data: BMKG (bmkg.go.id)" |
| USGS earthquakes | Public domain (US Government) | "USGS Earthquake Hazards Program" |
| BNPB GIS (Kejadian Bencana Mingguan, Admin_kabkot_2023) | Public ArcGIS services of BNPB; attribution | "BNPB — Pusdatinkom" |
| PVMBG MAGMA Indonesia (tingkat aktivitas gunung api — public web table) | Public information of Badan Geologi/PVMBG; attribution; **parsed from an HTML page, so labelled `web-table`** | "PVMBG / MAGMA Indonesia" |
| Wikidata (volcano positions) | CC0 | "Wikidata" |
| GDELT | Free for use with citation | "GDELT Project" |
| NASA FIRMS | NASA open data | existing credit |
| Open-Meteo | CC BY 4.0 | "Weather data by Open-Meteo.com" |
| World Bank Indicators API | CC BY 4.0 | "World Bank" |
| Frankfurter (ECB rates) | Free, ECB reference rates | "Frankfurter / ECB" |
| OurAirports | Public domain | "OurAirports" |
| wilayah.id (Kemendagri codes) | MIT (API), Kemendagri public data | "wilayah.id — Kemendagri" |
| ReliefWeb | Requires registered `appname` (HTTP 410 without it) | NOT CONFIGURED until `RELIEFWEB_APPNAME` is set |

## Result

- The application remains **MIT**.
- `THIRD_PARTY_NOTICES.md` lists GeoLibre (MIT) for ported patterns and the
  new npm dependencies.
- Crucix is acknowledged as inspiration only; its code is not part of the
  distribution, so no AGPL terms apply.
