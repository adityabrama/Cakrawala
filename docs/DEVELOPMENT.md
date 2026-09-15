# Development

```powershell
npm ci                       # install (Node 24)
npm run dev                  # Vite dev server + every proxy + the intelligence engine
npm test                     # 2 900+ unit tests (node:test)
npm run build                # production bundle → dist/
npm run preview              # serve dist/ with the same proxies and engine
node scripts/build-indonesia-pack.mjs   # refresh bundled Indonesia data (network)
node scripts/build-indonesia-provinces.mjs   # dissolve regency polygons into province outlines (offline)
```

One command starts everything: the Vite plugins in `vite.config.js` host the
upstream proxies and `server/intelligence/vitePlugin.js` hosts the
intelligence engine. There is no second server. Modules under `src/` must
stay free of `node:` imports (a unit test enforces it); Node-only code lives
under `server/`.

## Where things live

| Path | What |
| --- | --- |
| `src/main.js` | Cesium viewer bootstrap, layer registration, UI init |
| `src/data/*.js` | Data layers (one module per source) registered in `DataLayerManager` |
| `src/data/intelEvents.js` | Cesium layers for intelligence events (`id-events`, `id-news`) |
| `src/intelligence/` | Engine core (browser-safe, no Node imports): event schema, geo, sweep, delta, alerts, correlation, brief, engine |
| `server/intelligence/` | Node-only: sweep memory on disk, the Indonesia pack loader, and the Vite plugin serving `/api/intel/*` |
| `src/providers/` | One adapter per upstream source (`provider.js` documents the contract) |
| `src/data/indonesia/` | Bundled pack: provinces, regencies, volcanoes, airports, BMKG weather points |
| `src/data/local_data/indonesia/` | Regency boundaries (BNPB / Kemendagri, simplified) |
| `src/indonesia/` | Command center drawer, shared state, camera helpers, API client, CSS |
| `src/gis/` | MapLibre GIS map, 3D↔GIS mode controller, spatial toolbox, analysis panel |
| `src/voice/indonesiaTools.js` | Voice/AI tools for the above (schemas live in `vite.config.js`) |
| `docs/` | Architecture, license audit, data sources, API setup, troubleshooting |

## Adding an intelligence provider

1. Create `src/providers/<id>.js` with `defineProvider({...})` — see
   `provider.js` for the contract. `fetch()` returns `{ events, metrics, meta }`;
   events follow `src/intelligence/eventSchema.js` (id, source, timestamp,
   location, severity, status, attribution are mandatory).
2. Register it in `src/providers/index.js`.
3. Add a parser test in `src/providers/providers.test.mjs` with an inline
   fixture of the upstream payload.
4. Document it in `docs/INDONESIA-DATA-SOURCES.md` and `DATA_SOURCES.md`, and
   add its credit to `src/data/dataCredits.js`.

Keys are read from `process.env` by the engine only; never expose a key in an
event or an API response. A provider that needs a key declares `envKey` and
shows as NOT CONFIGURED until it is set.

## Adding a data pack for another country

The pack is a folder convention, not code: provinces/regencies/points JSON
under `src/data/<country>/`, boundaries under `src/data/local_data/<country>/`,
and providers whose `region` matches. `server/intelligence/pack.js` is the loader to copy.

## Tests

- Unit: `npm test` (parallel `node --test` over `src/**/*.test.mjs`, plus two
  serialized allocation probes).
- Engine end-to-end: start `npm run dev`, then `GET /api/intel/status`,
  `/events`, `/alerts`, `/brief`, `/weather?city=jakarta`,
  `/boundaries/regencies`.
- Browser QA scripts live in `scripts/qa-*.mjs` (Puppeteer).
