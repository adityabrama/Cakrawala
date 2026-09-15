#!/usr/bin/env node
/**
 * Dissolve the bundled kabupaten/kota polygons into one polygon per province.
 *
 * BNPB's Admin_Prov service has been unreachable (timeouts) every time the
 * pack was built, so the province layer is derived offline from the regency
 * boundaries that did download: every regency whose Kemendagri code starts
 * with the province code is unioned (Turf / polygon-clipping). No network.
 *
 *   node scripts/build-indonesia-provinces.mjs
 *
 * Reads  src/data/local_data/indonesia/regencies.geojson + src/data/indonesia/provinces.json
 * Writes src/data/local_data/indonesia/provinces.geojson
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { union } from '@turf/union';
import { featureCollection } from '@turf/helpers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = join(ROOT, 'src', 'data', 'indonesia');
const GEO_DIR = join(ROOT, 'src', 'data', 'local_data', 'indonesia');

/** Union polygons per province; a province whose union fails keeps its members as a MultiPolygon. */
export function dissolveProvinces(regencyGeo, provinces) {
  const byProvince = new Map();
  for (const feature of regencyGeo.features || []) {
    if (!feature.geometry || !/Polygon$/.test(feature.geometry.type)) continue;
    const code = String(feature.properties?.code || '').slice(0, 2);
    if (!code) continue;
    if (!byProvince.has(code)) byProvince.set(code, []);
    byProvince.get(code).push(feature);
  }
  const nameByCode = new Map(provinces.map((province) => [String(province.code), province.name]));
  const features = [];
  const fallbacks = [];
  for (const [code, members] of [...byProvince.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let geometry = null;
    try {
      const merged = members.length === 1 ? members[0] : union(featureCollection(members));
      geometry = merged?.geometry || null;
    } catch {
      geometry = null;
    }
    if (!geometry) {
      // One invalid ring (self-touching simplified coastline) fails the whole
      // union; merge one member at a time and keep the offenders unmerged.
      fallbacks.push(code);
      let acc = null;
      const unmerged = [];
      for (const member of members) {
        try {
          acc = acc ? union(featureCollection([acc, member])) : member;
        } catch {
          unmerged.push(member);
        }
      }
      const parts = (feature) => (feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates);
      geometry = { type: 'MultiPolygon', coordinates: [...(acc ? parts(acc) : []), ...unmerged.flatMap(parts)] };
    }
    features.push({
      type: 'Feature',
      properties: { code, name: nameByCode.get(code) || code, regencyCount: members.length },
      geometry,
    });
  }
  return { collection: { type: 'FeatureCollection', features }, fallbacks };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const regencyPath = join(GEO_DIR, 'regencies.geojson');
  if (!existsSync(regencyPath)) {
    console.error('regencies.geojson missing; run node scripts/build-indonesia-pack.mjs first');
    process.exit(1);
  }
  const regencyGeo = JSON.parse(readFileSync(regencyPath, 'utf8'));
  const provinces = JSON.parse(readFileSync(join(PACK_DIR, 'provinces.json'), 'utf8'));
  const started = Date.now();
  const { collection, fallbacks } = dissolveProvinces(regencyGeo, provinces);
  collection.attribution = 'Batas administrasi provinsi: diturunkan (dissolve) dari batas kabupaten/kota BNPB (Hosted/Admin_kabkot_2023), data Kemendagri';
  const out = join(GEO_DIR, 'provinces.geojson');
  writeFileSync(out, `${JSON.stringify(collection)}\n`);
  const bytes = Buffer.byteLength(JSON.stringify(collection));
  console.log(`wrote ${out.replace(ROOT, '.')}: ${collection.features.length} provinces, ${Math.round(bytes / 1024)} KB in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (fallbacks.length) console.warn(`union failed, kept member polygons for: ${fallbacks.join(', ')}`);
  if (collection.features.length !== 38) {
    console.error(`expected 38 provinces, got ${collection.features.length}`);
    process.exit(1);
  }
}
