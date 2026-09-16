/**
 * @module data/intelEvents
 *
 * Cesium data layers for intelligence-engine events (Indonesia disaster
 * signals and geolocated news). Points are a single PointPrimitiveCollection
 * (thousands stay cheap); labels ride the shared world-overlay host so they
 * collide and fade like every other layer's labels. Filters (type groups,
 * timeline, province) come from the shared Indonesia state, so the drawer,
 * the GIS map, and these layers always agree on what is shown.
 */

import * as Cesium from 'cesium';
import { clearOverlaySource, setOverlayEntries, setOverlaySourceVisible } from '../overlays/worldOverlay.js';
import { registerPickOwner, resolvePickId, unregisterPickOwner } from './pickRegistry.js';
import { governorRequestRender } from '../renderGovernor.js';
import { intelClient } from '../indonesia/intelClient.js';
import { filterEventsForView, indonesiaState } from '../indonesia/indonesiaState.js';
import { flyToPoint, heightForEventType } from '../indonesia/indonesiaCamera.js';

export const EVENT_TYPE_COLORS = Object.freeze({
  earthquake: '#ff5a3c', tsunami: '#ff2d95', volcano: '#ff9f1c', flood: '#3fa7ff', landslide: '#c98b4a', fire: '#ff3b30',
  haze: '#b8b8b8', weather: '#8ad4ff', drought: '#d9b44a', disaster: '#ff7ab6', news: '#c8b6ff', transport: '#7fffd4',
  aviation: '#7fffd4', maritime: '#4ac6ff', infrastructure: '#9be564', economy: '#ffd166', health: '#ff8fa3', other: '#dddddd',
});
export const SEVERITY_PIXEL_SIZE = Object.freeze({ info: 6, low: 8, medium: 10, high: 13, critical: 16 });
const SEVERITY_RANK = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 });
const FETCH_HOURS = 24 * 30;

/** Short label for a map pin. */
export function shortEventLabel(event) {
  if (event.type === 'earthquake' && Number.isFinite(event.magnitude)) return `M${event.magnitude.toFixed(1)}`;
  if (event.type === 'volcano') return String(event.title).split(' · ')[0].slice(0, 22);
  if (event.type === 'weather') return String(event.title).split(':')[0].slice(0, 22);
  if (event.type === 'news') return String(event.title).slice(0, 34);
  return `${String(event.raw?.category || event.type).slice(0, 18)} · ${String(event.city || event.province || '').slice(0, 16)}`.replace(/ · $/, '');
}

/** Label priority: severity first, then recency. */
export function labelPriority(event, nowMs = Date.now()) {
  const ageHours = Math.max(0, (nowMs - Date.parse(event.timestamp)) / 3_600_000);
  return (SEVERITY_RANK[event.severity] || 0) * 10_000 + Math.max(0, 1000 - Math.round(ageHours));
}

/**
 * @param {object} options
 * @param {string} options.id Layer id (also the overlay source id and pick owner).
 * @param {string[]} [options.types] Event types this layer renders (default: all but news).
 * @param {boolean} [options.newsOnly]
 */
export function createIntelEventsLayer({ id, name, icon, source, types = null, newsOnly = false, labelLimit = 80, maxPoints = 2000 }) {
  let _viewer = null;
  let _points = null;
  let _byId = new Map();
  let _events = [];
  let _visible = [];
  let _enabled = false;
  let _loading = false;
  let _lastError = null;
  let _lastUpdate = null;
  let _stale = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _unsubscribe = [];
  let _paintHandle = null;
  let _paintPending = false;

  const typeSet = types ? new Set(types) : null;
  const accepts = (event) => (newsOnly ? event.type === 'news' : event.type !== 'news') && (!typeSet || typeSet.has(event.type));

  /**
   * Recompute the visible set, then repaint the globe. The filter is cheap and
   * stays synchronous so the voice analyst and the GIS panel always read a
   * current set; the expensive primitive/label churn is coalesced into one
   * animation frame (see schedulePaint) unless the caller needs it now.
   */
  function rebuild({ immediate = false } = {}) {
    if (!_points) return;
    const state = indonesiaState.get();
    _visible = filterEventsForView(_events.filter(accepts), state, { locatedOnly: true }).slice(0, maxPoints);
    if (immediate) paint();
    else schedulePaint();
  }

  /**
   * Timeline playback publishes a new cursor every 300 ms and a single user
   * action can change several state keys at once. Without coalescing, each one
   * tore down and re-added every point primitive and republished every label
   * synchronously — for both intel layers — inside the same frame.
   */
  function schedulePaint() {
    if (_paintHandle !== null) return;
    _paintHandle = requestAnimationFrame(() => {
      _paintHandle = null;
      paint();
    });
  }

  /**
   * Publish the visible set to the globe. A disabled layer draws nothing, so
   * the work is skipped and remembered; enable() repaints from current state.
   */
  function paint() {
    if (!_points) return;
    if (!_enabled) { _paintPending = true; return; }
    _paintPending = false;
    _points.removeAll();
    _byId = new Map();
    const nowMs = Date.now();
    for (const event of _visible) {
      const color = Cesium.Color.fromCssColorString(EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.other);
      const selected = event.id === _selectedId;
      const size = SEVERITY_PIXEL_SIZE[event.severity] || 6;
      const primitive = _points.add({
        id: event.id,
        position: Cesium.Cartesian3.fromDegrees(event.location.lon, event.location.lat, 2),
        pixelSize: selected ? size + 6 : size,
        color: event.status === 'historical' ? color.withAlpha(0.45) : color,
        outlineColor: selected ? Cesium.Color.WHITE : Cesium.Color.BLACK.withAlpha(0.65),
        outlineWidth: selected ? 3 : 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(2.0e5, 1.0, 9.0e6, 0.6),
      });
      _byId.set(event.id, { event, primitive });
    }
    const labels = _visible
      .slice()
      .sort((a, b) => labelPriority(b, nowMs) - labelPriority(a, nowMs))
      .slice(0, labelLimit)
      .map((event) => ({
        id: event.id,
        position: _byId.get(event.id).primitive.position,
        variant: 'label',
        title: shortEventLabel(event),
        accent: EVENT_TYPE_COLORS[event.type] || EVENT_TYPE_COLORS.other,
        priority: labelPriority(event, nowMs) + (event.id === _selectedId ? 100_000 : 0),
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: false,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 15,
        verticalOnly: true,
        placement: 'above',
      }));
    setOverlayEntries(id, labels, { cohortLimit: labelLimit, collisionCapacity: 48, moving: false });
    governorRequestRender(`${id}-rebuild`);
  }

  function selectEvent(eventId, { fly = true } = {}) {
    const entry = _byId.get(eventId) || null;
    _selectedId = entry ? eventId : null;
    rebuild({ immediate: true });
    if (entry && fly && _viewer) {
      flyToPoint(_viewer, entry.event.location.lat, entry.event.location.lon, { heightM: heightForEventType(entry.event.type) });
    }
    window.dispatchEvent(new CustomEvent('gev:intel-event-selected', { detail: { layerId: id, event: entry?.event || null } }));
    return entry?.event || null;
  }

  function installClickHandler(viewer) {
    if (_clickHandler) return;
    _clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    _clickHandler.setInputAction((click) => {
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      if (pickedId && _byId.has(pickedId)) {
        if (pickedId !== _selectedId) selectEvent(pickedId, { fly: false });
        return;
      }
      if (_selectedId && !pickedId) selectEvent(null);
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    _clickHandler?.destroy();
    _clickHandler = null;
  }

  const layer = {
    id,
    name,
    icon,
    source,
    updateInterval: 5 * 60_000,

    init(viewer) {
      _viewer = viewer;
      _points = new Cesium.PointPrimitiveCollection();
      _points.show = false;
      viewer.scene.primitives.add(_points);
      _unsubscribe.push(indonesiaState.subscribe((_, changed) => {
        if (changed.some((key) => ['provinceCode', 'timelineHours', 'timelineUntilMs', 'typeGroups'].includes(key))) rebuild();
      }));
      _unsubscribe.push(intelClient.subscribeSweeps(() => { if (_enabled) layer.update(viewer).catch(() => {}); }));
      console.log(`[Data:${id}] Initialized`);
    },

    enable(viewer) {
      _enabled = true;
      if (_points) _points.show = true;
      registerPickOwner(id, (pickedId) => _byId.has(pickedId));
      installClickHandler(viewer);
      setOverlaySourceVisible(id, true);
      rebuild({ immediate: true });
    },

    disable() {
      _enabled = false;
      if (_points) _points.show = false;
      unregisterPickOwner(id);
      removeClickHandler();
      clearOverlaySource(id);
      setOverlaySourceVisible(id, false);
      governorRequestRender(`${id}-disable`);
    },

    async update() {
      _loading = true;
      try {
        const payload = await intelClient.getEvents({ hours: FETCH_HOURS, limit: maxPoints, types: types || undefined });
        _events = Array.isArray(payload.events) ? payload.events : [];
        _stale = Boolean(payload.stale);
        _lastError = payload.stale ? (payload.staleReason || 'stale') : null;
        _lastUpdate = Date.now();
        rebuild();
        return true;
      } catch (error) {
        _lastError = String(error.message || error);
        return false;
      } finally {
        _loading = false;
      }
    },

    destroy(viewer) {
      if (_paintHandle !== null) { cancelAnimationFrame(_paintHandle); _paintHandle = null; }
      _paintPending = false;
      layer.disable();
      for (const off of _unsubscribe) off();
      _unsubscribe = [];
      if (_points) {
        viewer.scene.primitives.remove(_points);
        _points = null;
      }
      _events = [];
      _visible = [];
      _byId = new Map();
      _viewer = null;
    },

    getStats() {
      return {
        count: _visible.length,
        total: _events.length,
        lastUpdate: _lastUpdate,
        loading: _loading,
        error: _lastError && !_events.length ? _lastError : null,
        stale: _stale,
        status: _lastError && !_events.length ? 'unavailable' : undefined,
        source,
      };
    },

    /** Plain records for the voice analyst and the GIS panel. */
    getAnalystRecords(maxCount = 2000) {
      return _visible.slice(0, maxCount).map((event) => ({
        id: event.id, type: event.type, subtype: event.subtype, title: event.title, severity: event.severity, status: event.status,
        timestamp: event.timestamp, lat: event.location?.lat ?? null, lon: event.location?.lon ?? null,
        province: event.province, city: event.city, magnitude: event.magnitude ?? null, source: event.source,
      }));
    },

    /** All cached events (before view filters) — the drawer lists these. */
    getEvents: () => _events.filter(accepts),
    getVisibleEvents: () => _visible,
    selectEvent,
    getSelectedId: () => _selectedId,
    refreshNow: (viewer) => layer.update(viewer || _viewer),
  };
  return layer;
}

export const indonesiaEventsLayer = createIntelEventsLayer({
  id: 'id-events',
  name: 'Indonesia Signals',
  icon: '🇮🇩',
  source: 'BMKG · BNPB · PVMBG · USGS',
});

export const indonesiaNewsLayer = createIntelEventsLayer({
  id: 'id-news',
  name: 'Indonesia News',
  icon: '📰',
  source: 'GDELT',
  newsOnly: true,
  labelLimit: 40,
  maxPoints: 800,
});

export default [indonesiaEventsLayer, indonesiaNewsLayer];
