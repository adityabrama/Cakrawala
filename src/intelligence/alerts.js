/**
 * @module intelligence/alerts
 *
 * Transparent alert rules. Every alert names its source, timestamp, the rule
 * that produced it, its confidence, and its location. Rules only escalate
 * what the data already says (a magnitude, an official alert level, a
 * casualty count) — nothing here infers causes or predicts outcomes.
 */

import { severityRank } from './eventSchema.js';

export const ALERT_LEVELS = Object.freeze(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** Alert cooldown tiers (hours) for repeated occurrences of the same key. */
export const ALERT_COOLDOWN_HOURS = Object.freeze([0, 6, 12, 24]);

const LEVEL_FROM_SEVERITY = Object.freeze({
  info: 'INFO', low: 'LOW', medium: 'MEDIUM', high: 'HIGH', critical: 'CRITICAL',
});

/** Rank of an alert level (INFO = 0 … CRITICAL = 4). */
export function alertLevelRank(level) {
  const index = ALERT_LEVELS.indexOf(String(level || '').toUpperCase());
  return index < 0 ? 0 : index;
}

function alertFromEvent(event, { rule, level, reason, confidence }) {
  return {
    id: `alert:${rule}:${event.id}`,
    key: `${rule}:${event.id}`,
    level,
    rule,
    title: event.title,
    reason,
    source: event.source,
    sourceUrl: event.sourceUrl,
    timestamp: event.timestamp,
    location: event.location,
    province: event.province,
    provinceCode: event.provinceCode,
    confidence: Math.round(Math.min(1, Math.max(0, confidence ?? event.confidence)) * 100) / 100,
    status: event.status,
    eventIds: [event.id],
    attribution: event.attribution,
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * Rule set. Each rule inspects one event and returns an alert or null.
 * Rules are ordered so the most specific claim wins for an event type. A
 * verdict may carry `maxAgeMs`: older events are still events, but they are
 * not alerts (the default window is 72 h). Steady states that are normal for
 * Indonesia (22 volcanoes sit at Level II) alert only when they change —
 * see `escalationAlerts`.
 */
export const ALERT_RULES = Object.freeze([
  {
    id: 'tsunami-potential',
    test(event) {
      if (event.type !== 'earthquake' || !event.raw?.tsunamiPotential) return null;
      return { level: 'CRITICAL', reason: 'Official bulletin flags tsunami potential', confidence: event.confidence, maxAgeMs: 7 * DAY };
    },
  },
  {
    id: 'major-earthquake',
    test(event) {
      if (event.type !== 'earthquake' || !Number.isFinite(event.magnitude)) return null;
      if (event.magnitude >= 7) return { level: 'CRITICAL', reason: `Magnitude ${event.magnitude.toFixed(1)} earthquake`, maxAgeMs: 14 * DAY };
      if (event.magnitude >= 6) return { level: 'HIGH', reason: `Magnitude ${event.magnitude.toFixed(1)} earthquake`, maxAgeMs: 7 * DAY };
      if (event.magnitude >= 5) return { level: 'MEDIUM', reason: `Magnitude ${event.magnitude.toFixed(1)} earthquake`, maxAgeMs: 3 * DAY };
      if (event.raw?.felt && event.magnitude >= 4) return { level: 'LOW', reason: `Magnitude ${event.magnitude.toFixed(1)} earthquake reported felt`, maxAgeMs: DAY };
      return null;
    },
  },
  {
    id: 'volcano-alert-level',
    test(event) {
      if (event.type !== 'volcano') return null;
      const level = Number(event.raw?.alertLevel);
      if (level >= 4) return { level: 'CRITICAL', reason: 'Alert level IV (Awas)', maxAgeMs: 30 * DAY };
      if (level === 3) return { level: 'HIGH', reason: 'Alert level III (Siaga)', maxAgeMs: 30 * DAY };
      return null;
    },
  },
  {
    // Listed before disaster-impact: a forecast is judged on what it
    // predicts, never as reported impact.
    id: 'severe-weather-forecast',
    test(event) {
      if (event.type !== 'weather' || !event.raw?.severe) return null;
      if (severityRank(event.severity) < severityRank('medium')) return null;
      return { level: severityRank(event.severity) >= severityRank('high') ? 'MEDIUM' : 'LOW', reason: `Forecast: ${event.raw.severe}`, confidence: 0.6, maxAgeMs: DAY };
    },
  },
  {
    id: 'disaster-impact',
    test(event) {
      if (!['flood', 'landslide', 'fire', 'disaster', 'weather', 'drought', 'haze'].includes(event.type)) return null;
      if (event.subtype === 'forecast' || event.raw?.severe !== undefined) return null;
      const impact = event.raw?.impact || {};
      const deaths = Number(impact.deaths) || 0;
      const missing = Number(impact.missing) || 0;
      const displaced = Number(impact.displaced) || 0;
      const injured = Number(impact.injured) || 0;
      const housesDamaged = Number(impact.housesDamaged) || 0;
      if (deaths + missing >= 5) return { level: 'CRITICAL', reason: `${deaths} dead, ${missing} missing reported`, maxAgeMs: 14 * DAY };
      if (deaths + missing >= 1) return { level: 'HIGH', reason: `${deaths} dead, ${missing} missing reported`, maxAgeMs: 14 * DAY };
      if (displaced >= 500 || housesDamaged >= 200) return { level: 'HIGH', reason: `${displaced} displaced, ${housesDamaged} houses damaged`, maxAgeMs: 14 * DAY };
      if (displaced >= 50 || injured >= 10 || housesDamaged >= 20) return { level: 'MEDIUM', reason: `${displaced} displaced, ${injured} injured, ${housesDamaged} houses damaged`, maxAgeMs: 14 * DAY };
      if (severityRank(event.severity) >= severityRank('medium')) return { level: LEVEL_FROM_SEVERITY[event.severity], reason: 'Reported by the source as a significant event', maxAgeMs: 14 * DAY };
      return null;
    },
  },
]);

export const DEFAULT_ALERT_MAX_AGE_MS = 72 * HOUR;

/**
 * Evaluate events against the rules. Returns alerts newest first without
 * applying cooldowns (the engine's memory does that). Forecast timestamps can
 * sit in the near future, so age is clamped at zero.
 */
export function evaluateAlerts(events, { rules = ALERT_RULES, minLevel = 'LOW', nowMs = Date.now() } = {}) {
  const alerts = [];
  const minRank = alertLevelRank(minLevel);
  for (const event of events || []) {
    const ageMs = Math.max(0, nowMs - Date.parse(event.timestamp));
    for (const rule of rules) {
      const verdict = rule.test(event);
      if (!verdict) continue;
      if (alertLevelRank(verdict.level) < minRank) break;
      if (ageMs > (verdict.maxAgeMs ?? DEFAULT_ALERT_MAX_AGE_MS)) break;
      const { maxAgeMs, ...fields } = verdict;
      alerts.push(alertFromEvent(event, { rule: rule.id, ...fields }));
      break;
    }
  }
  return alerts.sort((a, b) => (
    alertLevelRank(b.level) - alertLevelRank(a.level)
    || Date.parse(b.timestamp) - Date.parse(a.timestamp)
  ));
}

/**
 * Alerts for severity escalations between sweeps (a volcano moving from
 * Level II to III, a report whose casualty count rose). Fed from the delta so
 * a steady state never re-alerts.
 */
export function escalationAlerts(delta) {
  const alerts = [];
  for (const entry of delta?.escalated || []) {
    const event = entry.event;
    const level = LEVEL_FROM_SEVERITY[entry.to] || 'LOW';
    if (alertLevelRank(level) < alertLevelRank('MEDIUM')) continue;
    alerts.push({
      ...alertFromEvent(event, { rule: 'escalation', level, reason: `Severity rose from ${entry.from} to ${entry.to}`, confidence: event.confidence }),
      id: `alert:escalation:${event.id}:${entry.to}`,
      key: `escalation:${event.id}:${entry.to}`,
    });
  }
  return alerts;
}

/**
 * Source-health alert: a sweep with several failing providers is worth an
 * INFO line so the operator knows freshness is degraded.
 */
export function sourceHealthAlert(health, { at = new Date().toISOString(), threshold = 2 } = {}) {
  const failing = (health || []).filter((entry) => entry.state === 'error' || entry.state === 'timeout');
  if (failing.length < threshold) return null;
  return {
    id: `alert:source-health:${at}`,
    key: 'source-health',
    level: failing.length >= 5 ? 'MEDIUM' : 'INFO',
    rule: 'source-health',
    title: `${failing.length} data sources failing`,
    reason: failing.map((entry) => `${entry.name || entry.id}: ${entry.error || entry.state}`).join('; ').slice(0, 300),
    source: 'sweep',
    sourceUrl: null,
    timestamp: at,
    location: null,
    province: null,
    provinceCode: null,
    confidence: 1,
    status: 'live',
    eventIds: [],
    attribution: 'CAKRAWALA intelligence sweep',
  };
}

/**
 * Cooldown gate. `alerted` maps alert key → { count, lastAt }. Returns the
 * alerts that may be raised now and the updated map. Repeated occurrences of
 * the same key wait progressively longer (ALERT_COOLDOWN_HOURS).
 */
export function applyAlertCooldown(alerts, alerted = {}, { nowMs = Date.now() } = {}) {
  const next = { ...alerted };
  const raised = [];
  for (const alert of alerts) {
    const record = next[alert.key];
    if (record) {
      const tier = Math.min(record.count, ALERT_COOLDOWN_HOURS.length - 1);
      const waitMs = ALERT_COOLDOWN_HOURS[tier] * 3_600_000;
      if (nowMs - record.lastAt < waitMs) continue;
      next[alert.key] = { count: record.count + 1, lastAt: nowMs, level: alert.level };
    } else {
      next[alert.key] = { count: 1, lastAt: nowMs, level: alert.level };
    }
    raised.push(alert);
  }
  return { raised, alerted: next };
}

/** Drop cooldown records older than `maxAgeMs` so the map stays bounded. */
export function pruneAlertMemory(alerted = {}, { nowMs = Date.now(), maxAgeMs = 7 * 24 * 3_600_000 } = {}) {
  const out = {};
  for (const [key, record] of Object.entries(alerted)) {
    if (nowMs - record.lastAt <= maxAgeMs) out[key] = record;
  }
  return out;
}
