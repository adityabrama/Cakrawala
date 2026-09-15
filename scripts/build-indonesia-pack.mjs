#!/usr/bin/env node
// Builds the bundled Indonesia data pack from public sources.
//
//   node scripts/build-indonesia-pack.mjs [--skip-boundaries]
//
// Outputs (committed, so the app works offline and the sources are not
// hit on every start):
//   src/data/indonesia/provinces.json      38 provinces (Kemendagri codes, capitals, view)
//   src/data/indonesia/regencies.json      514 kabupaten/kota (code, name, province, centroid, bbox)
//   src/data/indonesia/volcanoes.json      Wikidata volcano positions (CC0)
//   src/data/indonesia/airports.json       OurAirports, Indonesia only (public domain)
//   src/data/indonesia/weatherPoints.json  BMKG adm4 codes for major cities
//   src/data/local_data/indonesia/regencies.geojson   BNPB Admin_kabkot_2023 (simplified)
//   src/data/local_data/indonesia/provinces.geojson   BNPB Admin_Prov (simplified)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geometryBbox, geometryCentroid } from '../src/intelligence/geo.js';
import { nameKey } from '../src/providers/provider.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = join(ROOT, 'src', 'data', 'indonesia');
const GEO_DIR = join(ROOT, 'src', 'data', 'local_data', 'indonesia');
const UA = 'CAKRAWALA/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
const skipBoundaries = process.argv.includes('--skip-boundaries');
mkdirSync(PACK_DIR, { recursive: true });
mkdirSync(GEO_DIR, { recursive: true });

async function get(url, { ms = 120_000, headers = {} } = {}) {
  const response = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(ms) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 120)}`);
  return text;
}
const getJson = async (url, options) => JSON.parse(await get(url, options));
const write = (path, data) => { writeFileSync(path, `${JSON.stringify(data, null, data?.type === 'FeatureCollection' ? 0 : 1)}\n`); console.log(`wrote ${path.replace(ROOT, '.')} (${Math.round(Buffer.byteLength(JSON.stringify(data)) / 1024)} KB)`); };

// ── Provinces (Kemendagri codes from wilayah.id; capitals and views curated) ─
const CAPITALS = {
  11: ['Banda Aceh', 5.548, 95.323, 'Sumatera'], 12: ['Medan', 3.595, 98.672, 'Sumatera'], 13: ['Padang', -0.947, 100.417, 'Sumatera'],
  14: ['Pekanbaru', 0.507, 101.447, 'Sumatera'], 15: ['Jambi', -1.610, 103.613, 'Sumatera'], 16: ['Palembang', -2.976, 104.775, 'Sumatera'],
  17: ['Bengkulu', -3.800, 102.266, 'Sumatera'], 18: ['Bandar Lampung', -5.429, 105.262, 'Sumatera'], 19: ['Pangkal Pinang', -2.131, 106.115, 'Sumatera'],
  21: ['Tanjung Pinang', 0.918, 104.457, 'Sumatera'], 31: ['Jakarta', -6.208, 106.846, 'Jawa'], 32: ['Bandung', -6.914, 107.609, 'Jawa'],
  33: ['Semarang', -6.966, 110.417, 'Jawa'], 34: ['Yogyakarta', -7.797, 110.370, 'Jawa'], 35: ['Surabaya', -7.257, 112.752, 'Jawa'],
  36: ['Serang', -6.120, 106.150, 'Jawa'], 51: ['Denpasar', -8.670, 115.212, 'Bali–Nusa Tenggara'], 52: ['Mataram', -8.583, 116.117, 'Bali–Nusa Tenggara'],
  53: ['Kupang', -10.178, 123.597, 'Bali–Nusa Tenggara'], 61: ['Pontianak', -0.026, 109.342, 'Kalimantan'], 62: ['Palangka Raya', -2.208, 113.917, 'Kalimantan'],
  63: ['Banjarmasin', -3.319, 114.591, 'Kalimantan'], 64: ['Samarinda', -0.502, 117.154, 'Kalimantan'], 65: ['Tanjung Selor', 2.838, 117.364, 'Kalimantan'],
  71: ['Manado', 1.487, 124.846, 'Sulawesi'], 72: ['Palu', -0.900, 119.871, 'Sulawesi'], 73: ['Makassar', -5.147, 119.432, 'Sulawesi'],
  74: ['Kendari', -3.972, 122.515, 'Sulawesi'], 75: ['Gorontalo', 0.543, 123.059, 'Sulawesi'], 76: ['Mamuju', -2.675, 118.889, 'Sulawesi'],
  81: ['Ambon', -3.695, 128.181, 'Maluku'], 82: ['Sofifi', 0.735, 127.577, 'Maluku'], 91: ['Jayapura', -2.533, 140.717, 'Papua'],
  92: ['Manokwari', -0.861, 134.062, 'Papua'], 93: ['Merauke', -8.493, 140.401, 'Papua'], 94: ['Nabire', -3.367, 135.496, 'Papua'],
  95: ['Wamena', -4.097, 138.950, 'Papua'], 96: ['Sorong', -0.876, 131.256, 'Papua'],
};
const provincesRaw = (await getJson('https://wilayah.id/api/provinces.json')).data;
if (provincesRaw.length !== 38) throw new Error(`expected 38 provinces, got ${provincesRaw.length}`);

// ── Regencies (names) ───────────────────────────────────────────────────────
const regencyNames = [];
for (const province of provincesRaw) {
  const rows = (await getJson(`https://wilayah.id/api/regencies/${province.code}.json`)).data;
  for (const row of rows) regencyNames.push({ code: row.code, name: row.name.trim(), provinceCode: province.code });
}
console.log(`regencies from wilayah.id: ${regencyNames.length}`);

// ── Boundaries (BNPB hosted Kemendagri polygons) ────────────────────────────
let regencyGeo = null;
let provinceGeo = null;
if (!skipBoundaries) {
  console.log('fetching BNPB Admin_kabkot_2023 (simplified, ~25 s)…');
  regencyGeo = await getJson('https://gis.bnpb.go.id/server/rest/services/Hosted/Admin_kabkot_2023/FeatureServer/17/query?where=1%3D1&outFields=kdpkab,wadmkk&f=geojson&maxAllowableOffset=0.01&outSR=4326', { ms: 240_000 });
  regencyGeo.features = regencyGeo.features.map((feature) => ({
    type: 'Feature',
    properties: { code: String(feature.properties.kdpkab || '').trim(), name: String(feature.properties.wadmkk || '').trim() },
    geometry: feature.geometry,
  })).filter((feature) => feature.properties.code && feature.geometry);
  regencyGeo.attribution = 'Batas administrasi kabupaten/kota: BNPB (Hosted/Admin_kabkot_2023), data Kemendagri';
  write(join(GEO_DIR, 'regencies.geojson'), regencyGeo);
  try {
    console.log('fetching BNPB Admin_Prov (simplified)…');
    provinceGeo = await getJson('https://gis.bnpb.go.id/server/rest/services/Hosted/Admin_Prov/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson&maxAllowableOffset=0.02&outSR=4326', { ms: 240_000 });
    if (provinceGeo.error) throw new Error(JSON.stringify(provinceGeo.error));
    provinceGeo.features = provinceGeo.features.map((feature) => {
      const props = feature.properties || {};
      const code = String(props.id_prov ?? props.kdppum ?? '').trim();
      const name = String(props.provinsi || props.prov || '').trim();
      return { type: 'Feature', properties: { code, name }, geometry: feature.geometry };
    }).filter((feature) => feature.geometry);
    provinceGeo.attribution = 'Batas administrasi provinsi: BNPB (Hosted/Admin_Prov), data Kemendagri';
    write(join(GEO_DIR, 'provinces.geojson'), provinceGeo);
  } catch (error) {
    console.warn(`Admin_Prov unavailable (${error.message}); provinces.geojson not written`);
  }
}

// ── Regency records with centroid/bbox ──────────────────────────────────────
const geoByCode = new Map((regencyGeo?.features || []).map((feature) => [feature.properties.code, feature]));
const regencies = regencyNames.map((row) => {
  const feature = geoByCode.get(row.code);
  const centroid = feature ? geometryCentroid(feature.geometry) : null;
  return { ...row, centroid, bbox: feature ? geometryBbox(feature.geometry).map((v) => Math.round(v * 1000) / 1000) : null };
});
write(join(PACK_DIR, 'regencies.json'), regencies);

// ── Province records ────────────────────────────────────────────────────────
const provinces = provincesRaw.map((province) => {
  const [capital, lat, lon, island] = CAPITALS[Number(province.code)] || [null, null, null, null];
  const members = regencies.filter((regency) => regency.provinceCode === province.code && regency.bbox);
  const bbox = members.length ? [
    Math.min(...members.map((r) => r.bbox[0])), Math.min(...members.map((r) => r.bbox[1])),
    Math.max(...members.map((r) => r.bbox[2])), Math.max(...members.map((r) => r.bbox[3])),
  ].map((v) => Math.round(v * 1000) / 1000) : null;
  return { code: province.code, name: province.name.trim(), capital, lat, lon, island, bbox, regencyCount: members.length || null };
});
if (provinces.some((province) => !province.capital)) throw new Error('missing capital mapping');
write(join(PACK_DIR, 'provinces.json'), provinces);

// ── Volcanoes (Wikidata, CC0) ───────────────────────────────────────────────
const sparql = `SELECT ?v ?vLabel ?coord ?elev WHERE { ?v wdt:P31/wdt:P279* wd:Q8072; wdt:P17 wd:Q252; wdt:P625 ?coord. OPTIONAL { ?v wdt:P2044 ?elev } SERVICE wikibase:label { bd:serviceParam wikibase:language "id,en". } }`;
const wikidata = await getJson(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, { headers: { Accept: 'application/sparql-results+json' } });
const volcanoMap = new Map();
for (const binding of wikidata.results.bindings) {
  const id = binding.v.value.split('/').pop();
  const match = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(binding.coord.value);
  if (!match || volcanoMap.has(id)) continue;
  const name = binding.vLabel.value.replace(/^Gunung\s+/i, '').trim();
  volcanoMap.set(id, { id, name, key: nameKey(name), lat: Number(match[2]), lon: Number(match[1]), elevationM: binding.elev ? Math.round(Number(binding.elev.value)) : null, aliases: [] });
}
const volcanoes = [...volcanoMap.values()].sort((a, b) => a.name.localeCompare(b.name));
write(join(PACK_DIR, 'volcanoes.json'), volcanoes);

// ── Airports (OurAirports, public domain) ───────────────────────────────────
const csv = await get('https://davidmegginson.github.io/ourairports-data/airports.csv');
const parseCsvLine = (line) => { const out = []; let cur = ''; let q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; };
const [header, ...lines] = csv.split('\n').filter(Boolean);
const columns = parseCsvLine(header);
const col = (row, name) => row[columns.indexOf(name)];
const airports = lines.map(parseCsvLine).filter((row) => col(row, 'iso_country') === 'ID' && /^(large|medium|small)_airport$/.test(col(row, 'type'))).map((row) => ({
  ident: col(row, 'ident'), iata: col(row, 'iata_code') || null, name: col(row, 'name'), type: col(row, 'type').replace('_airport', ''),
  lat: Number(col(row, 'latitude_deg')), lon: Number(col(row, 'longitude_deg')), elevationFt: Number(col(row, 'elevation_ft')) || null,
  municipality: col(row, 'municipality') || null, region: col(row, 'iso_region') || null, scheduled: col(row, 'scheduled_service') === 'yes',
})).filter((airport) => Number.isFinite(airport.lat) && Number.isFinite(airport.lon)).sort((a, b) => a.name.localeCompare(b.name));
write(join(PACK_DIR, 'airports.json'), airports);

// ── BMKG weather points (one central kelurahan per major city) ──────────────
const WEATHER_CITIES = [
  ['jakarta', 'Jakarta', '31', /Jakarta Pusat/, /^Gambir$/], ['bandung', 'Bandung', '32', /^Kota Bandung$/, /Sumur Bandung/],
  ['surabaya', 'Surabaya', '35', /^Kota Surabaya$/, /^Genteng$/], ['semarang', 'Semarang', '33', /^Kota Semarang$/, /Semarang Tengah/],
  ['yogyakarta', 'Yogyakarta', '34', /^Kota Yogyakarta$/, /Gondomanan/], ['medan', 'Medan', '12', /^Kota Medan$/, /Medan Kota/],
  ['denpasar', 'Denpasar', '51', /^Kota Denpasar$/, /Denpasar Barat/], ['makassar', 'Makassar', '73', /^Kota Makassar$/, /Ujung Pandang/],
  ['balikpapan', 'Balikpapan', '64', /^Kota Balikpapan$/, /Balikpapan Kota/], ['samarinda', 'Samarinda', '64', /^Kota Samarinda$/, /Samarinda Kota/],
  ['palembang', 'Palembang', '16', /^Kota Palembang$/, /Ilir Timur I$/], ['batam', 'Batam', '21', /^Kota Batam$/, /Batam Kota/],
  ['manado', 'Manado', '71', /^Kota Manado$/, /^Wenang$/], ['jayapura', 'Jayapura', '91', /^Kota Jayapura$/, /Jayapura Utara/],
  ['banda-aceh', 'Banda Aceh', '11', /^Kota Banda Aceh$/, /Baiturrahman/], ['padang', 'Padang', '13', /^Kota Padang$/, /Padang Barat/],
  ['pekanbaru', 'Pekanbaru', '14', /^Kota Pekanbaru$/, /Pekanbaru Kota|Sukajadi/], ['bandar-lampung', 'Bandar Lampung', '18', /^Kota Bandar Lampung$/, /Tanjung Karang Pusat/],
  ['pontianak', 'Pontianak', '61', /^Kota Pontianak$/, /Pontianak Kota/], ['banjarmasin', 'Banjarmasin', '63', /^Kota Banjarmasin$/, /Banjarmasin Tengah/],
  ['ambon', 'Ambon', '81', /^Kota Ambon$/, /^Sirimau$/], ['kupang', 'Kupang', '53', /^Kota Kupang$/, /Kota Raja|Kelapa Lima/],
  ['mataram', 'Mataram', '52', /^Kota Mataram$/, /^Mataram$/], ['palu', 'Palu', '72', /^Kota Palu$/, /Palu Timur|Palu Barat/],
  ['kendari', 'Kendari', '74', /^Kota Kendari$/, /^Kendari$/], ['sorong', 'Sorong', '96', /^Kota Sorong$/, /Sorong Kota|Sorong$/],
];
const weatherPoints = [];
for (const [id, name, provinceCode, regencyPattern, districtPattern] of WEATHER_CITIES) {
  const regency = regencyNames.find((row) => row.provinceCode === provinceCode && regencyPattern.test(row.name));
  if (!regency) { console.warn(`weather point ${id}: regency not found`); continue; }
  const districts = (await getJson(`https://wilayah.id/api/districts/${regency.code}.json`)).data;
  const district = districts.find((row) => districtPattern.test(row.name.trim())) || districts[0];
  const villages = (await getJson(`https://wilayah.id/api/villages/${district.code}.json`)).data;
  const village = villages[0];
  let lat = null; let lon = null;
  try {
    const forecast = await getJson(`https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=${village.code}`, { ms: 20_000 });
    lat = forecast?.lokasi?.lat ?? null; lon = forecast?.lokasi?.lon ?? null;
    if (!forecast?.data?.[0]?.cuaca?.length) throw new Error('no forecast');
  } catch (error) {
    console.warn(`weather point ${id}: BMKG check failed for ${village.code} (${error.message})`);
    continue;
  }
  weatherPoints.push({ id, name, provinceCode, regency: regency.name, district: district.name.trim(), village: village.name.trim(), adm4: village.code, lat, lon });
  console.log(`weather point ${id}: ${village.code} ${district.name.trim()}/${village.name.trim()}`);
}
write(join(PACK_DIR, 'weatherPoints.json'), weatherPoints);
console.log('done');
