# Indonesia data sources

Every source the Indonesia data pack and the intelligence engine use, with
what it provides, how it is accessed, how fresh it is, and the attribution
its terms require. Verified 2026-09-15 from the user's network; availability
is re-checked by the engine on every sweep and shown in the SOURCES tab of
the Indonesia command center.

Freshness vocabulary (shown on every event): **LIVE** — the source publishes
in near real time and the record is recent; **DELAYED** — compiled or
published on a schedule (weekly reports, daily reference rates);
**MODELED** — a model output (forecast, CAMS air quality); **ESTIMATED** —
derived by this app (a news location matched from a headline);
**HISTORICAL** — older than the source's own reporting window.

## Live and scheduled providers (`src/providers/`)

| Provider id | Source | What | Access | Cadence | Freshness | License / attribution |
| --- | --- | --- | --- | --- | --- | --- |
| `bmkg-quakes` | BMKG TEWS — `data.bmkg.go.id/DataMKG/TEWS/{autogempa,gempaterkini,gempadirasakan}.json` | Latest earthquake, last 15 M5+, last 15 felt; tsunami-potential text; shakemap link | keyless | 5 min | LIVE | Public data of BMKG — "Data gempabumi: BMKG (bmkg.go.id)" |
| `usgs-indonesia` | USGS FDSN event service, Indonesia envelope (94.5–141.5 E, −11.5–6.5 N), M2.5+, 7 days | Full earthquake catalogue with review status and PAGER alert | keyless | 10 min | LIVE | Public domain (US Government) |
| `bnpb-weekly` | BNPB GIS — `Kejadian_Bencana_Mingguan/MapServer/25` | Compiled disaster reports per kabupaten: category, casualties, displaced, houses damaged, chronology | keyless (ArcGIS REST) | 60 min | DELAYED, HISTORICAL after 14 days | BNPB Pusdatinkom; attribution required |
| `magma-volcano` | PVMBG MAGMA Indonesia — `magma.esdm.go.id/v1/gunung-api/tingkat-aktivitas` | Activity level (I–IV) of every monitored volcano, report links | keyless, **parsed from the public HTML table** (no JSON endpoint at audit time) | 30 min | LIVE (state) | Badan Geologi / PVMBG; labelled `web-table` |
| `gdelt-indonesia` | GDELT DOC 2.0 — `api.gdeltproject.org/api/v2/doc/doc` (`Indonesia sourcecountry:ID`) | Headlines, links, outlet, language; location **estimated** by matching province/regency/city names in the headline | keyless, ≥ 5 s between requests | 15 min | LIVE / location ESTIMATED | GDELT terms; metadata and links only, never article bodies |
| `bmkg-weather` | BMKG public API — `api.bmkg.go.id/publik/prakiraan-cuaca?adm4=` | 3-day, 3-hourly forecast for 26 city points (kelurahan codes in `weatherPoints.json`) | keyless | 60 min | MODELED | Public API of BMKG — "Prakiraan cuaca: BMKG" |
| `world-bank-indonesia` | World Bank Indicators API | GDP, GDP growth, inflation, unemployment, population, poverty (annual) | keyless | 24 h | HISTORICAL | CC BY 4.0 |
| `frankfurter-idr` | Frankfurter (ECB reference rates) | IDR per USD/EUR/SGD/JPY/CNY | keyless | 6 h | DELAYED | ECB reference rates via frankfurter.app |
| `reliefweb-indonesia` | ReliefWeb (UN OCHA) disasters, country IDN | Ongoing disasters, GLIDE numbers | **`RELIEFWEB_APPNAME` required** (HTTP 410 without a registered appname since Nov 2025) | 60 min | DELAYED | ReliefWeb API terms |
| `open-meteo` (on demand) | Open-Meteo forecast + air-quality APIs | Current + 24 h weather and CAMS PM2.5/PM10/AQI at any coordinate (map centre, GIS click, province capital) | keyless | on request, 10-min cache | MODELED | CC BY 4.0 — "Weather data by Open-Meteo.com" |

Existing CAKRAWALA layers that already cover Indonesia and stay unchanged:
NASA FIRMS active fires (`FIRMS_MAP_KEY`), OpenSky / adsb.lol aircraft,
AISStream vessels (`AISSTREAM_API_KEY`), CelesTrak satellites, TomTom /
OpenStreetMap traffic, the Indonesian public CCTV packs (BMKG-independent,
see `DATA_SOURCES.md`).

## Bundled snapshots (`src/data/indonesia/`, `src/data/local_data/indonesia/`)

Built by `node scripts/build-indonesia-pack.mjs` and committed so the app
works offline and never hits these hosts at start-up.

| File | Source | Content | License |
| --- | --- | --- | --- |
| `provinces.json` | wilayah.id (Kemendagri codes) + curated capitals | 38 provinces: code, name, capital, capital coordinates, island group, bbox (from regency polygons) | Kemendagri public data; wilayah.id API is MIT |
| `regencies.json` | wilayah.id | 514 kabupaten/kota: code, name, province, centroid, bbox | as above |
| `local_data/indonesia/regencies.geojson` | BNPB GIS `Hosted/Admin_kabkot_2023` (Kemendagri boundaries), simplified 0.01° | 514 polygons, 1.9 MB | BNPB public service; attribution "Batas administrasi: BNPB / Kemendagri" |
| `local_data/indonesia/provinces.geojson` | Derived offline: regency polygons dissolved per province code (`scripts/build-indonesia-provinces.mjs`, Turf union) | 38 polygons, 1.2 MB | Same BNPB / Kemendagri attribution, marked "diturunkan (dissolve)" |
| `volcanoes.json` | Wikidata SPARQL (instances of volcano in Indonesia with coordinates) | 139 volcanoes: name, position, elevation | CC0 |
| `airports.json` | OurAirports `airports.csv`, `iso_country = ID`, large/medium/small | 624 airports: ident, IATA, name, position, municipality, ISO region | Public domain |
| `weatherPoints.json` | wilayah.id + BMKG validation | 26 city points with their BMKG `adm4` codes | Kemendagri codes |

BNPB's `Hosted/Admin_Prov` service returned HTTP 500 during every build, so
province polygons are derived instead of downloaded: `scripts/build-indonesia-provinces.mjs`
unions the regency polygons per two-digit province code (Papua Barat Daya's
Raja Ampat islands fail the union and are kept as their member polygons).
`scripts/build-indonesia-pack.mjs` still prefers the official layer whenever
that service answers. The GIS map draws the dissolved outlines, highlights the
focused province from them, and falls back to grouping regencies by code
prefix while `provinces.geojson` is absent.

## Sources checked and not used

| Source | Result at audit | Decision |
| --- | --- | --- |
| BMKG `prakiraan-cuaca?adm1/adm2/adm3` | HTML error page (only `adm4` returns JSON) | Use adm4 points |
| BMKG maritime API, peringatan dini cuaca | 404 / HTML only | Not integrated |
| MAGMA `api/v1/*` | 404 | Activity table parsed instead |
| data.go.id CKAN API | 404 (portal migrated) | Not integrated |
| Smithsonian GVP WFS | Timed out (> 90 s) twice | Wikidata positions instead |
| geoBoundaries IDN ADM1 | 2017 data, 34 provinces (pre-2022 split) | Rejected as outdated; BNPB/Kemendagri 2023 used |
| HDX `cod-ab-idn` | Current (2026-08) but 456 MB GeoJSON | Too large to bundle; BNPB simplified service used |
| Jasa Marga WFS, Ontario 511 | Token / developer key required | Not integrated |
| OpenAQ, WAQI, IQAir | API keys required | Open-Meteo CAMS (modeled) used instead |

## Privacy and scope

Only public geography, public infrastructure, official bulletins, aggregate
statistics, and public news metadata are collected. No source here
identifies people; GDELT rows carry headline, outlet, and link only.
