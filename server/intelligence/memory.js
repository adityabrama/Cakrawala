/**
 * @module server/intelligence/memory
 *
 * Sweep history on disk so change detection and alert cooldowns survive a
 * dev-server restart. Hot memory keeps the last few compact snapshots in one
 * JSON file written atomically (temp file + rename, previous copy kept as
 * `.bak`); older snapshots are appended to a per-day cold JSONL file.
 *
 * Node only. The default directory `.gev-intel/` is git-ignored.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_HOT_RUNS = 6;

/** Keep only what change detection needs from a snapshot. */
export function compactSnapshot(snapshot, { maxEvents = 4000 } = {}) {
  return {
    at: snapshot.at,
    metrics: snapshot.metrics || {},
    events: (snapshot.events || []).slice(0, maxEvents).map((event) => ({
      id: event.id,
      type: event.type,
      severity: event.severity,
      timestamp: event.timestamp,
      title: event.title,
      source: event.source,
      location: event.location,
      provinceCode: event.provinceCode || null,
    })),
  };
}

/**
 * @param {string} dir Directory for hot.json and the cold/ folder.
 * @param {{maxHotRuns?: number, log?: Pick<Console,'warn'>}} [options]
 */
export function createIntelMemory(dir, { maxHotRuns = DEFAULT_HOT_RUNS, log = console } = {}) {
  const hotPath = join(dir, 'hot.json');
  const coldDir = join(dir, 'cold');
  for (const path of [dir, coldDir]) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
  }

  function load() {
    for (const path of [hotPath, `${hotPath}.bak`]) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (data && Array.isArray(data.runs) && data.alerted && typeof data.alerted === 'object') {
          return { ...data, alerts: Array.isArray(data.alerts) ? data.alerts : [] };
        }
      } catch {
        // try the next candidate
      }
    }
    return { runs: [], alerted: {}, alerts: [] };
  }

  let hot = load();

  function save() {
    const tmpPath = `${hotPath}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(hot));
      if (existsSync(hotPath)) {
        try { renameSync(hotPath, `${hotPath}.bak`); } catch { /* backup is best effort */ }
      }
      renameSync(tmpPath, hotPath);
    } catch (error) {
      log?.warn?.(`[intel-memory] save failed: ${error.message}`);
      try { unlinkSync(tmpPath); } catch { /* nothing to clean */ }
    }
  }

  function archive(runs) {
    for (const run of runs) {
      const day = String(run.at || '').slice(0, 10) || 'undated';
      try {
        appendFileSync(join(coldDir, `${day}.jsonl`), `${JSON.stringify(run)}\n`);
      } catch (error) {
        log?.warn?.(`[intel-memory] archive failed: ${error.message}`);
      }
    }
  }

  return {
    /** Store a snapshot; returns the previous compact snapshot (or null). */
    addRun(snapshot) {
      const previous = hot.runs[0] || null;
      hot.runs.unshift(compactSnapshot(snapshot));
      if (hot.runs.length > maxHotRuns) archive(hot.runs.splice(maxHotRuns));
      save();
      return previous;
    },
    lastRun() {
      return hot.runs[0] || null;
    },
    /** Ids of events seen in every hot run (for wider "new" dedup). */
    knownEventIds() {
      const ids = new Set();
      for (const run of hot.runs) for (const event of run.events || []) ids.add(event.id);
      return ids;
    },
    runs() {
      return hot.runs.slice();
    },
    getAlerted() {
      return { ...hot.alerted };
    },
    setAlerted(alerted) {
      hot.alerted = alerted && typeof alerted === 'object' ? alerted : {};
      save();
    },
    /** Raised alerts survive a dev-server restart so the Alert Center is never empty because of a reboot. */
    getAlerts() {
      return Array.isArray(hot.alerts) ? hot.alerts.slice() : [];
    },
    setAlerts(alerts) {
      hot.alerts = Array.isArray(alerts) ? alerts.slice(0, 300) : [];
      save();
    },
    reset() {
      hot = { runs: [], alerted: {}, alerts: [] };
      save();
    },
    paths: { hot: hotPath, cold: coldDir },
  };
}
