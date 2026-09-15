/**
 * @module intelligence/brief
 *
 * Rule-based Indonesia / region briefs. Every line is derived from events,
 * alerts, and provider health the engine actually holds, and every line
 * carries its source and timestamp. No language model is required; when one
 * is configured the structured brief is the only material it may summarize.
 */

import { alertLevelRank } from './alerts.js';
import { eventAgeMs, severityRank, sortEvents } from './eventSchema.js';

const SECTION_ORDER = Object.freeze([
  ['earthquake', 'Earthquakes'],
  ['tsunami', 'Tsunami bulletins'],
  ['volcano', 'Volcanic activity'],
  ['flood', 'Floods'],
  ['landslide', 'Landslides'],
  ['fire', 'Fires'],
  ['weather', 'Weather'],
  ['drought', 'Drought'],
  ['haze', 'Haze'],
  ['disaster', 'Other disasters'],
  ['transport', 'Transport'],
  ['aviation', 'Aviation'],
  ['maritime', 'Maritime'],
  ['news', 'Public news'],
  ['economy', 'Economy'],
]);

function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown age';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function stamp(event, nowMs) {
  return `[${event.source} · ${event.timestamp} · ${formatAge(eventAgeMs(event, nowMs))} · ${event.status}]`;
}

function eventLine(event, nowMs) {
  const where = [event.city, event.province].filter(Boolean).join(', ');
  const magnitude = Number.isFinite(event.magnitude) ? ` M${event.magnitude.toFixed(1)}` : '';
  return `${event.severity.toUpperCase()}${magnitude} — ${event.title}${where ? ` (${where})` : ''} ${stamp(event, nowMs)}`;
}

/**
 * Build a structured brief.
 * @param {object} input
 * @param {object[]} input.events Normalized events (already scoped to the region).
 * @param {object[]} input.alerts Active alerts (already scoped).
 * @param {object[]} input.health Provider health from the latest sweep.
 * @param {{name: string, code?: string|null}} [input.scope] Region label.
 * @param {number} [input.nowMs]
 * @param {number} [input.windowMs] Only events inside this window are summarized (default 72 h).
 * @param {number} [input.maxPerSection]
 */
export function buildBrief({ events = [], alerts = [], health = [], scope = { name: 'Indonesia', code: null }, nowMs = Date.now(), windowMs = 72 * 3_600_000, maxPerSection = 5 } = {}) {
  // Routine rows (a volcano at Level I, a fair-weather forecast, a micro
  // quake) are events, not signals: the brief summarizes what is notable.
  const recent = sortEvents(events).filter((event) => eventAgeMs(event, nowMs) <= windowMs && severityRank(event.severity) >= 1);
  const sections = [];
  for (const [type, label] of SECTION_ORDER) {
    const rows = recent.filter((event) => event.type === type);
    if (!rows.length) continue;
    const top = rows
      .slice()
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, maxPerSection);
    sections.push({
      type,
      label,
      count: rows.length,
      highestSeverity: top[0].severity,
      lines: top.map((event) => eventLine(event, nowMs)),
      eventIds: top.map((event) => event.id),
    });
  }

  const activeAlerts = alerts
    .slice()
    .sort((a, b) => alertLevelRank(b.level) - alertLevelRank(a.level) || Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 8)
    .map((alert) => `${alert.level} — ${alert.title}: ${alert.reason} [${alert.source} · ${alert.timestamp} · confidence ${Math.round(alert.confidence * 100)}%]`);

  const okSources = health.filter((entry) => entry.state === 'ok').map((entry) => entry.name || entry.id);
  const failing = health.filter((entry) => entry.state === 'error' || entry.state === 'timeout').map((entry) => `${entry.name || entry.id} (${entry.error || entry.state})`);
  const notConfigured = health.filter((entry) => entry.state === 'not-configured').map((entry) => entry.name || entry.id);

  const highest = sections.reduce((max, section) => Math.max(max, severityRank(section.highestSeverity)), 0);
  const headline = sections.length
    ? `${scope.name}: ${recent.length} signals in the last ${Math.round(windowMs / 3_600_000)} h across ${sections.length} categories; highest severity ${['info', 'low', 'medium', 'high', 'critical'][highest].toUpperCase()}.`
    : `${scope.name}: no signals in the last ${Math.round(windowMs / 3_600_000)} h from the configured sources.`;

  const lines = [
    `INDONESIA BRIEF — ${scope.name} — generated ${new Date(nowMs).toISOString()}`,
    headline,
    '',
  ];
  if (activeAlerts.length) lines.push('ACTIVE ALERTS', ...activeAlerts.map((line) => `  • ${line}`), '');
  for (const section of sections) {
    lines.push(`${section.label.toUpperCase()} (${section.count})`, ...section.lines.map((line) => `  • ${line}`), '');
  }
  lines.push('DATA SOURCES');
  lines.push(`  • Reporting: ${okSources.length ? okSources.join(', ') : 'none'}`);
  if (failing.length) lines.push(`  • Failing: ${failing.join('; ')}`);
  if (notConfigured.length) lines.push(`  • Not configured: ${notConfigured.join(', ')}`);
  lines.push('  • Every line above names its source and timestamp. Correlations are related signals, not confirmed causes.');

  return {
    scope,
    generatedAt: new Date(nowMs).toISOString(),
    windowHours: Math.round(windowMs / 3_600_000),
    headline,
    signalCount: recent.length,
    highestSeverity: ['info', 'low', 'medium', 'high', 'critical'][highest],
    alerts: activeAlerts,
    sections,
    sources: { reporting: okSources, failing, notConfigured },
    text: lines.join('\n'),
  };
}
