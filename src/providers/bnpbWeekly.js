/**
 * @module providers/bnpbWeekly
 *
 * BNPB "Kejadian Bencana Mingguan" ArcGIS feature layer (Pusdatinkom BNPB):
 * disaster events compiled per regency with casualties and damage. Official
 * and keyless; the layer is not always current, so freshness is derived from
 * the event date and older rows are marked `historical`.
 *
 * Source: https://gis.bnpb.go.id/server/rest/services/Kejadian_Bencana_Mingguan/MapServer/25
 */

import { geometryCentroid } from '../intelligence/geo.js';
import { attachAdministrative, defineProvider, fetchJson, toNumber } from './provider.js';

export const BNPB_WEEKLY_URL = 'https://gis.bnpb.go.id/server/rest/services/Kejadian_Bencana_Mingguan/MapServer/25/query';

const CATEGORY_TYPES = Object.freeze([
  [/banjir\s*bandang/i, 'flood', 'flash-flood'],
  [/banjir/i, 'flood', 'flood'],
  [/longsor|gerakan tanah/i, 'landslide', 'landslide'],
  [/kebakaran hutan|karhutla|kebakaran lahan/i, 'fire', 'forest-land-fire'],
  [/kebakaran/i, 'fire', 'fire'],
  [/kekeringan/i, 'drought', 'drought'],
  [/gempa/i, 'earthquake', 'bnpb-report'],
  [/tsunami/i, 'tsunami', 'bnpb-report'],
  [/erupsi|gunung/i, 'volcano', 'eruption'],
  [/angin|puting beliung|cuaca ekstrem/i, 'weather', 'extreme-weather'],
  [/gelombang|abrasi|pasang/i, 'disaster', 'coastal'],
]);

export function classifyBnpbCategory(category) {
  for (const [pattern, type, subtype] of CATEGORY_TYPES) {
    if (pattern.test(String(category || ''))) return { type, subtype };
  }
  return { type: 'disaster', subtype: 'other' };
}

function impactSeverity(impact) {
  const casualties = impact.deaths + impact.missing;
  if (casualties >= 5) return 'critical';
  if (casualties >= 1 || impact.displaced >= 500 || impact.housesDamaged >= 200) return 'high';
  if (impact.displaced >= 50 || impact.injured >= 10 || impact.housesDamaged >= 20 || impact.housesFlooded >= 200) return 'medium';
  if (impact.displaced > 0 || impact.housesDamaged > 0 || impact.housesFlooded > 0 || impact.landHa >= 10) return 'low';
  return 'info';
}

/** Parse one BNPB feature (GeoJSON) into event fields. */
export function parseBnpbFeature(feature, { nowMs = Date.now() } = {}) {
  const props = feature?.properties;
  if (!props) return null;
  const timestampMs = toNumber(props.dt)
    ?? (props.tahun && props.bulan && props.tgl ? Date.UTC(Number(props.tahun), Number(props.bulan) - 1, Number(props.tgl)) : null);
  if (!Number.isFinite(timestampMs)) return null;
  const centroid = geometryCentroid(feature.geometry);
  const { type, subtype } = classifyBnpbCategory(props.kategori_bencana);
  const impact = {
    deaths: toNumber(props.meninggal) || 0,
    missing: toNumber(props.hilang) || 0,
    injured: toNumber(props.luka_sakit) || 0,
    displaced: (toNumber(props.mengungsi) || 0) + (toNumber(props.menderita_mengungsi) || 0),
    affected: toNumber(props.menderita) || 0,
    housesDamaged: (toNumber(props.rumah_rusak) || 0) || ((toNumber(props.rumah_rusak_berat) || 0) + (toNumber(props.rumah_rusak_sedang) || 0) + (toNumber(props.rumah_rusak_ringan) || 0)),
    housesFlooded: toNumber(props.rumah_terendam) || 0,
    landHa: toNumber(props.lahan_hektar) || 0,
    incidents: toNumber(props.jumlah_kejadian) || 1,
  };
  const ageMs = nowMs - timestampMs;
  const chronology = String(props.kronologis || props.deskripsi || '').replace(/[●•\t]/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    id: `bnpb:${props.objectid ?? props.ESRI_OID ?? props.id ?? 'row'}:${timestampMs}`,
    type,
    subtype,
    timestamp: timestampMs,
    location: centroid,
    title: `${String(props.kategori_bencana || 'Bencana').trim()} · ${String(props.kabupaten || 'Indonesia').trim()}`,
    description: chronology.slice(0, 300) || `${impact.incidents} kejadian dilaporkan BNPB`,
    severity: impactSeverity(impact),
    confidence: 0.9,
    status: ageMs > 14 * 86_400_000 ? 'historical' : 'delayed',
    country: 'ID',
    city: String(props.kabupaten || '').trim() || null,
    sourceUrl: 'https://gis.bnpb.go.id/',
    raw: {
      category: props.kategori_bencana || null,
      regency: props.kabupaten || null,
      impact,
      latestCondition: String(props.kondisi_mutakhir || '').replace(/[●•\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null,
      week: props.minggu ?? null,
    },
  };
}

export const bnpbWeeklyProvider = defineProvider({
  id: 'bnpb-weekly',
  name: 'BNPB Kejadian Bencana',
  category: 'disaster',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 60 * 60_000,
  // Compiled reports stay useful on the timeline long after the feed drops
  // them; they are labelled `historical` after two weeks.
  retentionMs: 180 * 24 * 60 * 60_000,
  attribution: 'BNPB — Pusat Data, Informasi dan Komunikasi Kebencanaan',
  license: 'Public ArcGIS service of BNPB; attribution required',
  sourceUrl: 'https://gis.bnpb.go.id/',
  async fetch({ fetchImpl, signal, pack, now = Date.now }) {
    const params = new URLSearchParams({ where: '1=1', outFields: '*', f: 'geojson', outSR: '4326', resultRecordCount: '500', maxAllowableOffset: '0.02' });
    const payload = await fetchJson(`${BNPB_WEEKLY_URL}?${params}`, { fetchImpl, signal, timeoutMs: 40_000 });
    if (payload?.error) throw new Error(`BNPB: ${payload.error.message || 'query error'}`);
    const events = [];
    const nowMs = now();
    for (const feature of Array.isArray(payload?.features) ? payload.features : []) {
      const event = parseBnpbFeature(feature, { nowMs });
      if (!event) continue;
      attachAdministrative(event, pack, event.raw.regency || '');
      events.push(event);
    }
    const recent = events.filter((event) => event.status !== 'historical');
    return {
      events,
      metrics: {
        bnpb_events_recent: { value: recent.length, kind: 'count', threshold: 2, label: 'BNPB disaster reports (14 d)', source: 'bnpb-weekly' },
        bnpb_deaths_recent: { value: recent.reduce((sum, event) => sum + event.raw.impact.deaths, 0), kind: 'count', threshold: 1, label: 'BNPB reported deaths (14 d)', source: 'bnpb-weekly' },
      },
      meta: { rows: events.length, newestReport: events.map((event) => event.timestamp).sort().at(-1) || null },
    };
  },
});

export default bnpbWeeklyProvider;
