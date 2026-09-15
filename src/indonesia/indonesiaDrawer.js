/**
 * @module indonesia/indonesiaDrawer
 *
 * The 🇮🇩 INDONESIA COMMAND CENTER: a right-edge drawer that hosts the Alert
 * Center, the Disaster Center event feed with type filters, weather
 * (BMKG city forecasts + Open-Meteo at any point), the Indonesia / province
 * brief, economic indicators, and provider health. It also owns the timeline
 * (window + playback) and the 3D ↔ GIS switch.
 *
 * Everything here is additive: the drawer lives in its own DOM subtree and
 * only talks to the rest of the app through the data manager, the shared
 * Indonesia state, and window events.
 */

import { intelClient } from './intelClient.js';
import { EVENT_TYPE_GROUPS, TIMELINE_PRESETS, filterEventsForView, indonesiaState, timelineWindow } from './indonesiaState.js';
import { flyToIndonesia, flyToPoint, flyToProvince, heightForEventType, viewCenter } from './indonesiaCamera.js';
import { EVENT_TYPE_COLORS } from '../data/intelEvents.js';
import { INDONESIA_BBOX, bboxContains } from '../intelligence/geo.js';
import { createGisMap } from '../gis/gisMap.js';
import { createGisPanel } from '../gis/gisPanel.js';
import { createMapModeController } from '../gis/mapModeController.js';

const TABS = Object.freeze([
  ['alerts', 'ALERTS'], ['events', 'EVENTS'], ['weather', 'WEATHER'], ['brief', 'BRIEF'], ['economy', 'ECONOMY'], ['sources', 'SOURCES'],
]);
const LEVEL_CLASS = Object.freeze({ CRITICAL: 'crit', HIGH: 'high', MEDIUM: 'med', LOW: 'low', INFO: 'info' });
const FETCH_HOURS = 24 * 30;

function h(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

export function timeAgo(iso, nowMs = Date.now()) {
  const ms = Date.parse(iso || '');
  if (Number.isNaN(ms)) return '—';
  const diff = nowMs - ms;
  if (diff < -60_000) return `in ${Math.round(-diff / 60_000)} min`;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function statusLabel(status) {
  return { live: 'LIVE', delayed: 'DELAYED', modeled: 'MODELED', estimated: 'ESTIMATED', historical: 'HISTORICAL' }[status] || String(status || '').toUpperCase();
}

function sparkline(series, { width = 120, height = 28 } = {}) {
  const values = (series || []).map((row) => row.value).filter(Number.isFinite);
  if (values.length < 2) return h('span', { class: 'idn-spark-empty', text: '—' });
  const min = Math.min(...values);
  const max = Math.max(...values);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * width},${height - ((value - min) / (max - min || 1)) * (height - 4) - 2}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'idn-spark');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points);
  svg.append(line);
  return svg;
}

function formatNumber(value, unit) {
  if (!Number.isFinite(value)) return '—';
  if (unit === 'USD' && Math.abs(value) >= 1e9) return `US$ ${(value / 1e9).toFixed(0)} bn`;
  if (unit === 'people') return value.toLocaleString('en-US');
  if (unit === '%') return `${value.toFixed(2)} %`;
  if (unit === 'IDR') return `Rp ${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * @param {object} options
 * @param {import('cesium').Viewer} options.viewer
 * @param {object} options.dataManager DataLayerManager (for enabling the event layers).
 */
export function initIndonesiaCommandCenter({ viewer, dataManager }) {
  const root = document.getElementById('indonesia-drawer');
  const navButton = document.getElementById('indonesia-drawer-btn');
  const modeButton = document.getElementById('map-mode-btn');
  const gisRoot = document.getElementById('gis-root');
  if (!root) return null;
  const state = indonesiaState;

  let activeTab = 'alerts';
  let status = null;
  let alerts = [];
  let events = [];
  let eventsStale = false;
  let pack = null;
  let boundaries = null;
  let selected = null;
  let playbackTimer = null;
  let gisMap = null;
  let gisPanel = null;
  let mapMode = null;

  const eventsLayer = () => dataManager?.layers?.get('id-events')?.module || null;
  const newsLayer = () => dataManager?.layers?.get('id-news')?.module || null;

  // ── DOM ───────────────────────────────────────────────────────────────
  const statusLine = h('div', { class: 'idn-status', text: 'Connecting to the intelligence engine…' });
  const modeSwitch = h('input', { type: 'checkbox', class: 'idn-switch-input', 'aria-label': 'Indonesia mode' });
  const provinceSelect = h('select', { class: 'idn-select', 'aria-label': 'Province' }, [h('option', { value: '', text: 'All Indonesia' })]);
  const view3dBtn = h('button', { type: 'button', class: 'idn-seg-btn active', text: '3D GLOBE', 'aria-pressed': 'true' });
  const viewGisBtn = h('button', { type: 'button', class: 'idn-seg-btn', text: 'GIS MAP', 'aria-pressed': 'false' });
  const sweepBtn = h('button', { type: 'button', class: 'idn-btn', text: 'SWEEP NOW', title: 'Run an intelligence sweep now (limited to 2 per minute)' });
  const playBtn = h('button', { type: 'button', class: 'idn-btn idn-btn-icon', text: '▶', 'aria-label': 'Play timeline' });
  const cursorLabel = h('span', { class: 'idn-cursor', text: '' });
  const rangeInput = h('input', { type: 'range', min: '0', max: '100', value: '100', class: 'idn-range', 'aria-label': 'Timeline cursor' });
  const presetChips = TIMELINE_PRESETS.map((preset) => h('button', { type: 'button', class: 'idn-chip', 'data-hours': preset.hours, text: preset.label }));
  const typeChips = EVENT_TYPE_GROUPS.map((group) => h('button', { type: 'button', class: 'idn-chip idn-chip-type', 'data-group': group.id, text: group.label, style: `--chip-color:${EVENT_TYPE_COLORS[group.types[0]] || '#ddd'}` }));
  const detail = h('div', { class: 'idn-detail', hidden: true });
  const body = h('div', { class: 'idn-body' });
  const tabBar = h('nav', { class: 'idn-tabs', 'aria-label': 'Indonesia command center sections' }, TABS.map(([id, label]) => h('button', { type: 'button', class: `idn-tab${id === activeTab ? ' active' : ''}`, 'data-tab': id, text: label, role: 'tab', 'aria-selected': id === activeTab ? 'true' : 'false' })));
  const alertBadge = h('span', { class: 'idn-nav-badge', hidden: true });

  root.replaceChildren(
    h('div', { class: 'idn-head' }, [
      h('div', { class: 'idn-brand' }, [
        h('span', { class: 'idn-flag', 'aria-hidden': 'true' }, [h('i'), h('i')]),
        h('div', {}, [h('div', { class: 'idn-title', text: 'INDONESIA COMMAND CENTER' }), statusLine]),
      ]),
      h('button', { type: 'button', class: 'idn-close', 'aria-label': 'Close Indonesia command center', text: '×', onclick: () => close() }),
    ]),
    h('div', { class: 'idn-controls' }, [
      h('label', { class: 'idn-switch' }, [modeSwitch, h('span', { class: 'idn-switch-track' }), h('span', { class: 'idn-switch-label', text: 'INDONESIA MODE' })]),
      provinceSelect,
      h('div', { class: 'idn-seg', role: 'group', 'aria-label': 'Map mode' }, [view3dBtn, viewGisBtn]),
      sweepBtn,
    ]),
    h('div', { class: 'idn-timeline' }, [
      h('div', { class: 'idn-timeline-row' }, [h('span', { class: 'idn-label', text: 'WINDOW' }), ...presetChips, playBtn]),
      h('div', { class: 'idn-timeline-row' }, [rangeInput, cursorLabel]),
    ]),
    detail,
    tabBar,
    body,
  );
  if (navButton) navButton.append(alertBadge);

  // ── helpers ────────────────────────────────────────────────────────────
  const currentScope = () => (state.get().provinceCode ? `province:${state.get().provinceCode}` : 'indonesia');
  const provinceOf = (code) => pack?.provinces?.find((entry) => entry.code === code) || null;
  const filteredEvents = () => filterEventsForView(events, state.get());

  function syncControls() {
    const current = state.get();
    modeSwitch.checked = current.enabled;
    provinceSelect.value = current.provinceCode || '';
    for (const chip of presetChips) chip.classList.toggle('active', Number(chip.dataset.hours) === current.timelineHours);
    for (const chip of typeChips) chip.classList.toggle('active', current.typeGroups.includes(chip.dataset.group));
    const gis = current.mapMode === 'gis';
    view3dBtn.classList.toggle('active', !gis);
    viewGisBtn.classList.toggle('active', gis);
    view3dBtn.setAttribute('aria-pressed', String(!gis));
    viewGisBtn.setAttribute('aria-pressed', String(gis));
    if (modeButton) {
      modeButton.classList.toggle('active', gis);
      modeButton.setAttribute('aria-pressed', String(gis));
      modeButton.querySelector('.idn-nav-label').textContent = gis ? '3D' : 'GIS';
      modeButton.title = gis ? 'Back to the 3D globe' : 'Switch to the 2D GIS map (boundaries, spatial analysis)';
    }
    const [sinceMs, untilMs] = timelineWindow(current);
    const isNow = !Number.isFinite(current.timelineUntilMs);
    rangeInput.value = isNow ? '100' : String(Math.round(((untilMs - (Date.now() - current.timelineHours * 3_600_000)) / (current.timelineHours * 3_600_000)) * 100));
    cursorLabel.textContent = `${new Date(sinceMs).toLocaleString()} → ${isNow ? 'now' : new Date(untilMs).toLocaleString()}`;
    playBtn.textContent = current.timelinePlaying ? '❚❚' : '▶';
  }

  function renderStatus() {
    if (!status) return;
    const summary = status.summary || {};
    const total = (status.health || []).length;
    const parts = [
      status.lastSweepAt ? `Last sweep ${timeAgo(status.lastSweepAt)}` : 'First sweep pending',
      `${summary.ok ?? 0}/${total} sources`,
      `${status.eventCount ?? 0} events`,
      `${status.activeAlerts ?? 0} alerts`,
      status.stale ? 'OFFLINE · showing cached data' : null,
    ].filter(Boolean);
    statusLine.textContent = parts.join(' · ');
    statusLine.classList.toggle('stale', Boolean(status.stale));
    const count = alerts.filter((alert) => alert.level !== 'INFO').length;
    alertBadge.textContent = String(count);
    alertBadge.hidden = count === 0;
    alertBadge.className = `idn-nav-badge ${alerts.some((alert) => alert.level === 'CRITICAL') ? 'crit' : alerts.some((alert) => alert.level === 'HIGH') ? 'high' : ''}`;
  }

  function eventRow(event, { showDistance = false } = {}) {
    const color = EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.other;
    return h('button', { type: 'button', class: `idn-event${selected?.id === event.id ? ' selected' : ''}`, onclick: () => selectEvent(event, { fly: true }) }, [
      h('span', { class: `idn-dot sev-${event.severity}`, style: `--dot-color:${color}` }),
      h('span', { class: 'idn-event-main' }, [
        h('span', { class: 'idn-event-title', text: event.title }),
        h('span', { class: 'idn-event-meta', text: [
          event.type.toUpperCase(), event.province || event.city || null, timeAgo(event.timestamp), statusLabel(event.status), event.source,
          showDistance && Number.isFinite(event.distanceKm) ? `${event.distanceKm.toFixed(0)} km` : null,
        ].filter(Boolean).join(' · ') }),
      ]),
    ]);
  }

  function renderDetail() {
    if (!selected) { detail.hidden = true; detail.replaceChildren(); return; }
    const event = selected;
    const color = EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.other;
    detail.hidden = false;
    detail.replaceChildren(
      h('div', { class: 'idn-detail-head' }, [
        h('span', { class: `idn-dot sev-${event.severity}`, style: `--dot-color:${color}` }),
        h('span', { class: 'idn-detail-title', text: event.title }),
        h('button', { type: 'button', class: 'idn-close idn-close-sm', 'aria-label': 'Clear selection', text: '×', onclick: () => selectEvent(null) }),
      ]),
      h('div', { class: 'idn-detail-meta', text: [
        `${event.severity.toUpperCase()} · ${statusLabel(event.status)} · confidence ${Math.round((event.confidence ?? 0) * 100)}%`,
        `${new Date(event.timestamp).toLocaleString()} (${timeAgo(event.timestamp)})`,
        event.location ? `${event.location.lat.toFixed(3)}, ${event.location.lon.toFixed(3)}${Number.isFinite(event.location.depthKm) ? ` · depth ${event.location.depthKm} km` : ''}` : 'No coordinates (location not resolved)',
        [event.city, event.province].filter(Boolean).join(', ') || null,
      ].filter(Boolean).join('\n') }),
      event.description ? h('div', { class: 'idn-detail-desc', text: event.description }) : null,
      h('div', { class: 'idn-detail-source' }, [
        h('span', { text: `Source: ${event.attribution}` }),
        event.sourceUrl ? h('a', { href: event.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: 'open source ↗' }) : null,
      ]),
      h('div', { class: 'idn-related', text: 'Related signals: loading…' }),
    );
    intelClient.getEvent(event.id).then((full) => {
      const related = detail.querySelector('.idn-related');
      if (!related || selected?.id !== event.id) return;
      const rows = full?.related || [];
      related.replaceChildren(
        h('div', { class: 'idn-related-title', text: rows.length ? `Related signals (${rows.length}) — correlated, not confirmed causes` : 'No related signals within 100 km / 48 h' }),
        ...rows.slice(0, 5).map((row) => h('button', { type: 'button', class: 'idn-related-row', onclick: () => { const target = events.find((entry) => entry.id === row.eventId); if (target) selectEvent(target, { fly: true }); }, text: `${row.type} · ${row.title} · ${row.distanceKm} km · ${row.gapHours} h · ${row.relation}` })),
      );
    }).catch(() => {});
  }

  function renderAlerts() {
    const list = alerts.slice(0, 80);
    body.replaceChildren(
      h('div', { class: 'idn-section-title', text: `${state.get().provinceCode ? provinceOf(state.get().provinceCode)?.name || 'Province' : 'Indonesia'} ALERT CENTER · ${list.length} active` }),
      list.length ? h('div', { class: 'idn-list' }, list.map((alert) => h('button', { type: 'button', class: 'idn-alert', onclick: () => { const target = events.find((entry) => entry.id === alert.eventIds?.[0]); if (target) selectEvent(target, { fly: true }); } }, [
        h('span', { class: `idn-level ${LEVEL_CLASS[alert.level] || 'info'}`, text: alert.level }),
        h('span', { class: 'idn-alert-main' }, [
          h('span', { class: 'idn-event-title', text: alert.title }),
          h('span', { class: 'idn-event-meta', text: `${alert.reason} · ${alert.province || ''}` }),
          h('span', { class: 'idn-event-meta', text: `${alert.source} · ${timeAgo(alert.timestamp)} · confidence ${Math.round(alert.confidence * 100)}% · rule ${alert.rule}` }),
        ]),
      ]))) : h('div', { class: 'idn-empty', text: status?.lastSweepAt ? 'No active alerts for this scope. Alerts are rule-based: tsunami potential, M5+, volcano Level III/IV, BNPB casualty reports, severe forecasts, escalations.' : 'Waiting for the first sweep…' }),
    );
  }

  function renderEvents() {
    // Severity first, then recency: a forecast slot a few hours ahead must not
    // sit above a felt earthquake from an hour ago.
    const rank = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    const list = filteredEvents()
      .sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0) || Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 250);
    body.replaceChildren(
      h('div', { class: 'idn-chip-row' }, typeChips),
      h('div', { class: 'idn-section-title', text: `DISASTER CENTER · ${list.length} events in window${eventsStale ? ' · CACHED' : ''}` }),
      list.length ? h('div', { class: 'idn-list' }, list.map((event) => eventRow(event))) : h('div', { class: 'idn-empty', text: 'No events match the current filters, window, and province.' }),
    );
    syncControls();
  }

  let weatherCity = '';
  function renderWeather() {
    const citySelect = h('select', { class: 'idn-select', 'aria-label': 'BMKG forecast city' }, [h('option', { value: '', text: 'Choose a BMKG city…' }), ...(pack?.weatherPoints || []).map((point) => h('option', { value: point.id, text: `${point.name} — ${point.regency}` }))]);
    citySelect.value = weatherCity;
    const output = h('div', { class: 'idn-weather' });
    const show = (lines, note) => output.replaceChildren(...lines.map((line) => h('div', { class: 'idn-weather-line', text: line })), note ? h('div', { class: 'idn-note', text: note }) : null);
    const loadCity = async () => {
      if (!citySelect.value) return;
      weatherCity = citySelect.value;
      show(['Loading BMKG forecast…']);
      try {
        const payload = await intelClient.getWeather({ city: weatherCity });
        const forecast = payload.forecast;
        if (!forecast) { show([payload.error || 'Forecast unavailable']); return; }
        show([
          `${forecast.name} (${forecast.regency}) · ${forecast.current.condition} · ${forecast.current.tempC}°C · humidity ${forecast.current.humidityPct}% · wind ${forecast.current.windKmh} km/h ${forecast.current.windDir || ''}`,
          forecast.severe ? `⚠ ${forecast.severe} expected within 24 h` : 'No severe weather in the next 24 h',
          ...forecast.next24h.slice(0, 8).map((slot) => `${new Date(slot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ${String(slot.condition || '').padEnd(16)} ${slot.tempC}°C  ${slot.precipMm ?? 0} mm  ${slot.windKmh} km/h`),
        ], `BMKG 3-hourly forecast (adm4 ${forecast.adm4}) · ${statusLabel(forecast.status)} · analysis ${forecast.analysisDate || '—'} · ${payload.stale ? 'CACHED' : 'fetched ' + timeAgo(new Date(payload.fetchedAt).toISOString())}`);
      } catch (error) {
        show([`BMKG forecast unavailable: ${error.message}`]);
      }
    };
    citySelect.addEventListener('change', loadCity);
    const centreBtn = h('button', { type: 'button', class: 'idn-btn', text: 'WEATHER AT MAP CENTRE', onclick: async () => {
      const center = state.get().mapMode === 'gis' && gisMap?.getView() ? gisMap.getView() : viewCenter(viewer);
      show([`Loading Open-Meteo for ${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}…`]);
      try {
        const payload = await intelClient.getWeather({ lat: center.lat.toFixed(3), lon: center.lon.toFixed(3) });
        const weather = payload['open-meteo']?.weather;
        const air = payload['open-meteo']?.airQuality;
        if (!weather) { show([payload['open-meteo']?.error || 'Unavailable']); return; }
        show([
          `${weather.current.condition || '—'} · ${weather.current.tempC}°C · humidity ${weather.current.humidityPct}% · wind ${weather.current.windKmh} km/h · rain ${weather.current.precipMm} mm`,
          air ? `Air quality (modeled, CAMS): PM2.5 ${air.pm25} µg/m³ · PM10 ${air.pm10} · US AQI ${air.usAqi}` : 'Air quality unavailable',
          ...weather.next24h.filter((_, index) => index % 3 === 0).slice(0, 8).map((slot) => `${new Date(slot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ${String(slot.condition || '').padEnd(16)} ${slot.tempC}°C  ${slot.precipMm ?? 0} mm`),
        ], `${weather.attribution} · ${statusLabel(weather.status)} · observed ${timeAgo(weather.observedAt)}`);
      } catch (error) {
        show([`Open-Meteo unavailable: ${error.message}`]);
      }
    } });
    body.replaceChildren(
      h('div', { class: 'idn-section-title', text: 'WEATHER · BMKG (official forecast) · Open-Meteo (any point)' }),
      h('div', { class: 'idn-row' }, [citySelect]),
      h('div', { class: 'idn-row' }, [centreBtn]),
      output,
    );
    if (weatherCity) loadCity();
  }

  function renderBrief() {
    const output = h('pre', { class: 'idn-brief', text: 'Choose a brief. Every line names its source and timestamp; nothing is generated beyond the data the engine holds.' });
    const run = async (scope, label) => {
      output.textContent = `Building ${label} brief…`;
      try {
        const brief = await intelClient.getBrief({ scope, hours: Math.max(24, Math.min(720, state.get().timelineHours)) });
        output.textContent = brief.text || 'Empty brief';
      } catch (error) {
        output.textContent = `Brief unavailable: ${error.message}`;
      }
    };
    const provinceCode = state.get().provinceCode;
    body.replaceChildren(
      h('div', { class: 'idn-section-title', text: 'BRIEF · rule-based, source-stamped' }),
      h('div', { class: 'idn-row idn-row-wrap' }, [
        h('button', { type: 'button', class: 'idn-btn', text: 'INDONESIA BRIEF', onclick: () => run('indonesia', 'Indonesia') }),
        provinceCode ? h('button', { type: 'button', class: 'idn-btn', text: `${(provinceOf(provinceCode)?.name || 'PROVINCE').toUpperCase()} BRIEF`, onclick: () => run(`province:${provinceCode}`, provinceOf(provinceCode)?.name || 'province') }) : null,
        h('button', { type: 'button', class: 'idn-btn idn-btn-ghost', text: 'COPY', onclick: () => navigator.clipboard?.writeText(output.textContent).catch(() => {}) }),
      ]),
      output,
    );
  }

  async function renderEconomy() {
    body.replaceChildren(h('div', { class: 'idn-section-title', text: 'ECONOMY · World Bank (annual) · ECB reference rates' }), h('div', { class: 'idn-empty', text: 'Loading…' }));
    try {
      const economy = await intelClient.getEconomy();
      const rows = Object.values(economy.worldBank || {}).map((indicator) => h('div', { class: 'idn-econ-row' }, [
        h('span', { class: 'idn-econ-label', text: indicator.label }),
        h('span', { class: 'idn-econ-value', text: indicator.latest ? `${formatNumber(indicator.latest.value, indicator.unit)} (${indicator.latest.year})` : '—' }),
        sparkline(indicator.series),
      ]));
      const rates = Object.values(economy.rates || {}).map((rate) => h('div', { class: 'idn-econ-row' }, [
        h('span', { class: 'idn-econ-label', text: `IDR per ${rate.base}` }),
        h('span', { class: 'idn-econ-value', text: `${formatNumber(rate.idr, 'IDR')} · ${rate.date}` }),
        h('span', { class: 'idn-spark-empty', text: 'DELAYED' }),
      ]));
      body.replaceChildren(
        h('div', { class: 'idn-section-title', text: 'ECONOMY · World Bank (annual, HISTORICAL) · ECB reference rates (DELAYED)' }),
        ...(rows.length ? rows : [h('div', { class: 'idn-empty', text: 'World Bank indicators not loaded yet.' })]),
        h('div', { class: 'idn-section-title', text: 'EXCHANGE RATES' }),
        ...(rates.length ? rates : [h('div', { class: 'idn-empty', text: 'Rates not loaded yet.' })]),
        h('div', { class: 'idn-note', text: 'World Bank Open Data (CC BY 4.0) · Frankfurter / ECB. Informational only; not investment advice.' }),
      );
    } catch (error) {
      body.replaceChildren(h('div', { class: 'idn-empty', text: `Economy data unavailable: ${error.message}` }));
    }
  }

  function systemHealthRows() {
    const gl = (() => { try { const canvas = document.createElement('canvas'); return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl')); } catch { return false; } })();
    const rows = [
      ['Application', 'ONLINE'],
      ['3D globe (Cesium)', viewer?.scene ? 'ONLINE' : 'OFFLINE'],
      ['WebGL', gl ? 'ONLINE' : 'OFFLINE'],
      ['GIS map (MapLibre)', gisMap?.isReady?.() ? 'ONLINE' : 'NOT LOADED'],
      ['Intelligence engine', status?.stale ? 'OFFLINE' : status?.lastSweepAt ? 'ONLINE' : status ? 'DEGRADED' : 'OFFLINE'],
      ['Providers', !status ? 'OFFLINE' : status.summary?.failing ? 'DEGRADED' : status.summary?.ok ? 'ONLINE' : 'DEGRADED'],
      ['Indonesia data pack', pack?.provinces?.length === 38 ? 'ONLINE' : pack?.provinces?.length ? 'DEGRADED' : 'NOT CONFIGURED'],
      ['Sweep memory', status?.startedAt ? 'ONLINE' : 'OFFLINE'],
      ['AI voice', document.getElementById('voice-control') || document.querySelector('[data-voice-control]') ? 'SEE POWER UP' : 'NOT CONFIGURED'],
    ];
    return h('div', { class: 'idn-health' }, rows.map(([label, value]) => h('div', { class: 'idn-health-row' }, [
      h('span', { class: 'idn-health-label', text: label }),
      h('span', { class: `idn-health-value ${value.toLowerCase().replace(/\s+/g, '-')}`, text: value }),
    ])));
  }

  function renderSources() {
    const health = status?.health || [];
    body.replaceChildren(
      h('div', { class: 'idn-section-title', text: 'SYSTEM HEALTH' }),
      systemHealthRows(),
      h('div', { class: 'idn-section-title', text: `DATA SOURCES · ${status?.summary?.ok ?? 0} reporting · ${status?.summary?.failing ?? 0} failing · ${status?.summary?.notConfigured ?? 0} not configured` }),
      h('div', { class: 'idn-list' }, health.map((entry) => h('div', { class: 'idn-source' }, [
        h('span', { class: `idn-state ${entry.state}`, text: ({ ok: entry.stale ? 'STALE' : 'OK', error: 'ERROR', timeout: 'TIMEOUT', 'not-configured': 'NOT CONFIGURED', pending: 'PENDING', skipped: 'IDLE' })[entry.state] || entry.state.toUpperCase() }),
        h('span', { class: 'idn-source-main' }, [
          h('span', { class: 'idn-event-title', text: `${entry.name} · ${entry.category}` }),
          h('span', { class: 'idn-event-meta', text: `${entry.auth === 'keyless' ? 'keyless' : `key: ${entry.envKey || entry.auth}`} · every ${Math.round(entry.intervalMs / 60_000)} min · ${entry.eventCount} events · ${entry.lastRunAt ? `run ${timeAgo(entry.lastRunAt)} (${entry.durationMs} ms)` : 'not run yet'}` }),
          entry.error ? h('span', { class: 'idn-event-meta err', text: entry.error }) : null,
          h('span', { class: 'idn-event-meta', text: `${entry.attribution}${entry.license ? ` · ${entry.license}` : ''}` }),
          entry.sourceUrl ? h('a', { class: 'idn-link', href: entry.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: entry.sourceUrl }) : null,
        ]),
      ]))),
      h('div', { class: 'idn-note', text: 'ReliefWeb needs RELIEFWEB_APPNAME (register at apidoc.reliefweb.int). NASA FIRMS fires use the existing FIRMS_MAP_KEY layer. Everything else is keyless.' }),
    );
  }

  function renderTab() {
    for (const button of tabBar.children) {
      const active = button.dataset.tab === activeTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    ({ alerts: renderAlerts, events: renderEvents, weather: renderWeather, brief: renderBrief, economy: renderEconomy, sources: renderSources })[activeTab]?.();
  }

  // ── data ───────────────────────────────────────────────────────────────
  async function refreshStatus() {
    try {
      status = await intelClient.getStatus();
    } catch (error) {
      status = { ...(status || {}), stale: true, error: error.message };
    }
    renderStatus();
  }
  async function refreshAlerts() {
    try {
      const payload = await intelClient.getAlerts({ scope: currentScope() });
      alerts = payload.alerts || [];
    } catch {
      alerts = [];
    }
    renderStatus();
    if (activeTab === 'alerts') renderAlerts();
  }
  async function refreshEvents() {
    const layer = eventsLayer();
    const cached = [...(layer?.getEvents?.() || []), ...(newsLayer()?.getEvents?.() || [])];
    if (cached.length) {
      events = cached;
      eventsStale = false;
    } else {
      try {
        const payload = await intelClient.getEvents({ hours: FETCH_HOURS, limit: 2000 });
        events = payload.events || [];
        eventsStale = Boolean(payload.stale);
      } catch {
        eventsStale = true;
      }
    }
    if (activeTab === 'events') renderEvents();
    gisPanel?.refreshEvents();
  }
  async function refreshAll() {
    await Promise.all([refreshStatus(), refreshAlerts(), refreshEvents()]);
    if (!['alerts', 'events'].includes(activeTab)) renderTab();
  }
  async function ensurePack() {
    if (pack) return pack;
    try {
      pack = await intelClient.getPack();
      for (const province of pack.provinces || []) provinceSelect.append(h('option', { value: province.code, text: `${province.name}` }));
      provinceSelect.value = state.get().provinceCode || '';
    } catch {
      pack = { provinces: [], weatherPoints: [], airports: [], volcanoes: [], cities: [] };
    }
    return pack;
  }

  // ── selection & navigation ────────────────────────────────────────────
  function selectEvent(event, { fly = false } = {}) {
    selected = event || null;
    state.set({ selectedEventId: selected?.id || null });
    renderDetail();
    if (activeTab === 'events') renderEvents();
    if (!selected) { eventsLayer()?.selectEvent?.(null); return; }
    if (fly && selected.location) {
      if (state.get().mapMode === 'gis' && gisMap) {
        gisMap.applyView({ lat: selected.location.lat, lon: selected.location.lon, zoom: selected.type === 'earthquake' ? 7 : 9 });
      } else {
        const layer = selected.type === 'news' ? newsLayer() : eventsLayer();
        if (layer?.selectEvent && layer.getVisibleEvents?.().some((entry) => entry.id === selected.id)) layer.selectEvent(selected.id, { fly: true });
        else flyToPoint(viewer, selected.location.lat, selected.location.lon, { heightM: heightForEventType(selected.type) });
      }
    }
  }

  async function setIndonesiaMode(enabled) {
    state.set({ enabled });
    if (!enabled) return;
    for (const id of ['id-events', 'id-news']) {
      if (dataManager?.layers?.has(id) && !dataManager.isEnabled(id)) {
        dataManager.setEnabled(id, true, { origin: 'user' }).catch((error) => console.warn(`[indonesia] enable ${id}:`, error));
      }
    }
    const center = viewCenter(viewer);
    if (!bboxContains(INDONESIA_BBOX, center.lat, center.lon)) flyToIndonesia(viewer);
  }

  let gisPromise = null;
  /** Create the GIS map once; concurrent callers share the same readiness promise. */
  function ensureGis() {
    if (gisPromise) return gisPromise;
    gisPromise = (async () => {
      const mapContainer = gisRoot.querySelector('.gis-map') || gisRoot.appendChild(h('div', { class: 'gis-map' }));
      const candidate = createGisMap({
        container: mapContainer,
        onFeatureClick: (hit) => gisPanel?.handleFeatureClick(hit),
        onMapClick: (hit) => gisPanel?.handleMapClick(hit),
      });
      await candidate.ensureReady();
      gisMap = candidate;
      await ensurePack();
      gisMap.setAirports(pack.airports || []);
      gisMap.setVolcanoes(pack.volcanoes || []);
      gisMap.setEvents(filteredEvents());
      gisMap.setProvince(state.get().provinceCode);
      intelClient.getBoundaries('regencies').then((collection) => {
        boundaries = collection?.features ? collection : null;
        if (boundaries) gisMap.setBoundaries(boundaries);
      }).catch((error) => console.warn('[indonesia] boundaries unavailable:', error.message));
      gisPanel = createGisPanel({
        root: gisRoot,
        gisMap,
        state,
        getEvents: filteredEvents,
        getPack: ensurePack,
        getBoundaries: () => boundaries,
        queryWeather: (lat, lon) => intelClient.getWeather({ lat: lat.toFixed(3), lon: lon.toFixed(3) }),
        onExit: () => mapMode.setMode('3d'),
      });
      return gisMap;
    })().catch((error) => {
      gisPromise = null;
      gisMap = null;
      throw error;
    });
    return gisPromise;
  }

  function ensureMapMode() {
    if (mapMode) return mapMode;
    mapMode = createMapModeController({
      viewer,
      gisMap: { ensureReady: async () => { await ensureGis(); }, getView: () => gisMap.getView(), applyView: (view) => gisMap.applyView(view), resize: () => gisMap.resize() },
      root: gisRoot,
      state,
      onModeChange: () => syncControls(),
    });
    return mapMode;
  }

  let switchingMode = false;
  async function setMapMode(mode) {
    if (switchingMode) return;
    switchingMode = true;
    const previous = statusLine.textContent;
    if (mode === 'gis' && !gisMap) statusLine.textContent = 'Loading the GIS map…';
    try {
      await ensureMapMode().setMode(mode);
      if (statusLine.textContent === 'Loading the GIS map…') statusLine.textContent = previous;
    } catch (error) {
      console.warn('[indonesia] GIS mode unavailable:', error);
      statusLine.textContent = `GIS map unavailable: ${error.message}`;
    } finally {
      switchingMode = false;
    }
  }

  // ── timeline playback ─────────────────────────────────────────────────
  function stopPlayback() {
    clearInterval(playbackTimer);
    playbackTimer = null;
    state.set({ timelinePlaying: false, timelineUntilMs: null });
  }
  function startPlayback() {
    const hours = state.get().timelineHours;
    const start = Date.now() - hours * 3_600_000;
    const stepMs = (hours * 3_600_000) / 60;
    let cursor = start + stepMs;
    state.set({ timelinePlaying: true, timelineUntilMs: cursor });
    playbackTimer = setInterval(() => {
      cursor += stepMs;
      if (cursor >= Date.now()) { stopPlayback(); return; }
      state.set({ timelineUntilMs: cursor });
    }, 300);
  }

  // ── wiring ─────────────────────────────────────────────────────────────
  modeSwitch.addEventListener('change', () => setIndonesiaMode(modeSwitch.checked));
  provinceSelect.addEventListener('change', async () => {
    const code = provinceSelect.value || null;
    state.set({ provinceCode: code });
    await ensurePack();
    const province = provinceOf(code);
    if (province) {
      if (state.get().mapMode === 'gis' && gisMap) { gisMap.setProvince(code); if (province.bbox) gisMap.fitBounds(province.bbox); } else flyToProvince(viewer, province);
    } else if (state.get().mapMode !== 'gis') {
      flyToIndonesia(viewer, { duration: 2 });
    }
    refreshAlerts();
  });
  view3dBtn.addEventListener('click', () => setMapMode('3d'));
  viewGisBtn.addEventListener('click', () => setMapMode('gis'));
  modeButton?.addEventListener('click', () => setMapMode(state.get().mapMode === 'gis' ? '3d' : 'gis'));
  sweepBtn.addEventListener('click', async () => {
    sweepBtn.disabled = true;
    sweepBtn.textContent = 'SWEEPING…';
    try { await intelClient.triggerSweep(); await refreshAll(); } catch (error) { statusLine.textContent = `Sweep refused: ${error.message}`; }
    sweepBtn.disabled = false;
    sweepBtn.textContent = 'SWEEP NOW';
  });
  for (const chip of presetChips) chip.addEventListener('click', () => { stopPlayback(); state.set({ timelineHours: Number(chip.dataset.hours), timelineUntilMs: null }); });
  for (const chip of typeChips) chip.addEventListener('click', () => {
    const groups = new Set(state.get().typeGroups);
    if (groups.has(chip.dataset.group)) groups.delete(chip.dataset.group); else groups.add(chip.dataset.group);
    state.set({ typeGroups: [...groups] });
  });
  playBtn.addEventListener('click', () => (playbackTimer ? stopPlayback() : startPlayback()));
  rangeInput.addEventListener('input', () => {
    const hours = state.get().timelineHours;
    const pct = Number(rangeInput.value);
    if (pct >= 100) { state.set({ timelineUntilMs: null }); return; }
    state.set({ timelineUntilMs: Date.now() - hours * 3_600_000 + (pct / 100) * hours * 3_600_000 });
  });
  tabBar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button) return;
    activeTab = button.dataset.tab;
    renderTab();
  });
  root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } });
  window.addEventListener('gev:intel-event-selected', (event) => {
    const picked = event.detail?.event || null;
    if (picked && picked.id !== selected?.id) { selected = picked; state.set({ selectedEventId: picked.id }); renderDetail(); if (activeTab === 'events') renderEvents(); if (root.hidden) open(); }
    else if (!picked && selected) { selected = null; state.set({ selectedEventId: null }); renderDetail(); }
  });
  state.subscribe((_, changed) => {
    syncControls();
    if (changed.some((key) => ['timelineHours', 'timelineUntilMs', 'typeGroups', 'provinceCode'].includes(key))) {
      if (activeTab === 'events') renderEvents();
      gisPanel?.refreshEvents();
    }
  });
  intelClient.subscribeSweeps(() => refreshAll());

  function open() {
    root.hidden = false;
    navButton?.setAttribute('aria-expanded', 'true');
    navButton?.classList.add('active');
    ensurePack().then(() => refreshAll());
    syncControls();
    renderTab();
  }
  function close() {
    root.hidden = true;
    navButton?.setAttribute('aria-expanded', 'false');
    navButton?.classList.remove('active');
  }
  navButton?.addEventListener('click', () => (root.hidden ? open() : close()));

  // Boot: badge + status even while closed; Indonesia mode restores its layers.
  ensurePack().then(() => refreshAll());
  syncControls();
  renderTab();
  if (state.get().enabled) {
    setTimeout(() => setIndonesiaMode(true), 1500);
  }

  return {
    state,
    open,
    close,
    isOpen: () => !root.hidden,
    setIndonesiaMode,
    setMapMode,
    getMapMode: () => state.get().mapMode,
    selectEvent,
    getEvents: () => events,
    getFilteredEvents: filteredEvents,
    getAlerts: () => alerts,
    getStatus: () => status,
    ensureGis,
    getGisMap: () => gisMap,
    showTab(tab) { if (TABS.some(([id]) => id === tab)) { activeTab = tab; open(); } },
    setTimelinePlaying(playing) { if (playing && !playbackTimer) startPlayback(); else if (!playing && playbackTimer) stopPlayback(); },
  };
}
