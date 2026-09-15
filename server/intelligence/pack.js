/**
 * @module server/intelligence/pack
 *
 * Node-side loader for the bundled Indonesia data pack (built by
 * `scripts/build-indonesia-pack.mjs`). Gives providers and the engine the
 * administrative lookups they need: regency polygons, province names, and
 * place-name matching for headlines. Everything is read once and cached.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAreaLocator } from '../../src/intelligence/geo.js';
import { nameKey } from '../../src/providers/provider.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACK_DIR = join(HERE, '..', '..', 'src', 'data', 'indonesia');
export const BOUNDARY_DIR = join(HERE, '..', '..', 'src', 'data', 'local_data', 'indonesia');

/** Short forms Indonesians use for provinces, mapped to Kemendagri codes. */
export const PROVINCE_ALIASES = Object.freeze({
  jakarta: '31', 'dki jakarta': '31', dki: '31', jabar: '32', 'jawa barat': '32', jateng: '33', 'jawa tengah': '33',
  jatim: '35', 'jawa timur': '35', yogyakarta: '34', jogja: '34', yogya: '34', diy: '34', banten: '36', bali: '51',
  ntb: '52', 'nusa tenggara barat': '52', ntt: '53', 'nusa tenggara timur': '53', aceh: '11', sumut: '12', 'sumatera utara': '12',
  sumbar: '13', 'sumatera barat': '13', riau: '14', jambi: '15', sumsel: '16', 'sumatera selatan': '16', bengkulu: '17',
  lampung: '18', babel: '19', 'bangka belitung': '19', kepri: '21', 'kepulauan riau': '21', kalbar: '61', 'kalimantan barat': '61',
  kalteng: '62', 'kalimantan tengah': '62', kalsel: '63', 'kalimantan selatan': '63', kaltim: '64', 'kalimantan timur': '64',
  kaltara: '65', 'kalimantan utara': '65', sulut: '71', 'sulawesi utara': '71', sulteng: '72', 'sulawesi tengah': '72',
  sulsel: '73', 'sulawesi selatan': '73', sultra: '74', 'sulawesi tenggara': '74', gorontalo: '75', sulbar: '76', 'sulawesi barat': '76',
  maluku: '81', malut: '82', 'maluku utara': '82', papua: '91', 'papua barat': '92', 'papua selatan': '93', 'papua tengah': '94',
  'papua pegunungan': '95', 'papua barat daya': '96',
});

function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
  } catch {
    return fallback;
  }
}

let cached = null;

/**
 * Load the pack (memoized). Missing files degrade to empty lists so the
 * engine still runs before `scripts/build-indonesia-pack.mjs` has been run.
 */
export function loadIndonesiaPack({ reload = false } = {}) {
  if (cached && !reload) return cached;
  const provinces = readJson(join(PACK_DIR, 'provinces.json'), []);
  const regencies = readJson(join(PACK_DIR, 'regencies.json'), []);
  const volcanoes = readJson(join(PACK_DIR, 'volcanoes.json'), []);
  const airports = readJson(join(PACK_DIR, 'airports.json'), []);
  const weatherPoints = readJson(join(PACK_DIR, 'weatherPoints.json'), []);
  const cities = readJson(join(PACK_DIR, 'cities.json'), []);
  const regencyBoundaries = readJson(join(BOUNDARY_DIR, 'regencies.geojson'), null);
  const provinceBoundaries = readJson(join(BOUNDARY_DIR, 'provinces.geojson'), null);
  const locator = regencyBoundaries ? createAreaLocator(regencyBoundaries, { codeKey: 'code', nameKey: 'name' }) : null;
  const provinceByCode = new Map(provinces.map((province) => [String(province.code), province]));

  // Place index for headline matching: longest names first so "Jakarta Pusat"
  // beats "Jakarta". Cities (capitals, weather points) carry coordinates;
  // provinces resolve to their capital.
  const places = [];
  for (const province of provinces) {
    if (Number.isFinite(province.lat)) {
      places.push({ key: nameKey(province.name), name: province.name, lat: province.lat, lon: province.lon, province: province.name, provinceCode: String(province.code), city: null });
      places.push({ key: nameKey(province.capital), name: province.capital, lat: province.lat, lon: province.lon, province: province.name, provinceCode: String(province.code), city: province.capital });
    }
  }
  for (const regency of regencies) {
    if (regency.centroid) {
      const province = provinceByCode.get(String(regency.provinceCode));
      places.push({ key: nameKey(regency.name), name: regency.name, lat: regency.centroid.lat, lon: regency.centroid.lon, province: province?.name || null, provinceCode: String(regency.provinceCode), city: regency.name });
    }
  }
  for (const [alias, code] of Object.entries(PROVINCE_ALIASES)) {
    const province = provinceByCode.get(code);
    if (province && Number.isFinite(province.lat) && !places.some((place) => place.key === alias)) {
      places.push({ key: alias, name: province.name, lat: province.lat, lon: province.lon, province: province.name, provinceCode: code, city: null });
    }
  }
  places.sort((a, b) => b.key.length - a.key.length);
  const placeByKey = new Map(places.map((place) => [place.key, place]));

  const matchPlaceInText = (text) => {
    const haystack = ` ${nameKey(text)} `;
    for (const place of places) {
      if (place.key.length < 4) continue;
      if (haystack.includes(` ${place.key} `)) return place;
    }
    return null;
  };
  const matchProvinceInText = (text) => {
    const place = matchPlaceInText(text);
    return place ? { code: place.provinceCode, name: place.province } : null;
  };

  cached = {
    provinces,
    regencies,
    volcanoes,
    airports,
    weatherPoints,
    cities,
    boundaries: { regencies: regencyBoundaries, provinces: provinceBoundaries },
    provinceByCode: (code) => provinceByCode.get(String(code)) || null,
    provinceName: (code) => provinceByCode.get(String(code))?.name || null,
    locateRegency: locator ? (lat, lon) => locator.locate(lat, lon) : null,
    matchPlaceInText,
    matchProvinceInText,
    placeByKey: (key) => placeByKey.get(nameKey(key)) || null,
    weatherPointById: (id) => weatherPoints.find((point) => point.id === id) || null,
  };
  return cached;
}
