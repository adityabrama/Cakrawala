# Architecture

```
Browser (Vite dev/preview)                        Dev server (Vite plugins)
┌───────────────────────────────────────────┐    ┌──────────────────────────────┐
│ Cesium 3D globe (photoreal / Esri / OSM)  │    │ Upstream proxies             │
│  ├ DataLayerManager → 18 data layers      │◄──►│  opensky, adsb.lol, AIS,     │
│  │   incl. id-events / id-news            │    │  celestrak, firms, tomtom,   │
│  ├ World overlay (labels, detection)      │    │  overpass, cctv (+HLS), …    │
│  ├ HUD, cockpit, scene director, voice    │    ├──────────────────────────────┤
│  └ Indonesia command center (drawer)      │◄──►│ Intelligence engine          │
│      alerts · events · weather · brief    │    │  src/intelligence/*          │
│      economy · sources · timeline         │    │  providers on own cadence,   │
│ GIS map (MapLibre) ◄── mode controller ──►│    │  delta, alerts, brief, SSE   │
│  boundaries · events · toolbox · export   │    │  /api/intel/*                │
└───────────────────────────────────────────┘    └──────────────────────────────┘
```

- **One application, one command.** `npm run dev` starts the client, every
  proxy, and the engine.
- **Additive integration.** The pre-existing globe, layers, panels, share
  links, and voice tools are unchanged; the Indonesia pieces live in new
  modules and DOM subtrees (`docs/INTEGRATION-ARCHITECTURE.md` §2).
- **Provenance everywhere.** Every intelligence event carries source, URL,
  timestamp, confidence, and freshness; alerts carry the rule that produced
  them; correlations are labelled correlations.
- **Two map engines, one location.** The 3D↔GIS switch converts camera
  height to zoom and back (`src/gis/mapModeController.js`), and both engines
  read the same shared Indonesia state (province, window, type filters).

Deeper detail: `docs/INTEGRATION-ARCHITECTURE.md`, `docs/CURRENT-STATE.md`,
`docs/PERFORMANCE.md`, `docs/LICENSE-AUDIT.md`.
