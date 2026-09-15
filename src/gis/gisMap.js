/**
 * @module gis/gisMap
 *
 * The 2D GIS map: MapLibre GL JS (BSD-3-Clause) with keyless basemaps
 * (OpenFreeMap vector styles, Esri World Imagery raster), the Indonesia
 * administrative boundaries, intelligence events, airports, volcanoes, and an
 * "analysis" layer for buffers, measurements, and query results.
 *
 * maplibre-gl is imported lazily on first use so the 3D globe's startup pays
 * nothing for the GIS mode.
 */

import { EVENT_TYPE_COLORS, SEVERITY_PIXEL_SIZE, shortEventLabel } from '../data/intelEvents.js';
import { eventsToGeoJson } from './spatialTools.js';

export const BASEMAPS = Object.freeze([
  { id: 'liberty', label: 'OpenFreeMap Liberty', kind: 'style', url: 'https://tiles.openfreemap.org/styles/liberty' },
  { id: 'positron', label: 'OpenFreeMap Positron', kind: 'style', url: 'https://tiles.openfreemap.org/styles/positron' },
  { id: 'esri-imagery', label: 'Esri World Imagery', kind: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community' },
]);
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const LABEL_FONT = ['Noto Sans Regular'];

function rasterStyle(basemap) {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: { basemap: { type: 'raster', tiles: basemap.tiles, tileSize: 256, maxzoom: 19, attribution: basemap.attribution } },
    layers: [{ id: 'basemap', type: 'raster', source: 'basemap' }],
  };
}

const EMPTY = { type: 'FeatureCollection', features: [] };
const colorMatch = ['match', ['get', 'type'], ...Object.entries(EVENT_TYPE_COLORS).flat(), EVENT_TYPE_COLORS.other];
const radiusMatch = ['match', ['get', 'severity'], ...Object.entries(SEVERITY_PIXEL_SIZE).flatMap(([key, px]) => [key, px * 0.6]), 4];

export function createGisMap({ container, onFeatureClick = () => {}, onMapClick = () => {} }) {
  let maplibre = null;
  let map = null;
  let readyPromise = null;
  let basemapId = 'liberty';
  const data = { regencies: EMPTY, events: EMPTY, airports: EMPTY, volcanoes: EMPTY, analysis: EMPTY };
  const visible = { regencies: true, events: true, airports: false, volcanoes: false, analysis: true };
  let provinceCode = null;
  let hoveredRegency = null;

  function styleFor(id) {
    const basemap = BASEMAPS.find((entry) => entry.id === id) || BASEMAPS[0];
    return basemap.kind === 'raster' ? rasterStyle(basemap) : basemap.url;
  }

  function addOverlays() {
    if (!map) return;
    const ensureSource = (id, promoteId) => {
      if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: data[id], ...(promoteId ? { promoteId } : {}) });
    };
    ensureSource('regencies', 'code');
    ensureSource('analysis');
    ensureSource('airports');
    ensureSource('volcanoes');
    ensureSource('events');
    const addLayer = (layer) => { if (!map.getLayer(layer.id)) map.addLayer(layer); };
    addLayer({ id: 'regencies-fill', type: 'fill', source: 'regencies', paint: { 'fill-color': '#00d4ff', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.18, ['boolean', ['feature-state', 'province'], false], 0.1, 0.02] } });
    addLayer({ id: 'regencies-line', type: 'line', source: 'regencies', paint: { 'line-color': '#00d4ff', 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.4, 9, 1.2] } });
    addLayer({ id: 'province-line', type: 'line', source: 'regencies', filter: ['==', ['slice', ['get', 'code'], 0, 2], provinceCode || '__'], paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.9 } });
    addLayer({ id: 'analysis-fill', type: 'fill', source: 'analysis', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': '#ffd166', 'fill-opacity': 0.16 } });
    addLayer({ id: 'analysis-line', type: 'line', source: 'analysis', paint: { 'line-color': '#ffd166', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
    addLayer({ id: 'analysis-points', type: 'circle', source: 'analysis', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 5, 'circle-color': '#ffd166', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
    addLayer({ id: 'airports-points', type: 'circle', source: 'airports', paint: { 'circle-radius': ['match', ['get', 'type'], 'large', 5, 'medium', 4, 3], 'circle-color': '#7fffd4', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
    addLayer({ id: 'airports-labels', type: 'symbol', source: 'airports', minzoom: 7, layout: { 'text-field': ['coalesce', ['get', 'iata'], ['get', 'ident']], 'text-font': LABEL_FONT, 'text-size': 10, 'text-offset': [0, 1.1], 'text-anchor': 'top' }, paint: { 'text-color': '#7fffd4', 'text-halo-color': '#000', 'text-halo-width': 1 } });
    addLayer({ id: 'volcanoes-points', type: 'circle', source: 'volcanoes', paint: { 'circle-radius': 4, 'circle-color': '#ff9f1c', 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
    addLayer({ id: 'volcanoes-labels', type: 'symbol', source: 'volcanoes', minzoom: 6, layout: { 'text-field': ['get', 'name'], 'text-font': LABEL_FONT, 'text-size': 10, 'text-offset': [0, 1.1], 'text-anchor': 'top' }, paint: { 'text-color': '#ff9f1c', 'text-halo-color': '#000', 'text-halo-width': 1 } });
    addLayer({ id: 'events-points', type: 'circle', source: 'events', paint: { 'circle-radius': radiusMatch, 'circle-color': colorMatch, 'circle-opacity': ['match', ['get', 'status'], 'historical', 0.5, 0.95], 'circle-stroke-color': '#000', 'circle-stroke-width': 1 } });
    addLayer({ id: 'events-labels', type: 'symbol', source: 'events', minzoom: 5, layout: { 'text-field': ['get', 'label'], 'text-font': LABEL_FONT, 'text-size': 11, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-optional': true }, paint: { 'text-color': colorMatch, 'text-halo-color': '#000', 'text-halo-width': 1.2 } });
    applyVisibility();
  }

  function applyVisibility() {
    if (!map) return;
    const groups = {
      regencies: ['regencies-fill', 'regencies-line', 'province-line'],
      events: ['events-points', 'events-labels'],
      airports: ['airports-points', 'airports-labels'],
      volcanoes: ['volcanoes-points', 'volcanoes-labels'],
      analysis: ['analysis-fill', 'analysis-line', 'analysis-points'],
    };
    for (const [key, layers] of Object.entries(groups)) {
      for (const id of layers) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible[key] ? 'visible' : 'none');
      }
    }
  }

  function bindInteractions() {
    const canvas = map.getCanvas();
    map.on('mousemove', 'regencies-fill', (event) => {
      const feature = event.features?.[0];
      if (hoveredRegency && hoveredRegency !== feature?.id) map.setFeatureState({ source: 'regencies', id: hoveredRegency }, { hover: false });
      if (feature) {
        hoveredRegency = feature.id;
        map.setFeatureState({ source: 'regencies', id: feature.id }, { hover: true });
      }
    });
    map.on('mouseleave', 'regencies-fill', () => {
      if (hoveredRegency) map.setFeatureState({ source: 'regencies', id: hoveredRegency }, { hover: false });
      hoveredRegency = null;
    });
    for (const layer of ['events-points', 'airports-points', 'volcanoes-points']) {
      map.on('mouseenter', layer, () => { canvas.style.cursor = 'pointer'; });
      map.on('mouseleave', layer, () => { canvas.style.cursor = ''; });
    }
    map.on('click', (event) => {
      const hits = map.queryRenderedFeatures(event.point, { layers: ['events-points', 'airports-points', 'volcanoes-points', 'regencies-fill'].filter((id) => map.getLayer(id)) });
      const feature = hits[0];
      if (feature && feature.layer.id !== 'regencies-fill') {
        onFeatureClick({ kind: feature.layer.id.replace(/-points$/, ''), properties: feature.properties, lngLat: event.lngLat });
        return;
      }
      onMapClick({ lat: event.lngLat.lat, lon: event.lngLat.lng, regency: feature?.properties || null });
    });
  }

  /**
   * Wait until the style JSON is parsed (sources and layers can be added).
   * MapLibre's own `load` event also waits for every initial tile, which on a
   * slow route to the tile CDN can take a very long time — the map is usable
   * well before that. Tile errors are logged, never fatal.
   */
  function waitForStyle(target, { timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (target.style?._loaded || target.isStyleLoaded()) { resolve(); return; }
      const timer = setTimeout(() => reject(new Error(`Basemap style did not load within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      target.once('style.load', done);
      target.once('load', done);
    });
  }

  let tileErrorCount = 0;
  function onMapError(event) {
    tileErrorCount += 1;
    if (tileErrorCount <= 3) console.warn('[gis] map error:', event?.error?.message || event?.error || 'unknown');
  }

  async function ensureReady() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const module = await import('maplibre-gl');
      await import('maplibre-gl/dist/maplibre-gl.css');
      // MapLibre 6 parses vector tiles and GeoJSON in a module worker that it
      // resolves relative to its own import.meta.url. Under Vite that URL is
      // the pre-bundled dep (dev) or a hashed chunk (build), where the worker
      // file does not exist: the worker never answers, raster tiles still draw,
      // and every vector/GeoJSON layer stays silently empty. Hand it the worker
      // Vite bundles for us instead.
      const { default: workerUrl } = await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url');
      maplibre = module.default || module;
      (module.setWorkerUrl || maplibre.setWorkerUrl)?.(workerUrl);
      map = new maplibre.Map({
        container,
        style: styleFor(basemapId),
        center: [118, -2.5],
        zoom: 4,
        attributionControl: { compact: false },
        maxZoom: 19,
      });
      map.on('error', onMapError);
      map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), 'bottom-right');
      map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-left');
      try {
        await waitForStyle(map);
      } catch (error) {
        // The vector style host is unreachable or slow: fall back to the
        // Esri raster basemap so the GIS mode still works.
        console.warn(`[gis] ${error.message}; switching to Esri World Imagery`);
        basemapId = 'esri-imagery';
        map.setStyle(styleFor(basemapId));
        await waitForStyle(map, { timeoutMs: 20_000 });
      }
      addOverlays();
      map.on('style.load', addOverlays);
      bindInteractions();
      return map;
    })().catch((error) => {
      readyPromise = null;
      map?.remove();
      map = null;
      throw error;
    });
    return readyPromise;
  }

  function setData(key, collection) {
    data[key] = collection || EMPTY;
    map?.getSource(key)?.setData(data[key]);
  }

  return {
    ensureReady,
    isReady: () => Boolean(map) && Boolean(map.getSource('events')),
    getMap: () => map,
    getView() {
      if (!map) return null;
      const center = map.getCenter();
      return { lat: center.lat, lon: center.lng, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
    },
    applyView({ lat, lon, zoom, bearing = 0, pitch = 0 }) {
      map?.jumpTo({ center: [lon, lat], zoom, bearing, pitch });
    },
    fitBounds(bbox, { padding = 48 } = {}) {
      if (!map || !Array.isArray(bbox)) return;
      map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding, duration: 600 });
    },
    resize: () => map?.resize(),
    setBasemap(id) {
      basemapId = BASEMAPS.some((entry) => entry.id === id) ? id : 'liberty';
      map?.setStyle(styleFor(basemapId));
    },
    getBasemap: () => basemapId,
    setBoundaries: (collection) => setData('regencies', collection),
    setEvents(events) {
      const collection = eventsToGeoJson(events);
      for (const feature of collection.features) {
        const event = events.find((entry) => entry.id === feature.properties.id);
        feature.properties.label = event ? shortEventLabel(event) : '';
      }
      setData('events', collection);
    },
    setAirports(airports) {
      setData('airports', { type: 'FeatureCollection', features: (airports || []).map((airport) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [airport.lon, airport.lat] }, properties: { ...airport } })) });
    },
    setVolcanoes(volcanoes) {
      setData('volcanoes', { type: 'FeatureCollection', features: (volcanoes || []).map((volcano) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [volcano.lon, volcano.lat] }, properties: { ...volcano } })) });
    },
    setAnalysis: (collection) => setData('analysis', collection),
    setProvince(code) {
      provinceCode = code || null;
      if (map?.getLayer('province-line')) map.setFilter('province-line', ['==', ['slice', ['get', 'code'], 0, 2], provinceCode || '__']);
      for (const feature of data.regencies.features || []) {
        map?.setFeatureState({ source: 'regencies', id: feature.properties.code }, { province: Boolean(provinceCode) && String(feature.properties.code).startsWith(provinceCode) });
      }
    },
    setLayerVisible(key, on) {
      if (!(key in visible)) return;
      visible[key] = Boolean(on);
      applyVisibility();
    },
    getLayerVisibility: () => ({ ...visible }),
    setCursor(cursor) { if (map) map.getCanvas().style.cursor = cursor || ''; },
    popup(lngLat, html) {
      if (!map) return null;
      return new maplibre.Popup({ closeButton: true, maxWidth: '320px' }).setLngLat(lngLat).setHTML(html).addTo(map);
    },
    destroy() {
      map?.remove();
      map = null;
      readyPromise = null;
    },
  };
}
