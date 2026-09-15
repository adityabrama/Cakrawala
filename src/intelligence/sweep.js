/**
 * @module intelligence/sweep
 *
 * Runs every configured provider in parallel with an individual timeout and
 * reports per-source health. One failing or slow source never delays or
 * blocks the others; a source whose key is missing is reported as
 * `not-configured`, not as an error.
 */

import { createEvent, mergeEvents } from './eventSchema.js';

export const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000;

/** Health states a provider can be in after a sweep. */
export const PROVIDER_STATES = Object.freeze(['ok', 'error', 'timeout', 'not-configured', 'skipped']);

function timeoutError(id, ms) {
  const error = new Error(`Provider ${id} timed out after ${Math.round(ms / 1000)} s`);
  error.name = 'ProviderTimeoutError';
  return error;
}

/**
 * Run one provider under a timeout. Never throws.
 * @param {object} provider Provider module (see src/providers/provider.js).
 * @param {object} context Shared fetch context passed to `provider.fetch`.
 * @param {{timeoutMs?: number, now?: () => number}} [options]
 * @returns {Promise<object>} Health record with the normalized events.
 */
export async function runProvider(provider, context, { timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, now = Date.now } = {}) {
  const startedAt = now();
  const base = { id: provider.id, name: provider.name, category: provider.category, startedAt: new Date(startedAt).toISOString() };
  if (typeof provider.isConfigured === 'function' && !provider.isConfigured(context.env || {})) {
    return { ...base, state: 'not-configured', durationMs: 0, events: [], metrics: {}, meta: {}, error: null, envKey: provider.envKey || null };
  }
  const controller = new AbortController();
  let timer = null;
  try {
    const result = await Promise.race([
      provider.fetch({ ...context, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(timeoutError(provider.id, timeoutMs));
        }, timeoutMs);
      }),
    ]);
    const events = [];
    let dropped = 0;
    for (const candidate of Array.isArray(result?.events) ? result.events : []) {
      const event = candidate && candidate.attribution && candidate.timestamp && typeof candidate.severity === 'string' && candidate.raw
        ? createEvent(candidate)
        : createEvent({ attribution: provider.attribution, source: provider.id, ...candidate });
      if (event) events.push(event);
      else dropped += 1;
    }
    return {
      ...base,
      state: 'ok',
      durationMs: now() - startedAt,
      events,
      metrics: result?.metrics && typeof result.metrics === 'object' ? result.metrics : {},
      meta: { ...(result?.meta || {}), dropped },
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      state: error?.name === 'ProviderTimeoutError' ? 'timeout' : 'error',
      durationMs: now() - startedAt,
      events: [],
      metrics: {},
      meta: {},
      error: String(error?.message || error).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the providers that are due. `isDue(provider)` lets the engine keep each
 * provider on its own cadence; providers not due are reported as `skipped`
 * and contribute no events (the engine keeps their previous events).
 * @returns {Promise<{at: string, results: object[], events: object[], health: object[]}>}
 */
export async function runProviderSweep(providers, context, { timeoutMs, isDue = () => true, now = Date.now } = {}) {
  const at = new Date(now()).toISOString();
  const results = await Promise.all(providers.map(async (provider) => {
    if (!isDue(provider)) {
      return { id: provider.id, name: provider.name, category: provider.category, state: 'skipped', durationMs: 0, events: [], metrics: {}, meta: {}, error: null };
    }
    return runProvider(provider, context, { timeoutMs, now });
  }));
  const events = mergeEvents(...results.map((result) => result.events));
  const health = results.map(({ events: list, ...rest }) => ({ ...rest, eventCount: list.length }));
  return { at, results, events, health };
}

/** Summarize a health list into counts the UI and briefs can show. */
export function summarizeHealth(health) {
  const counts = { ok: 0, error: 0, timeout: 0, 'not-configured': 0, skipped: 0 };
  for (const entry of health || []) counts[entry.state] = (counts[entry.state] || 0) + 1;
  return { ...counts, total: (health || []).length };
}
