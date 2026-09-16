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
| `indonesia-news` | RSS feeds of ANTARA (`antaranews.com/rss/terkini.xml`), Sekretariat Kabinet RI (`setkab.go.id/feed/`), detikNews, CNN Indonesia (nasional), CNBC Indonesia (news), Liputan6 (news), Okezone (news), JPNN, Republika, BBC News Indonesia, SINDOnews, Media Indonesia | **Primary news source.** Headline, link, outlet and publication time; topic from whole-word matching; location **estimated** from place names in the headline | keyless; each feed polled independently (10 s timeout, one retry on a dropped connection, conditional GET via ETag / Last-Modified, whole sweep capped at 24 s) | 10 min | LIVE / location ESTIMATED | Publisher RSS; headline and link only — descriptions and article bodies are never stored |
| `gdelt-indonesia` | GDELT DOC 2.0 — `api.gdeltproject.org/api/v2/doc/doc` (`Indonesia sourcecountry:ID`) | Secondary news source: headlines, links, outlet, language; location **estimated** by matching province/regency/city names in the headline | keyless, ≥ 5 s between requests; answers HTTP 429 often, after which the engine waits 30 min | 15 min | LIVE / location ESTIMATED | GDELT terms; metadata and links only, never article bodies |
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

## Public CCTV portals

The CCTV layer's Indonesian packs are registered in `src/data/cctvPacks.js`
(`INDONESIA_CCTV_PACKS`). Each pack is fetched independently and its last good
catalog is cached under `.gev-intel/cctv-catalog/`, so one portal being down
never removes the others.

| Pack | Portal | Cameras | Notes |
| --- | --- | --- | --- |
| `yogyakarta` | cctv.jogjakota.go.id | ~154 | Public cameras only (`cctv_status` 0) |
| `bandung` | pelindung.bandung.go.id | ~449 | Largest single pack |
| `banda-aceh` | cctv.bandaacehkota.go.id | ~45 | Streams are CC BY 4.0 |
| `palembang` | cctv.palembang.go.id | ~30 | Public-scope, active only |
| `salatiga` | cctv.salatiga.go.id | ~34 | Stream needs the portal `Referer` |
| `bengkulu` | cctv.bengkulukota.go.id | ~25 | Stream URL redirects to fMP4 |
| `banjarmasin` | cctv.banjarmasinkota.go.id | ~25 | Stream needs the portal `Referer` |
| `semarang`, `semarang-dpu` | pantausemar.semarangkota.go.id | ~126 | See below |
| `sidoarjo` | pantaulalindishub.sidoarjokab.go.id | ~44 | See below |
| `pekalongan` | cctv.pekalongankota.go.id | ~44 | `/api/config`; only channels flagged `public: 1` |
| `depok` | dishub.depok.go.id/cctv | ~53 | Stream name is the camera address without dots |
| `bpjt-jabodetabek` | bpjt.pu.go.id/cctv | ~469 | Toll-road cameras around Jakarta; see below |

**Semarang** publishes 2,036 cameras across eight category pages. The two
registered packs carry the agency-operated cameras (Dinas Perhubungan, DPU,
Diskominfo). The `78076941-…` category holds another ~1,890 kecamatan cameras;
they are deliberately left out because they alone would exceed
`DEFAULT_CCTV_MAX_SOURCES` and push other cities out of the catalog. Add that
page as a tenth pack and raise the cap if you want them.

**Pekalongan** ships each camera internal RTSP address, credentials included, in the same /api/config payload. The parser reads only name, coordinates and the public flag, so that field never reaches a camera record (a unit test asserts it).

**BPJT** (Badan Pengatur Jalan Tol, Kementerian PU) embeds `const allStreams = {…}`
covering 1,530 cameras on 82 toll roads, each with an absolute playlist URL on
its concessionaire's host. The registered pack keeps the ~469 inside the
Jabodetabek envelope — the toll network through Jakarta, Bogor, Depok,
Tangerang and Bekasi, including Dalam Kota, JORR, Sedyatmo, Jakarta-Cikampek
and the MBZ elevated road. Set `CCTV_BPJT_NATIONAL=1` to load the national set
(~1,065 cameras) instead; raise `CCTV_MAX_SOURCES` with it or other cities are
trimmed. Rows the page reports offline, rows at 0/0, and rows whose `protocol`
claims m3u8 while pointing at an MJPEG endpoint are dropped.

Stream health varies by concessionaire: from the test network
`jmlive.jasamarga.com` (253 of the Jabodetabek cameras) answered HTTP 200 with
an empty body, and `stream.bsdtol.com`, `cctv.cctvdesari.online` and
`cijagolive.app-intracs.co.id` were unreachable, while `pub2.hk-opt.com`,
`streaming-cct.co.id` and `cctv.mms-corp.id` served valid playlists. Those
hosts are kept in the catalog rather than filtered out — they are what BPJT
publishes as online, the same ISP that poisons DNS here may be the cause, and
the per-camera health chip already reports an unusable feed.

**Sidoarjo** stores each camera's `video_src` as an internal address
(`http://127.0.0.1:3000/…`). Only the portal's own base64 proxy can serve it,
which is exactly what its player does, so the pack registers
`/proxy?url=<base64 of video_src>`. That endpoint answers `text/html` for both
playlists and segments; the app's HLS proxy treats a registered HLS camera's
root response as its playlist and validates the body, so the mislabelled type
does not matter.

### Checked and not integrated

| Source | Result | Decision |
| --- | --- | --- |
| DKI Jakarta — jakcctv.jakarta.go.id/publik | 46 cameras, streams verified working (`dki-jkt.balitower.co.id:7028/<id>/index.m3u8` returns `#EXTM3U`) but the page publishes **no coordinates** | Held: a camera needs a real position, and guessing one from the street name in the id would be fabricated data |
| DKI Jakarta — Jakarta Satu ArcGIS `Hosted/CCTV/FeatureServer/0` | 111 DSDA flood cameras **with** coordinates, but every `link_live` points at `103.140.108.110`, which is unreachable from the public internet | Held: no reachable stream |
| Surabaya — dishub.surabaya.go.id | No public catalog and no stream page; SITS is only exposed through its Android app | Rejected |
| DI Yogyakarta province — cctv.jogjaprov.go.id/api/v1/location-pins | 973 cameras, 598 with coordinates, streams verified; a 2.7 MB JSON:API catalog | Available, not enabled: it would need the catalog cap raised again |
| Kabupaten Gresik — testing-apicctv.gresikkab.go.id | 95 cameras with coordinates and working HLS | Not integrated: the same API returns `rtspUrl` values with camera admin credentials |
| Gresik — testing-apicctv.gresikkab.go.id | 95 cameras with coordinates and working HLS, but the same API returns `rtspUrl` values containing camera admin credentials | Not integrated: the app will not build on an endpoint that leaks credentials |

Note for anyone probing these portals from Indonesia: some ISP resolvers answer
with a parking address (for example `10.221.39.164`) for hostnames that do not
exist *and* for some that do, which makes a working portal look dead. Resolve
through DNS-over-HTTPS and force the address with `curl --resolve` before
concluding that a source is down.
