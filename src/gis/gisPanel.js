/**
 * @module gis/gisPanel
 *
 * The SPATIAL ANALYSIS panel shown over the GIS map: basemap and layer
 * toggles, province focus, measurement, buffer queries, nearest-feature
 * lookups, and GeoJSON/CSV export. Every result is computed by
 * `spatialTools.js` on real data (events, boundaries, airports, volcanoes).
 */

import {
  bufferKm, distanceKm, bearingDeg, areaKm2, eventsWithinPolygon, eventsWithinRadius, nearestFeature,
  eventsToGeoJson, eventsToCsv, measurementLine, makePoint, makeCollection, unionPolygons, toDms,
} from './spatialTools.js';
import { BASEMAPS } from './gisMap.js';

function h(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const ATTRIBUTION_NOTE = 'Exports carry per-event attribution (BMKG, BNPB, PVMBG, USGS, GDELT) and boundary credit (BNPB/Kemendagri).';

/**
 * @param {object} options
 * @param {HTMLElement} options.root The GIS root element (the map lives in `.gis-map`).
 * @param {object} options.gisMap createGisMap() instance.
 * @param {object} options.state Indonesia state store.
 * @param {() => object[]} options.getEvents Current filtered events.
 * @param {() => Promise<object>} options.getPack Pack loader ({ provinces, airports, volcanoes }).
 * @param {() => object|null} options.getBoundaries Regency FeatureCollection when loaded.
 * @param {(lat:number, lon:number) => Promise<object>} options.queryWeather Point weather lookup.
 * @param {() => void} options.onExit Back to 3D.
 */
export function createGisPanel({ root, gisMap, state, getEvents, getPack, getBoundaries, getProvinceBoundaries = () => null, queryWeather, onExit }) {
  let mode = 'none';
  let measureStart = null;
  let lastResultEvents = [];
  let analysisFeatures = [];
  const results = h('div', { class: 'gis-results', 'aria-live': 'polite' });
  const modeLabel = h('span', { class: 'gis-mode-label', text: 'Click: inspect' });
  const bufferInput = h('input', { type: 'number', min: '1', max: '500', step: '1', value: '25', class: 'gis-input', 'aria-label': 'Buffer radius in km' });
  const provinceSelect = h('select', { class: 'gis-select', 'aria-label': 'Focus province' }, [h('option', { value: '', text: 'All Indonesia' })]);
  const basemapSelect = h('select', { class: 'gis-select', 'aria-label': 'Basemap' }, BASEMAPS.map((basemap) => h('option', { value: basemap.id, text: basemap.label })));

  function setResults(title, lines = [], { events = null } = {}) {
    results.replaceChildren(
      h('div', { class: 'gis-results-title', text: title }),
      ...lines.map((line) => h('div', { class: 'gis-results-line', text: line })),
    );
    lastResultEvents = events || [];
    if (lastResultEvents.length) {
      results.append(h('div', { class: 'gis-export-row' }, [
        h('button', { type: 'button', class: 'gis-btn', text: 'Export GeoJSON', onclick: () => download(`cakrawala-events-${Date.now()}.geojson`, JSON.stringify(eventsToGeoJson(lastResultEvents), null, 1), 'application/geo+json') }),
        h('button', { type: 'button', class: 'gis-btn', text: 'Export CSV', onclick: () => download(`cakrawala-events-${Date.now()}.csv`, eventsToCsv(lastResultEvents), 'text/csv') }),
      ]));
      results.append(h('div', { class: 'gis-results-note', text: ATTRIBUTION_NOTE }));
    }
  }

  function pushAnalysis(feature) {
    analysisFeatures = [...analysisFeatures.slice(-5), feature];
    gisMap.setAnalysis(makeCollection(analysisFeatures));
  }

  function clearAnalysis() {
    analysisFeatures = [];
    measureStart = null;
    gisMap.setAnalysis(makeCollection([]));
    setResults('Cleared');
  }

  function setMode(next) {
    mode = next;
    measureStart = null;
    modeLabel.textContent = { none: 'Click: inspect', measure: 'Click two points to measure', buffer: `Click a point to buffer ${bufferInput.value} km`, weather: 'Click a point for weather' }[mode] || 'Click: inspect';
    gisMap.setCursor(mode === 'none' ? '' : 'crosshair');
    for (const button of toolButtons) button.classList.toggle('active', button.dataset.mode === mode);
  }

  const toolButtons = [
    h('button', { type: 'button', class: 'gis-btn', 'data-mode': 'measure', text: 'Measure', onclick: () => setMode(mode === 'measure' ? 'none' : 'measure') }),
    h('button', { type: 'button', class: 'gis-btn', 'data-mode': 'buffer', text: 'Buffer', onclick: () => setMode(mode === 'buffer' ? 'none' : 'buffer') }),
    h('button', { type: 'button', class: 'gis-btn', 'data-mode': 'weather', text: 'Weather', onclick: () => setMode(mode === 'weather' ? 'none' : 'weather') }),
  ];

  async function provinceSummary(code) {
    const pack = await getPack();
    const province = pack.provinces.find((entry) => entry.code === code);
    const boundaries = getBoundaries();
    if (!province) return;
    gisMap.setProvince(code);
    if (province.bbox) gisMap.fitBounds(province.bbox);
    const members = (boundaries?.features || []).filter((feature) => String(feature.properties.code).startsWith(code));
    const events = getEvents();
    // Prefer the dissolved province polygon; unioning members on the fly is
    // the fallback while provinces.geojson has not arrived.
    const outline = (getProvinceBoundaries()?.features || []).find((feature) => String(feature.properties.code) === code) || null;
    const inside = outline ? eventsWithinPolygon(events, outline)
      : members.length ? eventsWithinPolygon(events, unionPolygons(...members))
        : events.filter((event) => event.provinceCode === code);
    const byType = {};
    for (const event of inside) byType[event.type] = (byType[event.type] || 0) + 1;
    const airports = pack.airports.filter((airport) => airport.region === `ID-${provinceIso(province)}`);
    setResults(`${province.name}`, [
      `${members.length} kabupaten/kota polygons · capital ${province.capital}`,
      `${inside.length} events in the current window: ${Object.entries(byType).map(([type, count]) => `${type} ${count}`).join(', ') || 'none'}`,
      airports.length ? `${airports.length} airports (OurAirports)` : 'Airports: region code not matched',
    ], { events: inside });
  }

  function provinceIso(province) {
    // OurAirports uses ISO 3166-2 codes; most match Kemendagri two-digit codes by name, not number.
    return ({ 11: 'AC', 12: 'SU', 13: 'SB', 14: 'RI', 15: 'JA', 16: 'SS', 17: 'BE', 18: 'LA', 19: 'BB', 21: 'KR', 31: 'JK', 32: 'JB', 33: 'JT', 34: 'YO', 35: 'JI', 36: 'BT', 51: 'BA', 52: 'NB', 53: 'NT', 61: 'KB', 62: 'KT', 63: 'KS', 64: 'KI', 65: 'KU', 71: 'SA', 72: 'ST', 73: 'SN', 74: 'SG', 75: 'GO', 76: 'SR', 81: 'MA', 82: 'MU', 91: 'PA', 92: 'PB', 93: 'PS', 94: 'PT', 95: 'PP', 96: 'PD' })[Number(province.code)] || '';
  }

  async function handleMapClick({ lat, lon, regency }) {
    if (mode === 'measure') {
      if (!measureStart) {
        measureStart = { lat, lon };
        pushAnalysis(makePoint([lon, lat], { tool: 'measure-start' }));
        setResults('Measure', [`Start ${toDms(lat, lon)} — click the end point`]);
        return;
      }
      const line = measurementLine(measureStart, { lat, lon });
      pushAnalysis(line);
      setResults('Distance', [
        `${line.properties.distanceKm.toFixed(2)} km · bearing ${line.properties.bearingDeg.toFixed(0)}°`,
        `${toDms(measureStart.lat, measureStart.lon)} → ${toDms(lat, lon)}`,
      ]);
      measureStart = null;
      return;
    }
    if (mode === 'buffer') {
      const km = Number(bufferInput.value) || 25;
      const ring = bufferKm({ lat, lon }, km);
      pushAnalysis(ring);
      const inside = eventsWithinRadius(getEvents(), { lat, lon }, km);
      const pack = await getPack();
      const nearestAirport = nearestFeature({ lat, lon }, pack.airports.map((airport) => makePoint([airport.lon, airport.lat], airport)));
      const nearestVolcano = nearestFeature({ lat, lon }, pack.volcanoes.map((volcano) => makePoint([volcano.lon, volcano.lat], volcano)));
      setResults(`Buffer ${km} km around ${toDms(lat, lon)}`, [
        `Area ${areaKm2(ring).toFixed(0)} km² · ${inside.length} events inside`,
        ...inside.slice(0, 6).map((event) => `• ${event.distanceKm.toFixed(1)} km · ${event.severity} · ${event.title}`),
        nearestAirport ? `Nearest airport: ${nearestAirport.feature.properties.name} (${nearestAirport.distanceKm.toFixed(1)} km)` : null,
        nearestVolcano ? `Nearest volcano: ${nearestVolcano.feature.properties.name} (${nearestVolcano.distanceKm.toFixed(1)} km)` : null,
        regency ? `Regency: ${regency.name} (${regency.code})` : null,
      ].filter(Boolean), { events: inside });
      return;
    }
    if (mode === 'weather') {
      setResults('Weather', ['Loading…']);
      try {
        const payload = await queryWeather(lat, lon);
        const weather = payload?.['open-meteo']?.weather;
        const air = payload?.['open-meteo']?.airQuality;
        setResults(`Weather at ${toDms(lat, lon)}`, [
          weather ? `${weather.current.condition || '—'} · ${weather.current.tempC}°C · humidity ${weather.current.humidityPct}% · wind ${weather.current.windKmh} km/h` : 'Weather unavailable',
          weather ? `Observed ${weather.observedAt} · ${weather.status} · ${weather.attribution}` : null,
          air ? `Air quality: PM2.5 ${air.pm25} µg/m³ · US AQI ${air.usAqi} · ${air.status} (${air.attribution})` : null,
        ].filter(Boolean));
      } catch (error) {
        setResults('Weather', [`Unavailable: ${error.message}`]);
      }
      return;
    }
    if (regency) {
      const events = getEvents().filter((event) => event.city && event.city.toLowerCase() === String(regency.name).toLowerCase());
      setResults(`${regency.name}`, [`Code ${regency.code} · ${events.length} events matched by regency name`], { events });
    }
  }

  function handleFeatureClick({ kind, properties, lngLat }) {
    if (kind === 'events') {
      const event = getEvents().find((entry) => entry.id === properties.id);
      if (event) {
        state.set({ selectedEventId: event.id });
        window.dispatchEvent(new CustomEvent('gev:intel-event-selected', { detail: { layerId: 'gis', event } }));
        gisMap.popup(lngLat, `<strong>${escapeHtml(event.title)}</strong><br>${escapeHtml(event.severity)} · ${escapeHtml(event.status)} · ${escapeHtml(event.timestamp)}<br><small>${escapeHtml(event.attribution)}</small>`);
      }
      return;
    }
    if (kind === 'airports') gisMap.popup(lngLat, `<strong>${escapeHtml(properties.name)}</strong><br>${escapeHtml(properties.ident)}${properties.iata ? ` / ${escapeHtml(properties.iata)}` : ''} · ${escapeHtml(properties.type)}<br><small>OurAirports (public domain)</small>`);
    if (kind === 'volcanoes') gisMap.popup(lngLat, `<strong>${escapeHtml(properties.name)}</strong><br>${properties.elevationM ? `${properties.elevationM} m` : ''}<br><small>Position: Wikidata (CC0) · levels: PVMBG</small>`);
  }

  const layerToggles = ['provinces', 'regencies', 'events', 'heatmap', 'airports', 'volcanoes'].map((key) => {
    const input = h('input', { type: 'checkbox', checked: gisMap.getLayerVisibility()[key] || null, onchange: () => gisMap.setLayerVisible(key, input.checked) });
    return h('label', { class: 'gis-check' }, [input, ({ provinces: 'Provinces', regencies: 'Kab/Kota boundaries', events: 'Events', heatmap: 'Event heatmap', airports: 'Airports', volcanoes: 'Volcanoes' })[key]]);
  });

  const panel = h('section', { class: 'gis-panel', 'aria-label': 'Spatial analysis' }, [
    h('div', { class: 'gis-panel-header' }, [
      h('span', { class: 'gis-panel-title', text: 'GIS · SPATIAL ANALYSIS' }),
      h('button', { type: 'button', class: 'gis-btn gis-btn-exit', text: '← 3D globe', onclick: onExit }),
    ]),
    h('div', { class: 'gis-row' }, [h('label', { class: 'gis-label', text: 'Basemap' }), basemapSelect]),
    h('div', { class: 'gis-row gis-row-wrap' }, layerToggles),
    h('div', { class: 'gis-row' }, [h('label', { class: 'gis-label', text: 'Province' }), provinceSelect]),
    h('div', { class: 'gis-row gis-row-wrap' }, [...toolButtons, bufferInput, h('span', { class: 'gis-unit', text: 'km' })]),
    h('div', { class: 'gis-row' }, [modeLabel, h('button', { type: 'button', class: 'gis-btn gis-btn-ghost', text: 'Clear', onclick: clearAnalysis })]),
    results,
  ]);
  root.append(panel);

  basemapSelect.addEventListener('change', () => gisMap.setBasemap(basemapSelect.value));
  provinceSelect.addEventListener('change', () => {
    const code = provinceSelect.value || null;
    state.set({ provinceCode: code });
    if (code) provinceSummary(code);
    else { gisMap.setProvince(null); setResults('All Indonesia'); }
  });
  bufferInput.addEventListener('input', () => { if (mode === 'buffer') setMode('buffer'); });

  getPack().then((pack) => {
    for (const province of pack.provinces) provinceSelect.append(h('option', { value: province.code, text: `${province.code} · ${province.name}` }));
    provinceSelect.value = state.get().provinceCode || '';
  }).catch(() => {});

  state.subscribe((next, changed) => {
    if (changed.includes('provinceCode') && provinceSelect.value !== (next.provinceCode || '')) {
      provinceSelect.value = next.provinceCode || '';
      gisMap.setProvince(next.provinceCode);
    }
  });

  return { element: panel, handleMapClick, handleFeatureClick, setResults, refreshEvents: () => gisMap.setEvents(getEvents()) };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
