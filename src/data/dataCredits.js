import * as Cesium from 'cesium';

/**
 * Per-layer data attribution registered into Cesium's credit display.
 *
 * Legal requirement (see DATA_SOURCES.md, findings H10/H11 in
 * docs/pre-ship-audit-2026-07-01.md): every third-party data layer this app can
 * display carries its own license and required attribution — ODbL (OSM
 * datacenters/dams, adsb.lol, Overpass roads), CC BY-NC-SA (TeleGeography
 * cables), NASA FIRMS, CelesTrak, USGS, City of Austin, GBFS operators, OpenSky.
 * The MIT code license does NOT cover this data.
 *
 * These credits are registered ONCE at init as STATIC credits with
 * showOnScreen=false, so they live in the expandable bottom-left "Data
 * attribution" lightbox (Cesium's credit popover) rather than cluttering the
 * on-globe line. Always-present is intentional and reversible: the lightbox is
 * the app's canonical attribution surface and DATA_SOURCES.md is the
 * machine-readable index. Strings are copied verbatim from DATA_SOURCES.md — if
 * you add a data source, add it there AND here.
 */

/**
 * Attribution entries. `html` is the credit markup; keep it minimal and
 * link out where DATA_SOURCES.md provides a canonical URL. Order roughly
 * follows DATA_SOURCES.md (live sources, then bundled snapshots).
 * @type {{ key: string, html: string }[]}
 */
export const DATA_CREDITS = [
  // ── Live sources ────────────────────────────────────────────────
  {
    key: 'opensky',
    html:
      'Flights: OpenSky Network — Schäfer et al., ' +
      '“Bringing Up OpenSky”, IPSN 2014 · ' +
      '<a href="https://opensky-network.org" target="_blank" rel="noopener">opensky-network.org</a> ' +
      '(non-commercial)',
  },
  {
    key: 'adsblol',
    html:
      'Military flights, aircraft traces &amp; bounded regional flight fallback: ' +
      '<a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'aisstream',
    html:
      'Live vessels (AIS): ' +
      '<a href="https://aisstream.io" target="_blank" rel="noopener">AISStream.io</a>',
  },
  {
    key: 'celestrak',
    html:
      'Satellites (TLEs): CelesTrak ' +
      '(<a href="https://celestrak.org" target="_blank" rel="noopener">celestrak.org</a>), ' +
      'Dr. T.S. Kelso',
  },
  {
    key: 'launch-library-2',
    html:
      'Space mission launch, payload &amp; recovery metadata: ' +
      '<a href="https://ll.thespacedevs.com/docs/" target="_blank" rel="noopener">Launch Library 2 — The Space Devs</a> ' +
      '(API documentation and rate limits)',
  },
  {
    key: 'usgs',
    html: 'Earthquakes: Data courtesy of the U.S. Geological Survey',
  },
  {
    key: 'overpass',
    html:
      'Road geometry (traffic): ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'military-installations-osm',
    html:
      'Mapped installation context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0; incomplete mapped context)',
  },
  {
    key: 'cockpit-place-osm',
    html:
      'Cockpit place context: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      'via Nominatim (ODbL 1.0)',
  },
  {
    key: 'open-meteo',
    html:
      'Cockpit current conditions: ' +
      '<a href="https://open-meteo.com/en/licence" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> ' +
      '(CC BY 4.0)',
  },
  {
    key: 'google-news-rss',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://policies.google.com/terms" target="_blank" rel="noopener">Google News RSS</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'gdelt',
    html:
      'Cockpit regional headlines: ' +
      '<a href="https://www.gdeltproject.org/about.html" target="_blank" rel="noopener">GDELT Project</a> ' +
      '(location-matched article links; publisher terms apply)',
  },
  {
    key: 'austin-cctv',
    html:
      'CCTV cameras &amp; frames: City of Austin, TX — ' +
      '<a href="https://data.austintexas.gov" target="_blank" rel="noopener">data.austintexas.gov</a>',
  },
  {
    key: 'caltrans-cctv',
    html:
      'CCTV cameras &amp; frames (California): Caltrans — ' +
      '<a href="https://cwwp2.dot.ca.gov/" target="_blank" rel="noopener">cwwp2.dot.ca.gov</a>',
  },
  {
    key: 'tfl-cctv',
    html:
      'CCTV cameras &amp; frames (London): ' +
      '<a href="https://tfl.gov.uk/info-for/open-data-users/" target="_blank" rel="noopener">Powered by TfL Open Data</a>. ' +
      'Contains OS data © Crown copyright and database rights.',
  },
  {
    key: 'indonesia-cctv',
    html:
      'CCTV cameras (Indonesia): public city CCTV portals of ' +
      '<a href="https://cctv.jogjakota.go.id" target="_blank" rel="noopener">Yogyakarta</a>, ' +
      '<a href="https://pelindung.bandung.go.id" target="_blank" rel="noopener">Bandung</a>, ' +
      '<a href="https://cctv.bandaacehkota.go.id" target="_blank" rel="noopener">Banda Aceh</a> (CC BY 4.0), ' +
      '<a href="https://cctv.palembang.go.id" target="_blank" rel="noopener">Palembang</a>, ' +
      '<a href="https://cctv.salatiga.go.id" target="_blank" rel="noopener">Salatiga</a>, ' +
      '<a href="https://cctv.bengkulukota.go.id" target="_blank" rel="noopener">Bengkulu</a>, ' +
      '<a href="https://cctv.banjarmasinkota.go.id" target="_blank" rel="noopener">Banjarmasin</a>, ' +
      '<a href="https://pantausemar.semarangkota.go.id" target="_blank" rel="noopener">Semarang</a> and ' +
      '<a href="https://pantaulalindishub.sidoarjokab.go.id" target="_blank" rel="noopener">Sidoarjo</a>, ' +
      '<a href="https://cctv.pekalongankota.go.id" target="_blank" rel="noopener">Pekalongan</a> and ' +
      '<a href="https://dishub.depok.go.id/cctv" target="_blank" rel="noopener">Depok</a>, and toll-road cameras of ' +
      '<a href="https://bpjt.pu.go.id/cctv" target="_blank" rel="noopener">BPJT — Kementerian PU</a>',
  },
  {
    key: 'hk-td-cctv',
    html:
      'CCTV frames (Hong Kong): Transport Department, HKSAR Government — ' +
      '<a href="https://data.gov.hk" target="_blank" rel="noopener">DATA.GOV.HK</a>',
  },
  {
    key: 'sg-lta-cctv',
    html:
      'Traffic images (Singapore): contains information from Traffic Images accessed from ' +
      '<a href="https://data.gov.sg" target="_blank" rel="noopener">data.gov.sg</a>, ' +
      'made available under the Singapore Open Data Licence version 1.0',
  },
  {
    key: 'digitraffic-cctv',
    html:
      'Road weather cameras (Finland): Fintraffic / ' +
      '<a href="https://www.digitraffic.fi/en/" target="_blank" rel="noopener">Digitraffic</a>, licensed under CC BY 4.0',
  },
  {
    key: 'gbfs',
    html: 'Bikeshare availability: GBFS operator feeds (e.g. Austin BCycle)',
  },
  {
    key: 'radio-browser',
    html:
      'Internet-radio station directory: ' +
      '<a href="https://www.radio-browser.info/" target="_blank" rel="noopener">Radio Browser</a> ' +
      '(public domain; audio delivered directly by each broadcaster)',
  },
  {
    key: 'reearth-terrain',
    html:
      'Terrain (keyless globe stacks): ' +
      '<a href="https://terrain.reearth.land" target="_blank" rel="noopener">Re:Earth Terrain</a> / ' +
      'Mapterhorn (CC BY 4.0) / EGM2008 (NGA)',
  },
  // ── Bundled snapshots ───────────────────────────────────────────
  {
    key: 'datacenters',
    html:
      'Datacenters: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0)',
  },
  {
    key: 'dams',
    html:
      'Dams: ' +
      '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a> ' +
      '(ODbL 1.0) + Open Infrastructure Map',
  },
  {
    key: 'firms',
    html:
      'Active fires: NASA FIRMS — we acknowledge the use of data and/or imagery ' +
      'from NASA’s Fire Information for Resource Management System ' +
      '(<a href="https://earthdata.nasa.gov/firms" target="_blank" rel="noopener">earthdata.nasa.gov/firms</a>), ' +
      'part of NASA’s Earth Observing System Data and Information System (EOSDIS)',
  },
  {
    key: 'telegeography',
    html:
      'Submarine cables: © TeleGeography — ' +
      '<a href="https://www.submarinecablemap.com" target="_blank" rel="noopener">submarinecablemap.com</a> ' +
      '(CC BY-NC-SA 3.0 — NonCommercial)',
  },
  // ── Indonesia intelligence engine (docs/INDONESIA-DATA-SOURCES.md) ─────
  {
    key: 'bmkg',
    html:
      'Gempabumi &amp; prakiraan cuaca: BMKG — ' +
      '<a href="https://www.bmkg.go.id" target="_blank" rel="noopener">bmkg.go.id</a>',
  },
  {
    key: 'bnpb',
    html:
      'Kejadian bencana &amp; batas administrasi (Kemendagri): BNPB Pusdatinkom — ' +
      '<a href="https://gis.bnpb.go.id" target="_blank" rel="noopener">gis.bnpb.go.id</a>',
  },
  {
    key: 'pvmbg',
    html:
      'Tingkat aktivitas gunung api: PVMBG / MAGMA Indonesia (Badan Geologi) — ' +
      '<a href="https://magma.esdm.go.id" target="_blank" rel="noopener">magma.esdm.go.id</a>; ' +
      'volcano positions: Wikidata (CC0)',
  },
  {
    key: 'gdelt',
    html:
      'News metadata: The GDELT Project — ' +
      '<a href="https://www.gdeltproject.org" target="_blank" rel="noopener">gdeltproject.org</a>',
  },
  {
    key: 'open-meteo',
    html:
      'Weather &amp; air quality: ' +
      '<a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo.com</a> (CC BY 4.0)',
  },
  {
    key: 'world-bank',
    html:
      'Economic indicators: World Bank Open Data (CC BY 4.0); exchange rates: Frankfurter / ECB',
  },
  {
    key: 'ourairports',
    html:
      'Airports: <a href="https://ourairports.com" target="_blank" rel="noopener">OurAirports</a> (public domain); ' +
      'administrative codes: Kemendagri via <a href="https://wilayah.id" target="_blank" rel="noopener">wilayah.id</a>',
  },
  {
    key: 'gis-basemaps',
    html:
      'GIS basemaps: OpenFreeMap (© OpenMapTiles, © OpenStreetMap contributors, ODbL) · Esri World Imagery',
  },
];

/**
 * Conditional credits — registered via `registerDynamicCredit` only when the
 * corresponding capability actually activates (deliberately NOT part of
 * DATA_CREDITS, which is always-on). TomTom terms require attribution when
 * their flow data is displayed; keyless installs never show it, so the
 * credit only appears once live traffic-flow mode activates.
 * @type {{ key: string, html: string }}
 */
export const TOMTOM_CREDIT = {
  key: 'tomtom',
  html:
    'Traffic flow data © ' +
    '<a href="https://www.tomtom.com" target="_blank" rel="noopener">TomTom</a>',
};

/** Registered when the first Natural Earth region outline resolves (public
 * domain — no attribution required; credited as a courtesy). */
export const NATURAL_EARTH_CREDIT = {
  key: 'natural-earth',
  html:
    'Physical region boundaries from ' +
    '<a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a> (public domain)',
};

/** @type {Set<string>} Keys of dynamic credits already registered this session. */
const _dynamicCreditKeys = new Set();

/**
 * Register a conditional credit at the moment its data source activates.
 * Idempotent per `credit.key`; lands in the same "Data attribution" popover
 * as the static credits (showOnScreen=false).
 * @param {Cesium.Viewer} viewer — the initialized Cesium viewer
 * @param {{ key: string, html: string }} credit — e.g. `TOMTOM_CREDIT`
 * @returns {boolean} True when the credit is (now) registered.
 */
export function registerDynamicCredit(viewer, credit) {
  const creditDisplay = viewer?.creditDisplay;
  if (!creditDisplay || typeof creditDisplay.addStaticCredit !== 'function') {
    return false;
  }
  if (!credit?.key || !credit?.html) return false;
  if (_dynamicCreditKeys.has(credit.key)) return true;
  creditDisplay.addStaticCredit(new Cesium.Credit(credit.html, false));
  _dynamicCreditKeys.add(credit.key);
  return true;
}

/**
 * Register every per-layer data credit into the viewer's credit display.
 * Idempotent: safe to call once at init. Credits are static and always
 * present in the "Data attribution" popover.
 * @param {Cesium.Viewer} viewer — the initialized Cesium viewer
 */
export function registerDataCredits(viewer) {
  const creditDisplay = viewer?.creditDisplay;
  if (!creditDisplay || typeof creditDisplay.addStaticCredit !== 'function') {
    return;
  }
  for (const { html } of DATA_CREDITS) {
    // showOnScreen=false → lives in the expandable "Data attribution" popover,
    // not the on-globe credit line.
    creditDisplay.addStaticCredit(new Cesium.Credit(html, false));
  }
}
