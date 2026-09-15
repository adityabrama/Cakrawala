/**
 * @module indonesia/intelClient
 *
 * Browser client for the intelligence engine (`/api/intel/*`). Every read
 * keeps its last good payload so the UI can keep showing data — labelled
 * stale — when the dev server or the network is down. Sweep notifications
 * arrive over SSE with automatic reconnect.
 */

const BASE = '/api/intel';
const SSE_RETRY_MS = 8_000;

function query(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function createIntelClient({ fetchImpl = (...args) => fetch(...args), eventSourceImpl = typeof EventSource === 'undefined' ? null : EventSource } = {}) {
  const cache = new Map();
  const sweepListeners = new Set();
  let source = null;
  let retryTimer = null;

  async function getJson(path, { cacheKey = path, method = 'GET', timeoutMs = 45_000 } = {}) {
    try {
      const response = await fetchImpl(`${BASE}${path}`, { method, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const record = { ...payload, stale: false, fetchedAt: Date.now() };
      if (method === 'GET') cache.set(cacheKey, record);
      return record;
    } catch (error) {
      const cached = cache.get(cacheKey);
      if (cached) return { ...cached, stale: true, staleReason: String(error.message || error) };
      throw error;
    }
  }

  function connect() {
    if (!eventSourceImpl || source) return;
    try {
      source = new eventSourceImpl(`${BASE}/stream`);
    } catch {
      source = null;
      return;
    }
    source.addEventListener('sweep', (message) => {
      let payload = {};
      try { payload = JSON.parse(message.data); } catch { /* ignore */ }
      for (const listener of sweepListeners) {
        try { listener(payload); } catch (error) { console.warn('[intel-client] sweep listener error:', error); }
      }
    });
    source.onerror = () => {
      source?.close();
      source = null;
      if (sweepListeners.size && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; connect(); }, SSE_RETRY_MS);
      }
    };
  }

  return {
    getStatus: () => getJson('/status'),
    getHealth: () => getJson('/health'),
    getEvents: (params = {}) => getJson(`/events${query(params)}`),
    getEvent: (id) => getJson(`/events/${encodeURIComponent(id)}`),
    getAlerts: (params = {}) => getJson(`/alerts${query(params)}`),
    getBrief: (params = {}) => getJson(`/brief${query(params)}`),
    getWeather: (params = {}) => getJson(`/weather${query(params)}`),
    getEconomy: () => getJson('/economy'),
    getMetrics: () => getJson('/metrics'),
    getClusters: (params = {}) => getJson(`/clusters${query(params)}`),
    getPack: () => getJson('/pack'),
    getBoundaries: (kind) => getJson(`/boundaries/${kind}`, { timeoutMs: 90_000 }),
    triggerSweep: () => getJson('/sweep?force=1', { method: 'POST', cacheKey: '/sweep' }),
    /** Subscribe to sweep completions (SSE). Returns an unsubscribe function. */
    subscribeSweeps(listener) {
      sweepListeners.add(listener);
      connect();
      return () => {
        sweepListeners.delete(listener);
        if (!sweepListeners.size) {
          source?.close();
          source = null;
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      };
    },
    cached: (path) => cache.get(path) || null,
  };
}

export const intelClient = createIntelClient();
