/**
 * @module cctvPacks
 *
 * Additional public CCTV catalogs for the server-side CCTV proxy.
 *
 * Indonesia: official city CCTV portals that publish camera positions and live
 * HLS streams for public viewing. International: government open-data traffic
 * camera feeds that publish JPEG snapshots.
 *
 * Every parser keeps only public, active cameras with valid coordinates and
 * http(s) media URLs, so a portal change degrades to fewer cameras rather than
 * bad ones. `loadCctvPacks` loads packs independently: one failing portal never
 * blocks the rest.
 */

const CATALOG_USER_AGENT = 'CAKRAWALA-cctv-catalog/1.0';

const INDONESIA_BOUNDS = Object.freeze({ minLat: -11.5, maxLat: 6.5, minLon: 94.5, maxLon: 141.5 });
const SINGAPORE_BOUNDS = Object.freeze({ minLat: 1.1, maxLat: 1.5, minLon: 103.5, maxLon: 104.2 });
const HONG_KONG_BOUNDS = Object.freeze({ minLat: 22.1, maxLat: 22.6, minLon: 113.8, maxLon: 114.5 });
const FINLAND_BOUNDS = Object.freeze({ minLat: 59.5, maxLat: 70.2, minLon: 19.0, maxLon: 31.7 });

const SINGAPORE_TRAFFIC_IMAGES_URL = 'https://api.data.gov.sg/v1/transport/traffic-images';
const HONG_KONG_IMAGE_ORIGIN = 'https://tdcctv.data.one.gov.hk/';
const DIGITRAFFIC_IMAGE_ORIGIN = 'https://weathercam.digitraffic.fi/';

function toNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function inBounds(lat, lon, bounds) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= bounds.minLat && lat <= bounds.maxLat
    && lon >= bounds.minLon && lon <= bounds.maxLon;
}

function httpUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function isHlsUrl(url) {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function hashSeed(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic 22.5-degree heading for cameras whose catalog has no heading. */
export function fallbackCameraHeading(cameraId) {
  return (hashSeed(String(cameraId)) % 16) * 22.5;
}

function cleanText(value, fallback = '') {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

/** Undo JSON string escapes in text lifted out of an HTML page's inline script. */
function unescapeInlineJson(text) {
  try {
    return JSON.parse(`"${String(text).replace(/"/g, '\\"')}"`);
  } catch {
    return String(text);
  }
}

function cameraRecord({
  id,
  name,
  city,
  cityId = '',
  provider,
  lat,
  lon,
  groundElevationM,
  feedType,
  url,
  snapshotUrl = '',
  sourceKind,
  license,
  pose = {},
  snapshotResolver,
  streamReferer,
}) {
  const record = {
    id,
    name,
    city,
    cityId,
    provider,
    lat,
    lon,
    headingDeg: fallbackCameraHeading(id),
    headingConfidence: 'low',
    pitchDeg: pose.pitchDeg ?? -18,
    fovDeg: pose.fovDeg ?? 50,
    rangeM: pose.rangeM ?? 160,
    mountHeightM: pose.mountHeightM ?? 8,
    groundElevationM,
    feedType,
    url,
    snapshotUrl,
    sourceKind,
    license,
  };
  if (snapshotResolver) record.snapshotResolver = snapshotResolver;
  if (streamReferer) record.streamReferer = streamReferer;
  return record;
}

/**
 * Kota Yogyakarta: `home/getdata` on cctv.jogjakota.go.id. cctv_status 0 is public,
 * 1 private and 2 maintenance; only public cameras are kept.
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
export function parseYogyakartaCameras(list) {
  const cameras = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (String(item?.cctv_status) !== '0') continue;
    const lat = toNumber(item.cctv_latitude);
    const lon = toNumber(item.cctv_longitude);
    const url = httpUrl(item.cctv_link);
    const id = cleanText(item.cctv_id);
    if (!id || !inBounds(lat, lon, INDONESIA_BOUNDS) || !isHlsUrl(url)) continue;
    cameras.push(cameraRecord({
      id: `jogja-${id}`,
      name: cleanText(item.cctv_title, `CCTV ${id}`),
      city: 'Yogyakarta',
      cityId: 'yogyakarta',
      provider: 'Pemerintah Kota Yogyakarta',
      lat,
      lon,
      groundElevationM: 115,
      feedType: 'hls',
      url,
      sourceKind: 'id-yogyakarta',
      license: 'Public CCTV, Pemerintah Kota Yogyakarta (cctv.jogjakota.go.id)',
    }));
  }
  return cameras;
}

/**
 * Kota Bandung: the Pelindung portal's `/api/cek` camera list.
 * @param {Array<object>} list
 * @returns {Array<object>}
 */
export function parseBandungCameras(list) {
  const cameras = [];
  for (const item of Array.isArray(list) ? list : []) {
    const lat = toNumber(item?.lat);
    const lon = toNumber(item?.lng);
    const url = httpUrl(item?.stream_cctv);
    const id = cleanText(item?.id);
    if (!id || !inBounds(lat, lon, INDONESIA_BOUNDS) || !isHlsUrl(url)) continue;
    const agency = cleanText(item.dinas);
    cameras.push(cameraRecord({
      id: `bandung-${id}`,
      name: cleanText(item.cctv_name, 'CCTV Bandung'),
      city: 'Bandung',
      cityId: 'bandung',
      provider: agency ? `Pemerintah Kota Bandung (${agency})` : 'Pemerintah Kota Bandung',
      lat,
      lon,
      groundElevationM: 740,
      feedType: 'hls',
      url,
      sourceKind: 'id-bandung',
      license: 'Public CCTV, Pemerintah Kota Bandung (pelindung.bandung.go.id)',
    }));
  }
  return cameras;
}

/**
 * Kota Banda Aceh: `/api/cameras`. Each active camera links an embed page whose
 * player loads `memfs/<uuid>.m3u8` and `memfs/<uuid>.jpg` beside it.
 * @param {Array<object>|{data?: Array<object>}} payload
 * @returns {Array<object>}
 */
export function parseBandaAcehCameras(payload) {
  const list = Array.isArray(payload) ? payload : (payload?.data || []);
  const cameras = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item?.is_active !== true) continue;
    const lat = toNumber(item.latitude);
    const lon = toNumber(item.longitude);
    const pageUrl = httpUrl(item.url);
    const uuid = (pageUrl.match(/\/cctv\/([0-9a-f-]{36})\.html$/i) || [])[1];
    if (!uuid || !inBounds(lat, lon, INDONESIA_BOUNDS)) continue;
    cameras.push(cameraRecord({
      id: `bandaaceh-${uuid}`,
      name: cleanText(item.name, 'CCTV Banda Aceh'),
      city: 'Banda Aceh',
      provider: cleanText(item.pengelola, 'Pemerintah Kota Banda Aceh'),
      lat,
      lon,
      groundElevationM: 10,
      feedType: 'hls',
      url: new URL(`memfs/${uuid}.m3u8`, pageUrl).href,
      snapshotUrl: new URL(`memfs/${uuid}.jpg`, pageUrl).href,
      sourceKind: 'id-banda-aceh',
      license: 'CC BY 4.0, DISKOMINFOTIK Kota Banda Aceh (cctv.bandaacehkota.go.id)',
    }));
  }
  return cameras;
}

/**
 * Kota Palembang: `/api/cctv`. Keeps public-scope, active cameras.
 * @param {{data?: Array<object>}} payload
 * @returns {Array<object>}
 */
export function parsePalembangCameras(payload) {
  const cameras = [];
  for (const item of Array.isArray(payload?.data) ? payload.data : []) {
    if (String(item?.cctv_scope || '').toLowerCase() !== 'publik') continue;
    if (String(item?.cctv_status || '').toLowerCase() !== 'active') continue;
    const [lonRaw, latRaw] = Array.isArray(item?.location?.coordinates) ? item.location.coordinates : [];
    const lat = toNumber(latRaw);
    const lon = toNumber(lonRaw);
    const url = httpUrl(item.cctv_link);
    const id = cleanText(item.cctv_id || item._id);
    if (!id || !inBounds(lat, lon, INDONESIA_BOUNDS) || !isHlsUrl(url)) continue;
    cameras.push(cameraRecord({
      id: `palembang-${id}`,
      name: cleanText(item.cctv_title, 'CCTV Palembang'),
      city: 'Palembang',
      provider: cleanText(item.cctv_opd?.nama_opd, 'Pemerintah Kota Palembang'),
      lat,
      lon,
      groundElevationM: 10,
      feedType: 'hls',
      url,
      sourceKind: 'id-palembang',
      license: 'Public CCTV, Pemerintah Kota Palembang (cctv.palembang.go.id)',
    }));
  }
  return cameras;
}

const SALATIGA_CAMERA = /\{"id":"([0-9a-f-]{36})","nama":"((?:[^"\\]|\\.)*)","lokasi":"((?:[^"\\]|\\.)*)","tautan":"([^"]*)","gambar":"([^"]*)","lat":"([^"]*)","lng":"([^"]*)"/g;

/**
 * Kota Salatiga: the camera list is inline JSON on the portal's home page.
 * @param {string} html
 * @returns {Array<object>}
 */
export function parseSalatigaCameras(html) {
  const text = String(html || '').split('\\/').join('/');
  const cameras = [];
  for (const match of text.matchAll(SALATIGA_CAMERA)) {
    const [, uuid, nameRaw, placeRaw, streamRaw, snapshotRaw, latRaw, lonRaw] = match;
    const lat = toNumber(latRaw);
    const lon = toNumber(lonRaw);
    const url = httpUrl(streamRaw);
    if (!inBounds(lat, lon, INDONESIA_BOUNDS) || !isHlsUrl(url)) continue;
    const name = cleanText(unescapeInlineJson(nameRaw));
    const place = cleanText(unescapeInlineJson(placeRaw));
    cameras.push(cameraRecord({
      id: `salatiga-${uuid}`,
      name: [place, name].filter(Boolean).join(' · ') || 'CCTV Salatiga',
      city: 'Salatiga',
      provider: 'Pemerintah Kota Salatiga',
      lat,
      lon,
      groundElevationM: 580,
      feedType: 'hls',
      url,
      snapshotUrl: httpUrl(snapshotRaw),
      sourceKind: 'id-salatiga',
      // The restreamer answers 403 unless the request names the city portal.
      streamReferer: 'https://cctv.salatiga.go.id/',
      license: 'Public CCTV, Pemerintah Kota Salatiga (cctv.salatiga.go.id)',
    }));
  }
  return cameras;
}

const BENGKULU_CAMERA = /\{"id":(\d+),"name":"((?:[^"\\]|\\.)*)","stream":"([^"]*)","lat":(-?[\d.]+),"lng":(-?[\d.]+),"status":"([a-z]+)"\}/g;

/**
 * Kota Bengkulu: inline camera list on the portal's home page. Each stream link
 * redirects to the city's HLS source server, which the HLS proxy follows.
 * @param {string} html
 * @returns {Array<object>}
 */
export function parseBengkuluCameras(html) {
  const text = String(html || '').split('\\/').join('/');
  const cameras = [];
  for (const match of text.matchAll(BENGKULU_CAMERA)) {
    const [, id, nameRaw, streamRaw, latRaw, lonRaw] = match;
    const lat = toNumber(latRaw);
    const lon = toNumber(lonRaw);
    const url = httpUrl(streamRaw);
    if (!url || !inBounds(lat, lon, INDONESIA_BOUNDS)) continue;
    cameras.push(cameraRecord({
      id: `bengkulu-${id}`,
      name: cleanText(unescapeInlineJson(nameRaw), `CCTV Bengkulu ${id}`),
      city: 'Bengkulu',
      provider: 'Pemerintah Kota Bengkulu',
      lat,
      lon,
      groundElevationM: 15,
      feedType: 'hls',
      url,
      sourceKind: 'id-bengkulu',
      license: 'Public CCTV, Pemerintah Kota Bengkulu (cctv.bengkulukota.go.id)',
    }));
  }
  return cameras;
}

/**
 * Kota Banjarmasin: `/api/maps/get` GeoJSON.
 * @param {{data?: {features?: Array<object>}}} payload
 * @returns {Array<object>}
 */
export function parseBanjarmasinCameras(payload) {
  const cameras = [];
  for (const feature of Array.isArray(payload?.data?.features) ? payload.data.features : []) {
    const props = feature?.properties || {};
    const lat = toNumber(props.latitude);
    const lon = toNumber(props.longitude);
    const url = httpUrl(props.url);
    const id = cleanText(props.uuid);
    if (!id || !inBounds(lat, lon, INDONESIA_BOUNDS) || !isHlsUrl(url)) continue;
    cameras.push(cameraRecord({
      id: `banjarmasin-${id}`,
      name: cleanText(props.name, 'CCTV Banjarmasin'),
      city: 'Banjarmasin',
      provider: 'Pemerintah Kota Banjarmasin',
      lat,
      lon,
      groundElevationM: 5,
      feedType: 'hls',
      url,
      sourceKind: 'id-banjarmasin',
      // The restreamer answers 403 unless the request names the city portal.
      streamReferer: 'https://cctv.banjarmasinkota.go.id/',
      license: 'Public CCTV, Pemerintah Kota Banjarmasin (cctv.banjarmasinkota.go.id)',
    }));
  }
  return cameras;
}

/**
 * Singapore LTA traffic images via data.gov.sg. Image URLs rotate every minute,
 * so records carry `snapshotResolver: 'sg-lta'` for frame-time resolution.
 * @param {{items?: Array<{cameras?: Array<object>}>}} payload
 * @returns {Array<object>}
 */
export function parseSingaporeCameras(payload) {
  const cameras = [];
  for (const item of Array.isArray(payload?.items?.[0]?.cameras) ? payload.items[0].cameras : []) {
    const lat = toNumber(item?.location?.latitude);
    const lon = toNumber(item?.location?.longitude);
    const url = httpUrl(item?.image);
    const id = cleanText(item?.camera_id);
    if (!id || !url || !inBounds(lat, lon, SINGAPORE_BOUNDS)) continue;
    cameras.push(cameraRecord({
      id: `sg-${id}`,
      name: `LTA traffic camera ${id}`,
      city: 'Singapore',
      provider: 'Land Transport Authority, Singapore',
      lat,
      lon,
      groundElevationM: 20,
      feedType: 'image',
      url,
      snapshotUrl: url,
      sourceKind: 'sg-lta-open-data',
      license: 'Singapore Open Data Licence v1.0 (data.gov.sg)',
      snapshotResolver: 'sg-lta',
    }));
  }
  return cameras;
}

const XML_ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function xmlField(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity]).trim() : '';
}

/**
 * Hong Kong Transport Department traffic snapshot camera locations (XML).
 * @param {string} xml
 * @returns {Array<object>}
 */
export function parseHongKongCameras(xml) {
  const cameras = [];
  for (const block of String(xml || '').split(/<image>/i).slice(1)) {
    const key = xmlField(block, 'key');
    const lat = toNumber(xmlField(block, 'latitude'));
    const lon = toNumber(xmlField(block, 'longitude'));
    const url = httpUrl(xmlField(block, 'url'));
    if (!key || !url.startsWith(HONG_KONG_IMAGE_ORIGIN) || !inBounds(lat, lon, HONG_KONG_BOUNDS)) continue;
    const district = xmlField(block, 'district');
    cameras.push(cameraRecord({
      id: `hk-${key}`,
      name: xmlField(block, 'description') || `Traffic camera ${key}`,
      city: district ? `Hong Kong · ${district}` : 'Hong Kong',
      provider: 'Transport Department, HKSAR Government',
      lat,
      lon,
      groundElevationM: 20,
      feedType: 'image',
      url,
      snapshotUrl: url,
      sourceKind: 'hk-td-open-data',
      license: 'DATA.GOV.HK terms, Transport Department',
    }));
  }
  return cameras;
}

/**
 * Finland road weather cameras (Fintraffic Digitraffic). One camera per station,
 * using its first preset that is in collection.
 * @param {{features?: Array<object>}} payload
 * @returns {Array<object>}
 */
export function parseDigitrafficCameras(payload) {
  const cameras = [];
  for (const feature of Array.isArray(payload?.features) ? payload.features : []) {
    const props = feature?.properties || {};
    if (String(props.collectionStatus || '').toUpperCase() !== 'GATHERING') continue;
    const preset = (Array.isArray(props.presets) ? props.presets : []).find((entry) => entry?.inCollection === true && entry?.id);
    const [lonRaw, latRaw] = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
    const lat = toNumber(latRaw);
    const lon = toNumber(lonRaw);
    if (!preset || !inBounds(lat, lon, FINLAND_BOUNDS)) continue;
    const presetId = cleanText(preset.id);
    if (!/^[A-Za-z0-9]+$/.test(presetId)) continue;
    const url = `${DIGITRAFFIC_IMAGE_ORIGIN}${presetId}.jpg`;
    cameras.push(cameraRecord({
      id: `fi-${presetId}`,
      name: cleanText(props.name, `Road weather camera ${presetId}`).replace(/_/g, ' '),
      city: 'Finland',
      provider: 'Fintraffic (Digitraffic)',
      lat,
      lon,
      groundElevationM: 50,
      feedType: 'image',
      url,
      snapshotUrl: url,
      sourceKind: 'fi-digitraffic-open-data',
      license: 'CC BY 4.0, Fintraffic / digitraffic.fi',
      pose: { pitchDeg: -12, fovDeg: 60, rangeM: 300, mountHeightM: 6 },
    }));
  }
  return cameras;
}

/** Indonesian city portals, loaded first so the global source cap never trims them. */
export const INDONESIA_CCTV_PACKS = Object.freeze([
  { id: 'yogyakarta', url: 'https://cctv.jogjakota.go.id/home/getdata', kind: 'json', referer: 'https://cctv.jogjakota.go.id/', xhr: true, parse: parseYogyakartaCameras },
  { id: 'bandung', url: 'https://pelindung.bandung.go.id:8443/api/cek', kind: 'json', referer: 'https://pelindung.bandung.go.id/', parse: parseBandungCameras },
  { id: 'banda-aceh', url: 'https://cctv.bandaacehkota.go.id/api/cameras', kind: 'json', referer: 'https://cctv.bandaacehkota.go.id/', parse: parseBandaAcehCameras },
  { id: 'palembang', url: 'https://cctv.palembang.go.id/api/cctv', kind: 'json', referer: 'https://cctv.palembang.go.id/', parse: parsePalembangCameras },
  { id: 'salatiga', url: 'https://cctv.salatiga.go.id/', kind: 'text', parse: parseSalatigaCameras },
  { id: 'bengkulu', url: 'https://cctv.bengkulukota.go.id/', kind: 'text', parse: parseBengkuluCameras },
  { id: 'banjarmasin', url: 'https://cctv.banjarmasinkota.go.id/api/maps/get', kind: 'json', referer: 'https://cctv.banjarmasinkota.go.id/', xhr: true, parse: parseBanjarmasinCameras },
]);

/** Government open-data snapshot feeds outside Indonesia. */
export const INTERNATIONAL_CCTV_PACKS = Object.freeze([
  { id: 'singapore', url: SINGAPORE_TRAFFIC_IMAGES_URL, kind: 'json', parse: parseSingaporeCameras },
  { id: 'hong-kong', url: 'https://static.data.gov.hk/td/traffic-snapshot-images/code/Traffic_Camera_Locations_En.xml', kind: 'text', parse: parseHongKongCameras },
  { id: 'finland', url: 'https://tie.digitraffic.fi/api/weathercam/v1/stations', kind: 'json', parse: parseDigitrafficCameras },
]);

/**
 * Load several catalog packs concurrently. Each pack fails independently.
 * @param {ReadonlyArray<{id:string,url:string,kind:'json'|'text',referer?:string,xhr?:boolean,parse:Function}>} packs
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, isEnabled?: (id: string) => boolean, log?: Pick<Console,'log'|'warn'>}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function loadCctvPacks(packs, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  isEnabled = () => true,
  log = console,
} = {}) {
  const active = (Array.isArray(packs) ? packs : []).filter((pack) => isEnabled(pack.id));
  const settled = await Promise.allSettled(active.map(async (pack) => {
    const startedAt = Date.now();
    const headers = { 'User-Agent': CATALOG_USER_AGENT, Accept: pack.kind === 'json' ? 'application/json' : 'text/html,application/xml,*/*' };
    if (pack.referer) headers.Referer = pack.referer;
    if (pack.xhr) headers['X-Requested-With'] = 'XMLHttpRequest';
    const response = await fetchImpl(pack.url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = pack.kind === 'json' ? await response.json() : await response.text();
    const cameras = pack.parse(payload);
    log?.log?.(`[CCTV] ${pack.id}: ${cameras.length} cameras (${Date.now() - startedAt} ms)`);
    return cameras;
  }));
  const cameras = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') cameras.push(...result.value);
    else log?.warn?.(`[CCTV] ${active[index].id} catalog unavailable: ${result.reason?.message || result.reason}`);
  });
  return cameras;
}

/**
 * Resolve a Singapore camera's current image URL. The data.gov.sg list is cached
 * for `ttlMs`, and concurrent frame requests share one refresh.
 * @param {{fetchImpl?: typeof fetch, ttlMs?: number, timeoutMs?: number}} [options]
 * @returns {(cameraId: string) => Promise<string|null>}
 */
export function createSingaporeSnapshotResolver({
  fetchImpl = globalThis.fetch,
  ttlMs = 60_000,
  timeoutMs = 8_000,
} = {}) {
  let byId = new Map();
  let fetchedAt = 0;
  let refresh = null;
  return async function resolveSingaporeSnapshot(cameraId) {
    if (Date.now() - fetchedAt > ttlMs) {
      refresh ??= fetchImpl(SINGAPORE_TRAFFIC_IMAGES_URL, {
        headers: { 'User-Agent': CATALOG_USER_AGENT, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (!payload) return;
          byId = new Map(parseSingaporeCameras(payload).map((camera) => [camera.id, camera.url]));
          fetchedAt = Date.now();
        })
        .catch(() => {})
        .finally(() => { refresh = null; });
      await refresh;
    }
    const id = String(cameraId || '');
    return byId.get(id.startsWith('sg-') ? id : `sg-${id}`) || null;
  };
}
