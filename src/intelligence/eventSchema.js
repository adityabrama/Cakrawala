/**
 * @module intelligence/eventSchema
 *
 * The one record every intelligence provider emits and every consumer (map
 * layers, alerts, correlation, briefs, voice tools) reads. Provenance is part
 * of the record: where it came from, when it was updated, and whether it is
 * live, delayed, modeled, estimated, or historical.
 *
 * Pure module: no DOM, no Cesium, no network. Runs in Node (dev-server engine)
 * and in the browser.
 */

export const SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);
export const STATUSES = Object.freeze(['live', 'delayed', 'modeled', 'estimated', 'historical']);
export const EVENT_TYPES = Object.freeze([
  'earthquake', 'tsunami', 'volcano', 'flood', 'landslide', 'fire', 'weather',
  'drought', 'haze', 'disaster', 'news', 'transport', 'aviation', 'maritime',
  'infrastructure', 'economy', 'health', 'other',
]);

const SEVERITY_RANK = new Map(SEVERITIES.map((level, index) => [level, index]));
const MAX_TEXT = 400;
const MAX_ID = 200;

/** Numeric rank of a severity level (info = 0 … critical = 4); unknown → 0. */
export function severityRank(level) {
  return SEVERITY_RANK.get(String(level || '').toLowerCase()) ?? 0;
}

/** Clamp a free-text field to a bounded, single-line string. */
export function cleanText(value, max = MAX_TEXT) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** ISO timestamp for a Date, epoch ms, or parseable string; null when invalid. */
export function toIsoTimestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? new Date(value).toISOString() : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Finite coordinate pair inside the WGS84 envelope, or null. */
export function normalizeLocation(location) {
  if (!location || typeof location !== 'object') return null;
  const lat = Number(location.lat);
  const lon = Number(location.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const out = { lat, lon };
  const depthKm = Number(location.depthKm);
  if (Number.isFinite(depthKm)) out.depthKm = depthKm;
  return out;
}

function normalizeEnum(values, value, fallback) {
  const normalized = String(value ?? '').toLowerCase();
  return values.includes(normalized) ? normalized : fallback;
}

function normalizeConfidence(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.max(0, Math.min(1, number)) * 100) / 100;
}

function httpUrlOrNull(value) {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Build a normalized event. Returns null when the record cannot be trusted
 * (missing id/source/timestamp, unusable coordinates), so a malformed upstream
 * row is dropped rather than crashing a sweep or the globe.
 * @param {object} fields
 * @returns {object|null}
 */
export function createEvent(fields = {}) {
  const id = cleanText(fields.id, MAX_ID);
  const source = cleanText(fields.source, 80);
  const timestamp = toIsoTimestamp(fields.timestamp);
  const location = normalizeLocation(fields.location);
  const attribution = cleanText(fields.attribution, 200);
  if (!id || !source || !timestamp || !attribution) return null;
  if (fields.location !== null && fields.location !== undefined && !location) return null;

  const event = {
    id,
    source,
    sourceUrl: httpUrlOrNull(fields.sourceUrl),
    type: normalizeEnum(EVENT_TYPES, fields.type, 'other'),
    subtype: cleanText(fields.subtype, 60) || null,
    timestamp,
    location,
    geometry: fields.geometry && typeof fields.geometry === 'object' ? fields.geometry : null,
    title: cleanText(fields.title, 200) || id,
    description: cleanText(fields.description, MAX_TEXT),
    severity: normalizeEnum(SEVERITIES, fields.severity, 'info'),
    confidence: normalizeConfidence(fields.confidence),
    status: normalizeEnum(STATUSES, fields.status, 'live'),
    entities: Array.isArray(fields.entities) ? fields.entities.map((entry) => cleanText(entry, 80)).filter(Boolean).slice(0, 20) : [],
    region: cleanText(fields.region, 40) || null,
    country: cleanText(fields.country, 8).toUpperCase() || null,
    province: cleanText(fields.province, 80) || null,
    provinceCode: cleanText(fields.provinceCode, 8) || null,
    city: cleanText(fields.city, 80) || null,
    raw: fields.raw && typeof fields.raw === 'object' ? fields.raw : {},
    attribution,
  };
  if (Number.isFinite(Number(fields.magnitude))) event.magnitude = Number(fields.magnitude);
  if (fields.expiresAt) event.expiresAt = toIsoTimestamp(fields.expiresAt);
  return event;
}

/** Age of an event in milliseconds at `nowMs`. */
export function eventAgeMs(event, nowMs = Date.now()) {
  const ms = Date.parse(event?.timestamp || '');
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - ms);
}

/**
 * Sort newest first, then by severity so the top of a feed is the most
 * recent and, within a moment, the most important.
 */
export function sortEvents(events) {
  return [...events].sort((a, b) => (
    Date.parse(b.timestamp) - Date.parse(a.timestamp)
    || severityRank(b.severity) - severityRank(a.severity)
    || a.id.localeCompare(b.id)
  ));
}

/**
 * Merge events by id, keeping the record with the newest timestamp (or, at
 * equal timestamps, the higher severity). Input order does not matter.
 */
export function mergeEvents(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const event of Array.isArray(list) ? list : []) {
      if (!event?.id) continue;
      const existing = byId.get(event.id);
      if (!existing) {
        byId.set(event.id, event);
        continue;
      }
      const newer = Date.parse(event.timestamp) - Date.parse(existing.timestamp);
      if (newer > 0 || (newer === 0 && severityRank(event.severity) > severityRank(existing.severity))) {
        byId.set(event.id, event);
      }
    }
  }
  return [...byId.values()];
}

/**
 * Filter events by type, time window, severity floor, province, bounding
 * box, and status. All filters optional.
 */
export function filterEvents(events, {
  types = null,
  sinceMs = null,
  untilMs = null,
  minSeverity = null,
  provinceCode = null,
  bbox = null,
  statuses = null,
  limit = null,
} = {}) {
  const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
  const statusSet = Array.isArray(statuses) && statuses.length ? new Set(statuses) : null;
  const minRank = minSeverity ? severityRank(minSeverity) : 0;
  const out = [];
  for (const event of sortEvents(events)) {
    if (typeSet && !typeSet.has(event.type)) continue;
    if (statusSet && !statusSet.has(event.status)) continue;
    if (severityRank(event.severity) < minRank) continue;
    const ms = Date.parse(event.timestamp);
    if (sinceMs !== null && ms < sinceMs) continue;
    if (untilMs !== null && ms > untilMs) continue;
    if (provinceCode && event.provinceCode !== provinceCode) continue;
    if (bbox) {
      if (!event.location) continue;
      const [west, south, east, north] = bbox;
      if (event.location.lon < west || event.location.lon > east
        || event.location.lat < south || event.location.lat > north) continue;
    }
    out.push(event);
    if (limit && out.length >= limit) break;
  }
  return out;
}
