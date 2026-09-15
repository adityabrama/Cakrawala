/**
 * @module providers/bmkgQuakes
 *
 * BMKG Tsunami Early Warning System open JSON feeds: the latest earthquake,
 * the last 15 M5+ earthquakes, and the last 15 felt earthquakes. Official,
 * keyless, updated as BMKG publishes.
 *
 * Source: https://data.bmkg.go.id/gempabumi/
 */

import { attachAdministrative, defineProvider, fetchJson, severityFromMagnitude, toNumber } from './provider.js';

const BASE = 'https://data.bmkg.go.id/DataMKG/TEWS';
export const BMKG_QUAKE_FEEDS = Object.freeze([
  { path: 'autogempa.json', subtype: 'latest' },
  { path: 'gempaterkini.json', subtype: 'm5-plus' },
  { path: 'gempadirasakan.json', subtype: 'felt' },
]);

/** True when the BMKG "Potensi" text flags tsunami potential (not "Tidak berpotensi"). */
export function hasTsunamiPotential(potensi) {
  const text = String(potensi || '').toLowerCase();
  return /berpotensi\s+tsunami/.test(text) && !/tidak\s+berpotensi/.test(text);
}

/** Parse one BMKG gempa row into event fields (no attribution; the provider stamps it). */
export function parseBmkgQuake(row, subtype, { nowIso = new Date().toISOString() } = {}) {
  if (!row || typeof row !== 'object') return null;
  const [latRaw, lonRaw] = String(row.Coordinates || '').split(',');
  const lat = toNumber(latRaw);
  const lon = toNumber(lonRaw);
  const magnitude = toNumber(row.Magnitude);
  const timestamp = row.DateTime || null;
  if (lat === null || lon === null || magnitude === null || !timestamp) return null;
  const depthKm = toNumber(String(row.Kedalaman || '').replace(/[^\d.,]/g, ''));
  const tsunamiPotential = hasTsunamiPotential(row.Potensi);
  const felt = Boolean(String(row.Dirasakan || '').trim());
  const location = { lat, lon };
  if (depthKm !== null) location.depthKm = depthKm;
  return {
    id: `bmkg:${String(timestamp).replace(/[^0-9T]/g, '')}:${lat.toFixed(2)},${lon.toFixed(2)}`,
    type: 'earthquake',
    subtype,
    timestamp,
    location,
    title: `M${magnitude.toFixed(1)} · ${String(row.Wilayah || 'Indonesia').trim()}`,
    description: [row.Potensi, row.Dirasakan ? `Dirasakan: ${row.Dirasakan}` : null].filter(Boolean).join(' · '),
    severity: tsunamiPotential ? 'critical' : severityFromMagnitude(magnitude),
    confidence: 0.95,
    status: 'live',
    magnitude,
    country: 'ID',
    sourceUrl: 'https://www.bmkg.go.id/gempabumi/',
    raw: {
      magnitude,
      depthKm,
      wilayah: row.Wilayah || null,
      potensi: row.Potensi || null,
      dirasakan: row.Dirasakan || null,
      shakemap: row.Shakemap ? `https://data.bmkg.go.id/DataMKG/TEWS/${row.Shakemap}` : null,
      tsunamiPotential,
      felt,
      observedAt: nowIso,
    },
  };
}

export const bmkgQuakesProvider = defineProvider({
  id: 'bmkg-quakes',
  name: 'BMKG Gempabumi',
  category: 'earthquake',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 5 * 60_000,
  attribution: 'Data gempabumi: BMKG (bmkg.go.id)',
  license: 'Public data of BMKG; attribution required',
  sourceUrl: 'https://data.bmkg.go.id/gempabumi/',
  async fetch({ fetchImpl, signal, pack, now = Date.now }) {
    const nowIso = new Date(now()).toISOString();
    // The same quake appears in several feeds. Feeds are read in order of
    // detail (latest → M5+ → felt) and later rows overwrite by id, so the felt
    // bulletin, which carries the intensity report, wins.
    const byId = new Map();
    const failures = [];
    let latestMagnitude = null;
    for (const feed of BMKG_QUAKE_FEEDS) {
      try {
        const payload = await fetchJson(`${BASE}/${feed.path}`, { fetchImpl, signal });
        const gempa = payload?.Infogempa?.gempa;
        const rows = Array.isArray(gempa) ? gempa : gempa ? [gempa] : [];
        for (const row of rows) {
          const event = parseBmkgQuake(row, feed.subtype, { nowIso });
          if (!event) continue;
          if (feed.subtype === 'latest') latestMagnitude = event.magnitude;
          attachAdministrative(event, pack, row.Wilayah || '');
          const existing = byId.get(event.id);
          if (existing?.raw.felt && !event.raw.felt) event.raw.felt = true;
          byId.set(event.id, event);
        }
      } catch (error) {
        failures.push(`${feed.path}: ${error.message}`);
      }
    }
    const events = [...byId.values()];
    if (!events.length && failures.length) throw new Error(failures.join('; '));
    const felt24h = events.filter((event) => event.raw.felt && now() - Date.parse(event.timestamp) <= 24 * 3_600_000).length;
    return {
      events,
      metrics: {
        bmkg_felt_24h: { value: felt24h, kind: 'count', threshold: 2, label: 'BMKG felt earthquakes (24 h)', source: 'bmkg-quakes' },
        bmkg_latest_magnitude: { value: latestMagnitude, kind: 'numeric', threshold: 100, label: 'Latest BMKG magnitude', source: 'bmkg-quakes' },
      },
      meta: { feeds: BMKG_QUAKE_FEEDS.length, failures },
    };
  },
});

export default bmkgQuakesProvider;
