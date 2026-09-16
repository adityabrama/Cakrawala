/**
 * @module server/intelligence/vitePlugin
 *
 * Vite dev/preview plugin that hosts the intelligence engine and serves
 * `/api/intel/*`. One plugin, one engine, started when the server listens.
 * Responses never include environment values — only whether a provider is
 * configured.
 *
 *   GET  /api/intel/status                 engine + provider health
 *   GET  /api/intel/events?…               normalized events (see query params below)
 *   GET  /api/intel/events/:id             one event with related signals
 *   GET  /api/intel/alerts?scope&level     active alerts
 *   GET  /api/intel/brief?scope            Indonesia / province brief
 *   GET  /api/intel/weather?city|lat,lon   BMKG forecast (bundled cities) or Open-Meteo
 *   GET  /api/intel/metrics                latest provider metrics
 *   GET  /api/intel/economy                World Bank series + IDR rates
 *   GET  /api/intel/clusters?type          spatial clusters
 *   GET  /api/intel/boundaries/{provinces|regencies}
 *   GET  /api/intel/pack                   provinces, cities, airports, weather points, volcanoes
 *   GET  /api/intel/stream                 SSE: sweep summaries
 *   POST /api/intel/sweep                  manual sweep (rate limited)
 */

import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createIntelEngine, parseScope } from '../../src/intelligence/server.js';
import { createIntelMemory } from './memory.js';
import { SWEEP_PROVIDERS, ON_DEMAND_PROVIDERS, describeProviders } from '../../src/providers/index.js';
import { loadIndonesiaPack } from './pack.js';

const JSON_HEADERS = Object.freeze({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
const MAX_LIMIT = 2000;

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...extraHeaders });
  res.end(JSON.stringify(payload));
}

function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const nowMs = Date.now();
    const list = (hits.get(key) || []).filter((at) => nowMs - at < windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(nowMs);
    hits.set(key, list);
    return true;
  };
}

function clientKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
}

/** Parse /events query params into an engine filter (all optional, all validated). */
export function parseEventQuery(searchParams) {
  const filter = {};
  const types = String(searchParams.get('types') || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (types.length) filter.types = types;
  const exclude = String(searchParams.get('exclude') || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (exclude.length) filter.excludeTypes = exclude;
  const statuses = String(searchParams.get('status') || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (statuses.length) filter.statuses = statuses;
  const since = Date.parse(searchParams.get('since') || '');
  if (!Number.isNaN(since)) filter.sinceMs = since;
  const until = Date.parse(searchParams.get('until') || '');
  if (!Number.isNaN(until)) filter.untilMs = until;
  const hours = Number(searchParams.get('hours'));
  if (Number.isFinite(hours) && hours > 0 && filter.sinceMs === undefined) filter.sinceMs = Date.now() - Math.min(hours, 24 * 365) * 3_600_000;
  const severity = String(searchParams.get('severity') || '').toLowerCase();
  if (['info', 'low', 'medium', 'high', 'critical'].includes(severity)) filter.minSeverity = severity;
  const province = String(searchParams.get('province') || '').trim();
  if (/^\d{2}$/.test(province)) filter.scope = `province:${province}`;
  const bbox = String(searchParams.get('bbox') || '').split(',').map(Number);
  if (bbox.length === 4 && bbox.every(Number.isFinite) && !filter.scope) filter.scope = `bbox:${bbox.join(',')}`;
  if (!filter.scope && searchParams.get('scope')) filter.scope = searchParams.get('scope');
  const limit = Number(searchParams.get('limit'));
  filter.limit = Number.isFinite(limit) && limit > 0 ? Math.min(MAX_LIMIT, Math.floor(limit)) : 500;
  return filter;
}

/**
 * @param {object} [options]
 * @param {string} [options.memoryDir] Where hot/cold sweep memory lives (default .gev-intel).
 * @param {boolean} [options.autoStart] Start sweeping when the server starts (default true; GEV_INTEL_ENABLED=false disables).
 */
export function intelligenceProxy({ memoryDir = join(process.cwd(), '.gev-intel'), autoStart = process.env.GEV_INTEL_ENABLED !== 'false' } = {}) {
  let engine = null;
  let pack = null;
  const boundaryCache = new Map();
  const weatherCache = new Map();
  const sweepLimiter = makeLimiter({ windowMs: 60_000, max: 2 });
  const weatherLimiter = makeLimiter({ windowMs: 60_000, max: 30 });
  const sseClients = new Set();

  function ensureEngine() {
    if (engine) return engine;
    pack = loadIndonesiaPack();
    let memory = null;
    try {
      memory = createIntelMemory(memoryDir, { log: console });
    } catch (error) {
      console.warn(`[intel] memory disabled: ${error.message}`);
    }
    engine = createIntelEngine({
      providers: SWEEP_PROVIDERS,
      onDemand: ON_DEMAND_PROVIDERS,
      env: process.env,
      pack,
      memory,
      log: console,
    });
    engine.subscribe((message) => {
      const payload = `event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`;
      for (const client of sseClients) {
        try { client.write(payload); } catch { sseClients.delete(client); }
      }
    });
    return engine;
  }

  function boundaries(kind) {
    if (boundaryCache.has(kind)) return boundaryCache.get(kind);
    const collection = kind === 'provinces' ? pack?.boundaries?.provinces : kind === 'regencies' ? pack?.boundaries?.regencies : null;
    if (!collection) { boundaryCache.set(kind, null); return null; }
    const raw = Buffer.from(JSON.stringify(collection));
    const entry = { raw, gzip: gzipSync(raw), etag: `"${kind}-${raw.length}"` };
    boundaryCache.set(kind, entry);
    return entry;
  }

  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname.replace(/^\/api\/intel/, '') || '/';
    const eng = ensureEngine();

    if (req.method === 'POST' && path === '/sweep') {
      if (!sweepLimiter(clientKey(req))) return sendJson(res, 429, { error: 'Manual sweeps are limited to 2 per minute' }, { 'Retry-After': '30' });
      const summary = await eng.sweep({ force: url.searchParams.get('force') === '1' });
      return sendJson(res, 200, summary);
    }
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method Not Allowed' });

    if (path === '/' || path === '/status') {
      return sendJson(res, 200, { ...eng.getStatus(), providers: describeProviders(process.env), pack: { provinces: pack.provinces.length, regencies: pack.regencies.length, volcanoes: pack.volcanoes.length, airports: pack.airports.length, weatherPoints: pack.weatherPoints.length, boundaries: { provinces: Boolean(pack.boundaries.provinces), regencies: Boolean(pack.boundaries.regencies) } } });
    }
    if (path === '/health') {
      const status = eng.getStatus();
      const level = (ok, degraded) => (ok ? 'ONLINE' : degraded ? 'DEGRADED' : 'OFFLINE');
      return sendJson(res, 200, {
        engine: level(Boolean(status.lastSweepAt), Boolean(status.startedAt)),
        providers: level(status.summary.failing === 0 && status.summary.ok > 0, status.summary.ok > 0),
        indonesiaPack: pack.provinces.length === 38 && pack.boundaries.regencies ? 'ONLINE' : pack.provinces.length ? 'DEGRADED' : 'NOT CONFIGURED',
        memory: engine ? 'ONLINE' : 'OFFLINE',
        detail: status.summary,
      });
    }
    if (path === '/events') {
      const filter = parseEventQuery(url.searchParams);
      const events = eng.getEvents(filter);
      return sendJson(res, 200, { count: events.length, filter, generatedAt: new Date().toISOString(), events });
    }
    const eventMatch = /^\/events\/(.+)$/.exec(path);
    if (eventMatch) {
      const event = eng.getEvent(decodeURIComponent(eventMatch[1]));
      return event ? sendJson(res, 200, event) : sendJson(res, 404, { error: 'Event not found' });
    }
    if (path === '/alerts') {
      const alerts = eng.getAlerts({ scope: url.searchParams.get('scope') || 'indonesia', minLevel: (url.searchParams.get('level') || 'INFO').toUpperCase(), activeOnly: url.searchParams.get('all') !== '1' });
      return sendJson(res, 200, { count: alerts.length, generatedAt: new Date().toISOString(), alerts });
    }
    if (path === '/brief') {
      const hours = Number(url.searchParams.get('hours'));
      return sendJson(res, 200, eng.getBrief({ scope: url.searchParams.get('scope') || 'indonesia', windowMs: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) * 3_600_000 : undefined }));
    }
    if (path === '/metrics') return sendJson(res, 200, { generatedAt: new Date().toISOString(), metrics: eng.getMetrics() });
    if (path === '/delta') return sendJson(res, 200, eng.getDelta() || { summary: null });
    if (path === '/clusters') return sendJson(res, 200, { clusters: eng.getClusters({ type: url.searchParams.get('type') || null }) });
    if (path === '/economy') {
      return sendJson(res, 200, {
        worldBank: eng.getProviderMeta('world-bank-indonesia')?.indicators || null,
        rates: eng.getProviderMeta('frankfurter-idr')?.rates || null,
        health: eng.getHealth().filter((entry) => entry.category === 'economy'),
      });
    }
    if (path === '/pack') {
      return sendJson(res, 200, { provinces: pack.provinces, cities: pack.cities, weatherPoints: pack.weatherPoints, airports: pack.airports, volcanoes: pack.volcanoes.map(({ id, name, lat, lon, elevationM }) => ({ id, name, lat, lon, elevationM })) }, { 'Cache-Control': 'public, max-age=3600' });
    }
    const boundaryMatch = /^\/boundaries\/(provinces|regencies)$/.exec(path);
    if (boundaryMatch) {
      const entry = boundaries(boundaryMatch[1]);
      if (!entry) return sendJson(res, 404, { error: `Boundary set ${boundaryMatch[1]} is not bundled; run scripts/build-indonesia-pack.mjs` });
      if (req.headers['if-none-match'] === entry.etag) { res.writeHead(304); return res.end(); }
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      res.writeHead(200, { 'Content-Type': 'application/geo+json', 'Cache-Control': 'public, max-age=86400', ETag: entry.etag, ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gzip ? entry.gzip : entry.raw);
    }
    if (path === '/weather') {
      if (!weatherLimiter(clientKey(req))) return sendJson(res, 429, { error: 'Weather lookups are limited to 30 per minute' }, { 'Retry-After': '10' });
      const city = String(url.searchParams.get('city') || '').trim();
      if (city) {
        const forecasts = eng.getProviderMeta('bmkg-weather')?.forecasts || {};
        const forecast = forecasts[city];
        if (forecast) return sendJson(res, 200, { source: 'bmkg-weather', status: 'modeled', attribution: 'Prakiraan cuaca: BMKG', forecast });
        const point = pack.weatherPointById(city);
        if (!point) return sendJson(res, 404, { error: 'Unknown weather city' });
        return sendJson(res, 503, { error: 'BMKG forecast not loaded yet for this city', city: point });
      }
      const lat = Number(url.searchParams.get('lat'));
      const lon = Number(url.searchParams.get('lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return sendJson(res, 400, { error: 'lat and lon are required' });
      const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
      const cached = weatherCache.get(key);
      if (cached && Date.now() - cached.at < 10 * 60_000) return sendJson(res, 200, { ...cached.payload, cached: true });
      const payload = { source: 'open-meteo', ...(await eng.queryPoint({ lat, lon })) };
      weatherCache.set(key, { at: Date.now(), payload });
      if (weatherCache.size > 500) weatherCache.delete(weatherCache.keys().next().value);
      return sendJson(res, 200, payload);
    }
    if (path === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify({ lastSweepAt: eng.getStatus().lastSweepAt, eventCount: eng.getStatus().eventCount })}\n\n`);
      sseClients.add(res);
      const keepAlive = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch { /* closed */ } }, 25_000);
      req.on('close', () => { clearInterval(keepAlive); sseClients.delete(res); });
      return undefined;
    }
    return sendJson(res, 404, { error: 'Unknown intelligence endpoint' });
  }

  function install(middlewares) {
    middlewares.use('/api/intel', (req, res) => {
      handle(req, res).catch((error) => {
        console.warn(`[intel] ${req.method} ${req.url}: ${error.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: 'Intelligence engine error' });
        else res.end();
      });
    });
  }

  return {
    name: 'intelligence-proxy',
    configureServer(server) {
      install(server.middlewares);
      if (autoStart) {
        const start = () => ensureEngine().start({ firstSweepDelayMs: 4000 });
        if (server.httpServer) server.httpServer.once('listening', start);
        else start();
      }
    },
    configurePreviewServer(server) {
      install(server.middlewares);
      if (autoStart) ensureEngine().start({ firstSweepDelayMs: 4000 });
    },
    // Test seam: the engine and pack the plugin is using.
    _debug: { engine: () => engine, pack: () => pack, parseScope },
  };
}

export default intelligenceProxy;
