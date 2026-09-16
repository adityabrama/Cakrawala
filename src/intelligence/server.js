/**
 * @module intelligence/server
 *
 * The intelligence engine: keeps every provider on its own cadence, merges
 * their events, detects changes between sweeps, raises alerts with
 * cooldowns, computes correlations, and answers scoped queries and briefs.
 * Runs inside the Vite dev/preview server; no browser code here.
 */

import { runProviderSweep } from './sweep.js';
import { filterEvents, mergeEvents, sortEvents, eventAgeMs } from './eventSchema.js';
import { computeDelta } from './delta.js';
import { evaluateAlerts, escalationAlerts, applyAlertCooldown, sourceHealthAlert, pruneAlertMemory, alertLevelRank } from './alerts.js';
import { correlateEvents, clusterEvents } from './correlate.js';
import { buildBrief } from './brief.js';
import { INDONESIA_BBOX, bboxContains } from './geo.js';

export const DEFAULT_RETENTION_MS = 30 * 24 * 3_600_000;
export const DEFAULT_MAX_EVENTS = 6000;
export const DEFAULT_TICK_MS = 60_000;

/** How long an alert stays "active" after it was raised, by level. */
export const ALERT_ACTIVE_MS = Object.freeze({ CRITICAL: 72 * 3_600_000, HIGH: 48 * 3_600_000, MEDIUM: 24 * 3_600_000, LOW: 12 * 3_600_000, INFO: 6 * 3_600_000 });

/** Parse a brief/query scope string: 'indonesia' | 'province:32' | 'bbox:w,s,e,n'. */
export function parseScope(value, pack = null) {
  const text = String(value || 'indonesia').trim().toLowerCase();
  if (text.startsWith('province:')) {
    const code = text.slice('province:'.length).trim();
    const province = pack?.provinceByCode?.(code);
    return { kind: 'province', code, name: province?.name || `Province ${code}`, bbox: province?.bbox || null };
  }
  if (text.startsWith('bbox:')) {
    const parts = text.slice('bbox:'.length).split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) return { kind: 'bbox', code: null, name: 'Selected area', bbox: parts };
  }
  return { kind: 'indonesia', code: null, name: 'Indonesia', bbox: INDONESIA_BBOX };
}

/**
 * @param {object} options
 * @param {object[]} options.providers Sweep providers.
 * @param {object[]} [options.onDemand] On-demand providers (weather by point).
 * @param {object} [options.env] Environment (keys are read, never exposed).
 * @param {object} [options.pack] Indonesia data pack (see server/intelligence/pack.js).
 * @param {object} [options.memory] createIntelMemory() instance; optional.
 */
export function createIntelEngine({
  providers = [],
  onDemand = [],
  env = {},
  pack = null,
  memory = null,
  fetchImpl = fetch,
  log = console,
  now = Date.now,
  timeoutMs = 30_000,
  tickMs = DEFAULT_TICK_MS,
  retentionMs = DEFAULT_RETENTION_MS,
  maxEvents = DEFAULT_MAX_EVENTS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  // Each provider keeps a rolling store of the events it has reported: a new
  // run overwrites by id (stable ids such as a volcano's level update in
  // place) and older events stay until the provider's retention expires, so
  // the timeline can show history the upstream feed no longer lists.
  const providerState = new Map(providers.map((provider) => [provider.id, {
    provider, lastRunAt: null, nextRunAt: 0, lastState: 'pending', lastError: null, lastDurationMs: null, events: new Map(), metrics: {}, meta: {}, runs: 0,
  }]));

  function absorbEvents(entry, events) {
    const nowMs = now();
    for (const event of events) entry.events.set(event.id, event);
    const keepMs = Number.isFinite(entry.provider.retentionMs) ? entry.provider.retentionMs : retentionMs;
    const cap = Number.isFinite(entry.provider.maxEvents) ? entry.provider.maxEvents : 3000;
    const kept = sortEvents([...entry.events.values()]).filter((event) => eventAgeMs(event, nowMs) <= keepMs).slice(0, cap);
    entry.events = new Map(kept.map((event) => [event.id, event]));
  }
  const listeners = new Set();
  const state = {
    startedAt: null,
    lastSweepAt: null,
    sweeping: false,
    events: [],
    alerts: memory ? memory.getAlerts() : [],
    lastDelta: null,
    related: new Map(),
    clusters: [],
  };
  let timer = null;
  let sweepPromise = null;

  function emit(message) {
    for (const listener of listeners) {
      try { listener(message); } catch (error) { log?.warn?.(`[intel] listener error: ${error.message}`); }
    }
  }

  function rebuildEvents() {
    const nowMs = now();
    const merged = mergeEvents(...[...providerState.values()].map((entry) => [...entry.events.values()]));
    state.events = sortEvents(merged)
      .filter((event) => eventAgeMs(event, nowMs) <= retentionMs)
      .slice(0, maxEvents);
    state.related = correlateEvents(state.events);
    state.clusters = clusterEvents(state.events);
  }

  function metricsSnapshot() {
    const metrics = {};
    for (const entry of providerState.values()) Object.assign(metrics, entry.metrics);
    return metrics;
  }

  function activeAlerts(nowMs = now()) {
    return state.alerts.filter((alert) => nowMs - Date.parse(alert.raisedAt) <= (ALERT_ACTIVE_MS[alert.level] || ALERT_ACTIVE_MS.INFO));
  }

  async function sweep({ force = false, providerIds = null } = {}) {
    if (sweepPromise) return sweepPromise;
    sweepPromise = (async () => {
      state.sweeping = true;
      const nowMs = now();
      const due = (provider) => {
        const entry = providerState.get(provider.id);
        if (providerIds && !providerIds.includes(provider.id)) return false;
        return force || nowMs >= entry.nextRunAt;
      };
      const context = { fetchImpl, env, pack, log, now, cache: new Map() };
      const result = await runProviderSweep(providers, context, { timeoutMs, isDue: due, now });
      for (const providerResult of result.results) {
        const entry = providerState.get(providerResult.id);
        if (providerResult.state === 'skipped') continue;
        entry.lastRunAt = new Date(nowMs).toISOString();
        entry.lastState = providerResult.state;
        entry.lastError = providerResult.error;
        entry.lastDurationMs = providerResult.durationMs;
        entry.runs += 1;
        // A failed run keeps the previous events (marked stale via lastState);
        // a successful run replaces them.
        if (providerResult.state === 'ok') {
          absorbEvents(entry, providerResult.events);
          entry.metrics = providerResult.metrics;
          entry.meta = providerResult.meta;
          entry.nextRunAt = nowMs + entry.provider.intervalMs;
        } else if (providerResult.state === 'not-configured') {
          entry.nextRunAt = nowMs + Math.max(entry.provider.intervalMs, 10 * 60_000);
        } else if (providerResult.errorStatus === 429) {
          // Rate limited (GDELT answers 429 often): retrying after a quarter
          // of the cadence only extends the throttle, so wait at least a full
          // cadence and never less than 30 minutes.
          entry.nextRunAt = nowMs + Math.max(30 * 60_000, entry.provider.intervalMs);
        } else {
          // Back off failures: retry after a quarter of the cadence, at least 2 min.
          entry.nextRunAt = nowMs + Math.max(2 * 60_000, Math.round(entry.provider.intervalMs / 4));
        }
      }
      rebuildEvents();
      state.lastSweepAt = new Date(nowMs).toISOString();

      const snapshot = { at: state.lastSweepAt, events: state.events, metrics: metricsSnapshot() };
      const previous = memory ? memory.lastRun() : state.previousSnapshot || null;
      const priorIds = memory ? memory.knownEventIds() : null;
      state.lastDelta = computeDelta(snapshot, previous, { priorIds });
      if (memory) memory.addRun(snapshot);
      else state.previousSnapshot = { at: snapshot.at, events: snapshot.events.map((event) => ({ id: event.id, severity: event.severity })), metrics: snapshot.metrics };

      const health = getHealth();
      const candidates = [...evaluateAlerts(state.events, { nowMs }), ...escalationAlerts(state.lastDelta)];
      const healthAlert = sourceHealthAlert(health, { at: state.lastSweepAt });
      if (healthAlert) candidates.push(healthAlert);
      const alerted = pruneAlertMemory(memory ? memory.getAlerted() : state.alerted || {}, { nowMs });
      const { raised, alerted: nextAlerted } = applyAlertCooldown(candidates, alerted, { nowMs });
      if (memory) memory.setAlerted(nextAlerted); else state.alerted = nextAlerted;
      for (const alert of raised) state.alerts.unshift({ ...alert, raisedAt: state.lastSweepAt });
      state.alerts = state.alerts.filter((alert) => nowMs - Date.parse(alert.raisedAt) <= 7 * 24 * 3_600_000).slice(0, 300);
      if (memory) memory.setAlerts(state.alerts);

      const summary = {
        at: state.lastSweepAt,
        ran: result.results.filter((entry) => entry.state !== 'skipped').length,
        ok: result.results.filter((entry) => entry.state === 'ok').length,
        failed: result.results.filter((entry) => entry.state === 'error' || entry.state === 'timeout').length,
        events: state.events.length,
        newEvents: state.lastDelta?.summary.new ?? null,
        alertsRaised: raised.length,
        activeAlerts: activeAlerts(nowMs).length,
      };
      state.sweeping = false;
      emit({ type: 'sweep', ...summary });
      log?.log?.(`[intel] sweep ${summary.ok}/${summary.ran} ok · ${summary.events} events · ${summary.alertsRaised} alerts raised`);
      return summary;
    })().finally(() => { sweepPromise = null; state.sweeping = false; });
    return sweepPromise;
  }

  function getHealth() {
    const nowMs = now();
    return [...providerState.values()].map((entry) => ({
      id: entry.provider.id,
      name: entry.provider.name,
      category: entry.provider.category,
      region: entry.provider.region,
      auth: entry.provider.auth,
      envKey: entry.provider.envKey,
      configured: entry.provider.isConfigured(env),
      state: entry.lastState === 'pending' ? 'pending' : entry.lastState,
      error: entry.lastError,
      lastRunAt: entry.lastRunAt,
      nextRunAt: entry.nextRunAt ? new Date(entry.nextRunAt).toISOString() : null,
      durationMs: entry.lastDurationMs,
      eventCount: entry.events.size,
      stale: entry.lastRunAt ? nowMs - Date.parse(entry.lastRunAt) > 2 * entry.provider.intervalMs : false,
      intervalMs: entry.provider.intervalMs,
      attribution: entry.provider.attribution,
      license: entry.provider.license,
      sourceUrl: entry.provider.sourceUrl,
      runs: entry.runs,
      // Multi-feed providers (the RSS news provider) report per-feed health;
      // surface only the summary so one failing outlet is visible without
      // turning the whole provider red.
      feeds: Number.isFinite(entry.meta?.feedsTotal)
        ? {
          ok: entry.meta.feedsOk,
          total: entry.meta.feedsTotal,
          failing: (entry.meta.feeds || []).filter((feed) => feed.state === 'error' || feed.state === 'stale').map((feed) => ({ id: feed.id, outlet: feed.outlet, state: feed.state, error: feed.error })),
        }
        : null,
    }));
  }

  function tick() {
    timer = null;
    const nowMs = now();
    const anyDue = [...providerState.values()].some((entry) => nowMs >= entry.nextRunAt);
    const run = anyDue ? sweep().catch((error) => log?.warn?.(`[intel] sweep failed: ${error.message}`)) : Promise.resolve();
    run.finally(() => { if (state.startedAt) timer = setTimer(tick, tickMs); });
  }

  function scopeFilter(scope, extra = {}) {
    const filter = { ...extra };
    if (scope.kind === 'province') filter.provinceCode = scope.code;
    else if (scope.bbox) filter.bbox = scope.bbox;
    // The Indonesia scope is a bbox for positioned events, but an Indonesian
    // event without a position (most news headlines, some BNPB rows) still
    // belongs to it. Without this every unlocated headline vanished from the
    // default /events read. A drawn bbox scope keeps excluding them.
    if (scope.kind === 'indonesia') filter.unlocatedCountry = 'ID';
    return filter;
  }

  return {
    start({ firstSweepDelayMs = 1500 } = {}) {
      if (state.startedAt) return;
      state.startedAt = new Date(now()).toISOString();
      timer = setTimer(tick, firstSweepDelayMs);
    },
    stop() {
      state.startedAt = null;
      if (timer) clearTimer(timer);
      timer = null;
    },
    sweep,
    getHealth,
    getStatus() {
      const health = getHealth();
      const nowMs = now();
      return {
        startedAt: state.startedAt,
        lastSweepAt: state.lastSweepAt,
        sweeping: state.sweeping,
        nextSweepAt: health.filter((entry) => entry.nextRunAt).map((entry) => entry.nextRunAt).sort()[0] || null,
        eventCount: state.events.length,
        activeAlerts: activeAlerts(nowMs).length,
        counts: {
          byType: countBy(state.events, (event) => event.type),
          bySeverity: countBy(state.events, (event) => event.severity),
          byStatus: countBy(state.events, (event) => event.status),
        },
        delta: state.lastDelta?.summary || null,
        health,
        summary: {
          ok: health.filter((entry) => entry.state === 'ok').length,
          failing: health.filter((entry) => entry.state === 'error' || entry.state === 'timeout').length,
          notConfigured: health.filter((entry) => entry.state === 'not-configured' || !entry.configured).length,
          pending: health.filter((entry) => entry.state === 'pending').length,
        },
      };
    },
    getEvents(filter = {}) {
      const scope = parseScope(filter.scope, pack);
      return filterEvents(state.events, scopeFilter(scope, filter));
    },
    getEvent(id) {
      const event = state.events.find((entry) => entry.id === id) || null;
      return event ? { ...event, related: state.related.get(id) || [] } : null;
    },
    getRelated(id) {
      return state.related.get(id) || [];
    },
    getClusters({ type = null, minCount = 3 } = {}) {
      return state.clusters.filter((cluster) => (!type || cluster.type === type) && cluster.count >= minCount);
    },
    getAlerts({ scope = 'indonesia', minLevel = 'INFO', activeOnly = true } = {}) {
      const parsed = parseScope(scope, pack);
      const nowMs = now();
      return (activeOnly ? activeAlerts(nowMs) : state.alerts).filter((alert) => {
        if (alertLevelRank(alert.level) < alertLevelRank(minLevel)) return false;
        if (parsed.kind === 'province') return alert.provinceCode === parsed.code || !alert.provinceCode && alert.rule === 'source-health';
        if (parsed.kind === 'bbox' && alert.location) return bboxContains(parsed.bbox, alert.location.lat, alert.location.lon);
        return true;
      });
    },
    getDelta() {
      return state.lastDelta;
    },
    getMetrics: metricsSnapshot,
    getProviderMeta(id) {
      return providerState.get(id)?.meta || null;
    },
    getBrief({ scope = 'indonesia', windowMs } = {}) {
      const parsed = parseScope(scope, pack);
      return buildBrief({
        events: filterEvents(state.events, scopeFilter(parsed)),
        alerts: this.getAlerts({ scope }),
        health: getHealth(),
        scope: { name: parsed.name, code: parsed.code },
        nowMs: now(),
        windowMs,
      });
    },
    async queryPoint({ lat, lon, signal } = {}) {
      const results = {};
      for (const provider of onDemand) {
        if (typeof provider.query !== 'function' || !provider.isConfigured(env)) continue;
        try {
          results[provider.id] = await provider.query({ lat, lon, fetchImpl, signal, env });
        } catch (error) {
          results[provider.id] = { error: String(error.message || error).slice(0, 200) };
        }
      }
      return results;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    _state: state,
  };
}

function countBy(list, keyOf) {
  const counts = {};
  for (const item of list) {
    const key = keyOf(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}
