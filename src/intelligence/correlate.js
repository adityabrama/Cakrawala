/**
 * @module intelligence/correlate
 *
 * Cross-source correlation. Events of different types that are close in
 * space and time are reported as "related signals" — spatially or temporally
 * correlated — never as cause and effect. The wording is fixed here so no
 * consumer can accidentally upgrade a correlation into a claim.
 */

import { gridKey, haversineKm } from './geo.js';
import { severityRank } from './eventSchema.js';

export const DEFAULT_RADIUS_KM = 100;
export const DEFAULT_WINDOW_MS = 48 * 3_600_000;

/** Fixed relationship labels (§9 of the master prompt: no causality claims). */
export const RELATION_LABELS = Object.freeze({
  both: 'spatially and temporally correlated',
  spatial: 'spatially correlated',
  temporal: 'temporally correlated',
});

/**
 * Find related signals for every event. O(n²) over located events with a
 * coarse grid prefilter, which is fine for the few thousand events a sweep
 * holds.
 * @returns {Map<string, object[]>} eventId → related entries
 */
export function correlateEvents(events, { radiusKm = DEFAULT_RADIUS_KM, windowMs = DEFAULT_WINDOW_MS, maxPerEvent = 8 } = {}) {
  const located = (events || []).filter((event) => event.location);
  const cellDeg = Math.max(0.5, radiusKm / 100);
  const cells = new Map();
  for (const event of located) {
    const key = gridKey(event.location.lat, event.location.lon, cellDeg);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(event);
  }
  const neighbours = (event) => {
    const latCell = Math.floor(event.location.lat / cellDeg);
    const lonCell = Math.floor(event.location.lon / cellDeg);
    const out = [];
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const bucket = cells.get(`${latCell + dLat}:${lonCell + dLon}`);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  };

  const related = new Map();
  for (const event of located) {
    const ms = Date.parse(event.timestamp);
    const entries = [];
    for (const other of neighbours(event)) {
      if (other.id === event.id || other.type === event.type) continue;
      const distanceKm = haversineKm(event.location.lat, event.location.lon, other.location.lat, other.location.lon);
      if (distanceKm > radiusKm) continue;
      const gapMs = Math.abs(Date.parse(other.timestamp) - ms);
      const inWindow = gapMs <= windowMs;
      entries.push({
        eventId: other.id,
        type: other.type,
        title: other.title,
        source: other.source,
        timestamp: other.timestamp,
        severity: other.severity,
        distanceKm: Math.round(distanceKm * 10) / 10,
        gapHours: Math.round((gapMs / 3_600_000) * 10) / 10,
        relation: inWindow ? RELATION_LABELS.both : RELATION_LABELS.spatial,
      });
    }
    if (!entries.length) continue;
    entries.sort((a, b) => (
      (a.relation === RELATION_LABELS.both ? 0 : 1) - (b.relation === RELATION_LABELS.both ? 0 : 1)
      || severityRank(b.severity) - severityRank(a.severity)
      || a.distanceKm - b.distanceKm
    ));
    related.set(event.id, entries.slice(0, maxPerEvent));
  }
  return related;
}

/**
 * Spatial clusters of one event type: events of `type` sharing a grid cell.
 * Used for "N fires in one area" style alerts and heatmap summaries.
 * @returns {object[]} clusters sorted by size, each { key, type, count, center, ids, maxSeverity }
 */
export function clusterEvents(events, { type = null, cellDeg = 0.5, minCount = 3 } = {}) {
  const buckets = new Map();
  for (const event of events || []) {
    if (!event.location || (type && event.type !== type)) continue;
    const key = `${event.type}|${gridKey(event.location.lat, event.location.lon, cellDeg)}`;
    if (!buckets.has(key)) buckets.set(key, { key, type: event.type, ids: [], sumLat: 0, sumLon: 0, maxSeverity: 'info' });
    const bucket = buckets.get(key);
    bucket.ids.push(event.id);
    bucket.sumLat += event.location.lat;
    bucket.sumLon += event.location.lon;
    if (severityRank(event.severity) > severityRank(bucket.maxSeverity)) bucket.maxSeverity = event.severity;
  }
  return [...buckets.values()]
    .filter((bucket) => bucket.ids.length >= minCount)
    .map((bucket) => ({
      key: bucket.key,
      type: bucket.type,
      count: bucket.ids.length,
      center: { lat: bucket.sumLat / bucket.ids.length, lon: bucket.sumLon / bucket.ids.length },
      ids: bucket.ids,
      maxSeverity: bucket.maxSeverity,
    }))
    .sort((a, b) => b.count - a.count);
}
