/**
 * @module gis/mapModeController
 *
 * Switches between the Cesium 3D globe and the MapLibre GIS map without
 * losing the location: the camera's ground centre and height become a
 * centre/zoom pair and back. While the GIS map is shown the Cesium render
 * loop is paused (nothing is drawn behind an opaque map), exactly like the
 * app already does for a hidden tab.
 *
 * The seam follows GeoLibre's engine-neutral idea: both views expose
 * getView()/applyView() and the controller only talks through those.
 */

import * as Cesium from 'cesium';
import { viewCenter } from '../indonesia/indonesiaCamera.js';

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const CESIUM_DEFAULT_FOVY_RAD = Math.PI / 3;

/** Cesium camera height (m) above the ground centre → Web Mercator zoom for a canvas of `heightPx`. */
export function heightToZoom(heightM, latDeg, heightPx, fovyRad = CESIUM_DEFAULT_FOVY_RAD) {
  const visibleM = 2 * Math.max(1, heightM) * Math.tan(fovyRad / 2);
  const metersPerPixel = visibleM / Math.max(1, heightPx);
  const zoom = Math.log2((EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (metersPerPixel * 512));
  return Math.max(0, Math.min(20, zoom));
}

/** Inverse of heightToZoom. */
export function zoomToHeight(zoom, latDeg, heightPx, fovyRad = CESIUM_DEFAULT_FOVY_RAD) {
  const metersPerPixel = (EARTH_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (512 * 2 ** zoom);
  const visibleM = metersPerPixel * Math.max(1, heightPx);
  return Math.max(200, visibleM / (2 * Math.tan(fovyRad / 2)));
}

export function createMapModeController({ viewer, gisMap, root, state, onModeChange = () => {} }) {
  let mode = '3d';
  let wasRenderLoopOn = true;

  function to3dView() {
    const view = gisMap.getView();
    const heightPx = viewer.scene.canvas.clientHeight || 900;
    const heightM = zoomToHeight(view.zoom, view.lat, heightPx);
    // A tilted GIS view becomes a tilted globe view; a flat one looks straight down.
    const pitchDeg = -90 + Math.min(70, Math.max(0, view.pitch || 0));
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(view.lon, view.lat, heightM),
      orientation: { heading: Cesium.Math.toRadians(view.bearing || 0), pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
    });
  }

  function toGisView() {
    const center = viewCenter(viewer);
    const heightPx = viewer.scene.canvas.clientHeight || 900;
    gisMap.applyView({
      lat: center.lat,
      lon: center.lon,
      zoom: heightToZoom(center.heightM, center.lat, heightPx),
      bearing: center.headingDeg,
      pitch: Math.max(0, Math.min(60, 90 + center.pitchDeg)),
    });
  }

  async function setMode(nextMode) {
    const target = nextMode === 'gis' ? 'gis' : '3d';
    if (target === mode) return mode;
    if (target === 'gis') {
      await gisMap.ensureReady();
      toGisView();
      root.hidden = false;
      document.body.classList.add('gis-mode');
      wasRenderLoopOn = viewer.useDefaultRenderLoop;
      viewer.useDefaultRenderLoop = false;
      gisMap.resize();
    } else {
      to3dView();
      root.hidden = true;
      document.body.classList.remove('gis-mode');
      viewer.useDefaultRenderLoop = wasRenderLoopOn || !document.hidden;
      viewer.scene.requestRender();
    }
    mode = target;
    state?.set({ mapMode: mode });
    onModeChange(mode);
    return mode;
  }

  return {
    getMode: () => mode,
    setMode,
    toggle: () => setMode(mode === 'gis' ? '3d' : 'gis'),
  };
}
