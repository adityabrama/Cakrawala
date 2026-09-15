# Third-party notices

CAKRAWALA (God's Eye View) is MIT licensed. The components below are
distributed with or used by the application under their own licenses.

## Design and pattern sources

- **GeoLibre** — MIT License, Copyright (c) 2026 Qiusheng Wu
  (https://github.com/opengeos/GeoLibre). The GIS bridge in `src/gis/`
  follows GeoLibre's engine-neutral map interface and its vector toolbox
  semantics (buffer, centroid, intersection, union, select by location).
  No GeoLibre source files are copied verbatim.
- **Crucix** — AGPL-3.0-only (https://github.com/calesthio/Crucix).
  Acknowledged as the design inspiration for the intelligence engine
  (parallel source sweeps, change detection, alert tiers, sweep memory,
  briefings). **No Crucix code is included**; `src/intelligence/` is an
  independent implementation. See `docs/LICENSE-AUDIT.md`.

## npm dependencies added for the integration

| Package | License | Use |
| --- | --- | --- |
| maplibre-gl | BSD-3-Clause | 2D GIS map |
| @turf/area, @turf/bbox, @turf/bearing, @turf/boolean-point-in-polygon, @turf/buffer, @turf/centroid, @turf/distance, @turf/helpers, @turf/intersect, @turf/length, @turf/nearest-point, @turf/union | MIT | Spatial analysis toolbox |

## Basemaps used by the GIS map

- OpenFreeMap (Liberty, Positron styles) — tiles © OpenMapTiles,
  data © OpenStreetMap contributors (ODbL). Attribution is rendered by MapLibre.
- Esri World Imagery — © Esri, Maxar, Earthstar Geographics, and the GIS
  User Community. Attribution is rendered by MapLibre.
- Glyphs (Noto Sans) — served by OpenFreeMap; Noto is SIL OFL 1.1.

## Data

Data licenses and required attributions are listed in `DATA_SOURCES.md`
and `docs/INDONESIA-DATA-SOURCES.md`, and are shown in-app in the Data
attribution popover and in the SOURCES tab of the Indonesia command center.
