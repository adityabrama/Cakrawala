/**
 * @module providers/provider
 *
 * The provider contract and the helpers every adapter shares. A provider is a
 * plain object:
 *
 *   {
 *     id, name, category, region,        // region: 'ID' | 'GLOBAL'
 *     auth: 'keyless' | 'free-key' | 'paid',
 *     envKey?,                           // env var that configures it
 *     intervalMs,                        // sweep cadence
 *     attribution, license, sourceUrl,
 *     isConfigured(env) → boolean,
 *     fetch(context) → { events, metrics, meta }
 *   }
 *
 * `fetch` receives { fetchImpl, signal, env, pack, cache, log, now } and must
 * return fewer events instead of throwing on malformed upstream rows.
 */

export const USER_AGENT = 'CAKRAWALA/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

export const PROVIDER_CATEGORIES = Object.freeze([
  'earthquake', 'volcano', 'disaster', 'weather', 'air-quality', 'fire', 'news',
  'economy', 'transport', 'aviation', 'maritime', 'infrastructure', 'boundaries',
]);

/** Validate and freeze a provider definition. */
export function defineProvider(spec) {
  for (const key of ['id', 'name', 'category', 'attribution', 'fetch']) {
    if (!spec?.[key]) throw new Error(`Provider is missing "${key}"`);
  }
  if (!/^[a-z0-9-]+$/.test(spec.id)) throw new Error(`Provider id must be kebab-case: ${spec.id}`);
  return Object.freeze({
    region: 'GLOBAL',
    auth: 'keyless',
    envKey: null,
    intervalMs: 15 * 60_000,
    // How long the engine keeps this provider's events after they were last
    // reported (default: the engine's 30-day retention). State-style feeds
    // (volcano levels, forecasts) set this short so stale rows drop out.
    retentionMs: null,
    maxEvents: null,
    license: '',
    sourceUrl: null,
    onDemand: false,
    isConfigured: spec.envKey ? (env) => Boolean(env?.[spec.envKey]) : () => true,
    ...spec,
  });
}

/** Sleep that resolves early (rejects) when the signal aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function combineSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`fetch timed out after ${timeoutMs} ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return { signal: controller.signal, release: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
}

/**
 * Fetch text with a User-Agent, timeout, and bounded retries. Throws on a
 * non-2xx response so the sweep records the failure.
 */
export async function fetchText(url, { fetchImpl = fetch, signal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, headers = {}, retries = 1, retryDelayMs = 1500, method = 'GET', body } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const combined = combineSignals(signal, timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method,
        body,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...headers },
        signal: combined.signal,
        redirect: 'follow',
      });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} from ${new URL(url).host}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
        error.status = response.status;
        throw error;
      }
      return { text, status: response.status, contentType: response.headers.get('content-type') || '' };
    } catch (error) {
      lastError = error;
      if (signal?.aborted || attempt === retries || error?.status === 404 || error?.status === 410 || error?.status === 429) break;
      await sleep(retryDelayMs * (attempt + 1), signal);
    } finally {
      combined.release();
    }
  }
  throw lastError;
}

/** Fetch and parse JSON; a body that is not JSON is an error. */
export async function fetchJson(url, options = {}) {
  const { text } = await fetchText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${new URL(url).host}: ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
  }
}

/** Number or null. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

/** Severity from an earthquake magnitude. */
export function severityFromMagnitude(magnitude) {
  const m = Number(magnitude);
  if (!Number.isFinite(m)) return 'info';
  if (m >= 7) return 'critical';
  if (m >= 6) return 'high';
  if (m >= 5) return 'medium';
  if (m >= 4) return 'low';
  return 'info';
}

/** Small stable hash for ids derived from URLs or text. */
export function shortHash(text) {
  let hash = 5381;
  const input = String(text ?? '');
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** Lower-case ASCII key for fuzzy name matching (strips "Gunung", punctuation). */
export function nameKey(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\b(gunung|gn\.?|mount|mt\.?|kota|kabupaten|kab\.?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Attach province/city to an event from the data pack: first by the regency
 * locator (exact polygon), then by name mention in `text`.
 */
export function attachAdministrative(event, pack, text = '') {
  if (!pack) return event;
  if (event.location && pack.locateRegency) {
    const hit = pack.locateRegency(event.location.lat, event.location.lon);
    if (hit) {
      event.city = hit.name;
      event.provinceCode = hit.code.slice(0, 2);
      event.province = pack.provinceName?.(event.provinceCode) || event.province || null;
      return event;
    }
  }
  if (text && pack.matchProvinceInText) {
    const match = pack.matchProvinceInText(text);
    if (match) {
      event.provinceCode = event.provinceCode || match.code;
      event.province = event.province || match.name;
    }
  }
  return event;
}
