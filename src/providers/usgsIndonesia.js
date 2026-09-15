/**
 * @module providers/usgsIndonesia
 *
 * USGS FDSN event service, bounded to the Indonesia envelope, last 7 days,
 * M2.5+. Complements BMKG (which lists only the latest, M5+, and felt events)
 * with the full catalogue. Public domain.
 */

import { INDONESIA_BBOX } from '../intelligence/geo.js';
import { attachAdministrative, defineProvider, fetchJson, severityFromMagnitude } from './provider.js';

const ENDPOINT = 'https://earthquake.usgs.gov/fdsnws/event/1/query';

/** Parse one USGS GeoJSON feature into event fields. */
export function parseUsgsFeature(feature) {
  const coordinates = feature?.geometry?.coordinates;
  const props = feature?.properties;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !props || !Number.isFinite(props.time)) return null;
  const [lon, lat, depthKm] = coordinates;
  const magnitude = Number(props.mag);
  if (!Number.isFinite(magnitude)) return null;
  const location = { lat, lon };
  if (Number.isFinite(depthKm)) location.depthKm = depthKm;
  return {
    id: `usgs:${feature.id || `${props.time}:${lat},${lon}`}`,
    type: 'earthquake',
    subtype: 'usgs',
    timestamp: props.time,
    location,
    title: `M${magnitude.toFixed(1)} · ${String(props.place || 'Indonesia region').trim()}`,
    description: props.alert ? `PAGER alert level: ${props.alert}` : '',
    severity: severityFromMagnitude(magnitude),
    confidence: props.status === 'reviewed' ? 0.95 : 0.8,
    status: 'live',
    magnitude,
    sourceUrl: typeof props.url === 'string' ? props.url : null,
    raw: {
      magnitude,
      depthKm: Number.isFinite(depthKm) ? depthKm : null,
      place: props.place || null,
      usgsTsunamiFlag: props.tsunami === 1,
      felt: Number(props.felt) > 0,
      pagerAlert: props.alert || null,
      reviewStatus: props.status || null,
    },
  };
}

export function usgsIndonesiaUrl({ days = 7, minMagnitude = 2.5, limit = 500 } = {}) {
  const [west, south, east, north] = INDONESIA_BBOX;
  const params = new URLSearchParams({
    format: 'geojson',
    minlatitude: String(south), maxlatitude: String(north),
    minlongitude: String(west), maxlongitude: String(east),
    minmagnitude: String(minMagnitude),
    limit: String(limit),
    orderby: 'time',
    starttime: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
  });
  return `${ENDPOINT}?${params}`;
}

export const usgsIndonesiaProvider = defineProvider({
  id: 'usgs-indonesia',
  name: 'USGS Earthquakes (Indonesia)',
  category: 'earthquake',
  region: 'ID',
  auth: 'keyless',
  intervalMs: 10 * 60_000,
  attribution: 'USGS Earthquake Hazards Program',
  license: 'Public domain (US Government)',
  sourceUrl: 'https://earthquake.usgs.gov/earthquakes/search/',
  async fetch({ fetchImpl, signal, pack }) {
    const payload = await fetchJson(usgsIndonesiaUrl(), { fetchImpl, signal });
    const events = [];
    for (const feature of Array.isArray(payload?.features) ? payload.features : []) {
      const event = parseUsgsFeature(feature);
      if (!event) continue;
      attachAdministrative(event, pack, event.raw.place || '');
      events.push(event);
    }
    const strongest = events.reduce((max, event) => Math.max(max, event.magnitude), 0);
    return {
      events,
      metrics: {
        usgs_indonesia_7d: { value: events.length, kind: 'count', threshold: 10, label: 'USGS M2.5+ (7 d, Indonesia)', source: 'usgs-indonesia' },
        usgs_indonesia_max_7d: { value: strongest, kind: 'numeric', threshold: 100, label: 'Strongest USGS quake (7 d)', source: 'usgs-indonesia' },
      },
      meta: { generated: payload?.metadata?.generated || null },
    };
  },
});

export default usgsIndonesiaProvider;
