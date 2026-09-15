/**
 * @module indonesia/indonesiaState
 *
 * Shared Indonesia-mode state: mode flag, selected province, timeline window,
 * event-type filter, map mode (3D globe / GIS map), and the selected event.
 * The Cesium event layers, the drawer, the GIS map, and the voice tools all
 * read the same object, so switching views never loses the analytical
 * context. Persisted per browser (not in share links).
 */

export const INDONESIA_STATE_STORAGE_KEY = 'gev:indonesia:v1';
export const TIMELINE_PRESETS = Object.freeze([
  { id: '1h', label: '1 h', hours: 1 },
  { id: '6h', label: '6 h', hours: 6 },
  { id: '24h', label: '24 h', hours: 24 },
  { id: '3d', label: '3 d', hours: 72 },
  { id: '7d', label: '7 d', hours: 24 * 7 },
  { id: '30d', label: '30 d', hours: 24 * 30 },
]);
export const EVENT_TYPE_GROUPS = Object.freeze([
  { id: 'earthquake', label: 'Earthquake', types: ['earthquake', 'tsunami'] },
  { id: 'volcano', label: 'Volcano', types: ['volcano'] },
  { id: 'flood', label: 'Flood', types: ['flood'] },
  { id: 'landslide', label: 'Landslide', types: ['landslide'] },
  { id: 'fire', label: 'Fire', types: ['fire', 'haze'] },
  { id: 'weather', label: 'Weather', types: ['weather', 'drought'] },
  { id: 'other', label: 'Other', types: ['disaster', 'transport', 'aviation', 'maritime', 'infrastructure', 'economy', 'health', 'other'] },
  { id: 'news', label: 'News', types: ['news'] },
]);

const DEFAULTS = Object.freeze({
  enabled: false,
  provinceCode: null,
  mapMode: '3d',
  timelineHours: 72,
  timelineUntilMs: null,
  timelinePlaying: false,
  typeGroups: EVENT_TYPE_GROUPS.map((group) => group.id),
  selectedEventId: null,
});

function readStorage() {
  try {
    const raw = globalThis.localStorage?.getItem(INDONESIA_STATE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    if (typeof parsed.enabled === 'boolean') out.enabled = parsed.enabled;
    if (typeof parsed.provinceCode === 'string' && /^\d{2}$/.test(parsed.provinceCode)) out.provinceCode = parsed.provinceCode;
    if (Number.isFinite(parsed.timelineHours) && parsed.timelineHours > 0) out.timelineHours = Math.min(24 * 30, parsed.timelineHours);
    if (Array.isArray(parsed.typeGroups)) out.typeGroups = parsed.typeGroups.filter((id) => EVENT_TYPE_GROUPS.some((group) => group.id === id));
    return out;
  } catch {
    return {};
  }
}

function writeStorage(state) {
  try {
    globalThis.localStorage?.setItem(INDONESIA_STATE_STORAGE_KEY, JSON.stringify({
      enabled: state.enabled, provinceCode: state.provinceCode, timelineHours: state.timelineHours, typeGroups: state.typeGroups,
    }));
  } catch {
    // storage unavailable (private mode, quota) — state stays in memory
  }
}

export function createIndonesiaState({ persist = true } = {}) {
  let state = { ...DEFAULTS, ...(persist ? readStorage() : {}) };
  const listeners = new Set();
  return {
    get: () => state,
    /** Merge a patch; listeners receive (state, changedKeys). */
    set(patch) {
      const changed = [];
      const next = { ...state };
      for (const [key, value] of Object.entries(patch || {})) {
        if (!(key in DEFAULTS)) continue;
        const normalized = key === 'typeGroups' ? (Array.isArray(value) ? [...value] : state.typeGroups) : value;
        if (JSON.stringify(next[key]) === JSON.stringify(normalized)) continue;
        next[key] = normalized;
        changed.push(key);
      }
      if (!changed.length) return state;
      state = next;
      if (persist) writeStorage(state);
      for (const listener of listeners) {
        try { listener(state, changed); } catch (error) { console.warn('[indonesia-state] listener error:', error); }
      }
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset() {
      this.set({ ...DEFAULTS });
    },
  };
}

/** Event types currently selected by the group filter. */
export function selectedEventTypes(state) {
  const types = new Set();
  for (const group of EVENT_TYPE_GROUPS) {
    if (state.typeGroups.includes(group.id)) for (const type of group.types) types.add(type);
  }
  return types;
}

/** Timeline window as [sinceMs, untilMs] for `nowMs`. */
export function timelineWindow(state, nowMs = Date.now()) {
  const untilMs = Number.isFinite(state.timelineUntilMs) ? state.timelineUntilMs : nowMs;
  return [untilMs - state.timelineHours * 3_600_000, untilMs];
}

/**
 * Apply the shared filters (type groups, timeline, province) to a list of
 * normalized events. Forecast timestamps a few hours ahead of "now" are
 * kept so current weather stays on the map.
 */
export function filterEventsForView(events, state, { nowMs = Date.now(), locatedOnly = false, ignoreTypes = false } = {}) {
  const types = selectedEventTypes(state);
  const [sinceMs, untilMs] = timelineWindow(state, nowMs);
  const graceMs = 6 * 3_600_000;
  return (events || []).filter((event) => {
    if (!event) return false;
    if (locatedOnly && !event.location) return false;
    if (!ignoreTypes && !types.has(event.type)) return false;
    const ms = Date.parse(event.timestamp);
    if (Number.isNaN(ms) || ms < sinceMs || ms > untilMs + graceMs) return false;
    if (state.provinceCode && event.provinceCode !== state.provinceCode) return false;
    return true;
  });
}

export const indonesiaState = createIndonesiaState();
