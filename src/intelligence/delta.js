/**
 * @module intelligence/delta
 *
 * Change detection between two sweeps: new, escalated, and removed events,
 * plus metric changes above per-metric thresholds. The output is what alerts
 * and the change feed are built from; nothing here decides how loud a change
 * is to the user.
 */

import { severityRank } from './eventSchema.js';

/** Default change thresholds when a metric declares none. */
export const DEFAULT_NUMERIC_THRESHOLD_PCT = 5;
export const DEFAULT_COUNT_THRESHOLD = 1;

/**
 * A snapshot is what the engine stores after each sweep:
 *   { at, events: Event[], metrics: { [key]: Metric } }
 * A metric is { value, label, kind: 'numeric'|'count', threshold?, unit?, source }.
 */

function metricSeverity(ratio) {
  if (ratio >= 3) return 'critical';
  if (ratio >= 2) return 'high';
  return 'moderate';
}

/**
 * Compare metrics of two snapshots.
 * @returns {object[]} changes: { key, label, from, to, change, pctChange, direction, severity, kind, source }
 */
export function compareMetrics(currentMetrics = {}, previousMetrics = {}) {
  const changes = [];
  for (const [key, metric] of Object.entries(currentMetrics || {})) {
    const previous = previousMetrics?.[key];
    const to = Number(metric?.value);
    const from = Number(previous?.value);
    if (!Number.isFinite(to) || !Number.isFinite(from)) continue;
    const kind = metric.kind === 'count' ? 'count' : 'numeric';
    if (kind === 'count') {
      const threshold = Number.isFinite(Number(metric.threshold)) ? Number(metric.threshold) : DEFAULT_COUNT_THRESHOLD;
      const change = to - from;
      if (Math.abs(change) < Math.max(1, threshold)) continue;
      changes.push({
        key, label: metric.label || key, kind, from, to, change,
        pctChange: from !== 0 ? Math.round((change / Math.abs(from)) * 1000) / 10 : null,
        direction: change > 0 ? 'up' : 'down',
        severity: metricSeverity(Math.abs(change) / Math.max(1, threshold)),
        source: metric.source || null,
      });
    } else {
      const threshold = Number.isFinite(Number(metric.threshold)) ? Number(metric.threshold) : DEFAULT_NUMERIC_THRESHOLD_PCT;
      const pctChange = from !== 0 ? ((to - from) / Math.abs(from)) * 100 : (to === 0 ? 0 : 100);
      if (Math.abs(pctChange) <= threshold) continue;
      changes.push({
        key, label: metric.label || key, kind, from, to, change: to - from,
        pctChange: Math.round(pctChange * 10) / 10,
        direction: pctChange > 0 ? 'up' : 'down',
        severity: metricSeverity(Math.abs(pctChange) / threshold),
        source: metric.source || null,
      });
    }
  }
  return changes;
}

/**
 * Compute the delta between the current snapshot and the previous one.
 * `priorIds` (ids seen in older snapshots) widens the "new" test so an event
 * that dropped out of one sweep and reappeared is not announced twice.
 * @returns {object|null} null when there is nothing to compare against.
 */
export function computeDelta(current, previous, { priorIds = null } = {}) {
  if (!current) return null;
  if (!previous) return null;
  const previousById = new Map((previous.events || []).map((event) => [event.id, event]));
  const currentById = new Map((current.events || []).map((event) => [event.id, event]));
  const seenBefore = new Set([...previousById.keys(), ...(priorIds || [])]);

  const newEvents = [];
  const escalated = [];
  const deescalated = [];
  for (const event of current.events || []) {
    const before = previousById.get(event.id);
    if (!before) {
      if (!seenBefore.has(event.id)) newEvents.push(event);
      continue;
    }
    const rankNow = severityRank(event.severity);
    const rankBefore = severityRank(before.severity);
    if (rankNow > rankBefore) escalated.push({ event, from: before.severity, to: event.severity });
    else if (rankNow < rankBefore) deescalated.push({ event, from: before.severity, to: event.severity });
  }
  const removed = [];
  for (const [id, event] of previousById) {
    if (!currentById.has(id)) removed.push(event);
  }
  const metricChanges = compareMetrics(current.metrics, previous.metrics);
  const criticalChanges = newEvents.filter((event) => severityRank(event.severity) >= severityRank('high')).length
    + escalated.filter((entry) => severityRank(entry.to) >= severityRank('high')).length
    + metricChanges.filter((change) => change.severity === 'critical').length;

  return {
    at: current.at,
    previousAt: previous.at,
    newEvents,
    escalated,
    deescalated,
    removed,
    metricChanges,
    summary: {
      new: newEvents.length,
      escalated: escalated.length,
      deescalated: deescalated.length,
      removed: removed.length,
      metricChanges: metricChanges.length,
      criticalChanges,
      totalChanges: newEvents.length + escalated.length + deescalated.length + removed.length + metricChanges.length,
    },
  };
}
