/**
 * @module indonesia/indonesiaCamera
 *
 * Camera helpers for Indonesia mode: the archipelago-wide default view,
 * province and city flights, and the view-centre read used by the GIS bridge
 * and the weather lookup.
 */

import * as Cesium from 'cesium';

/** Whole-archipelago view: Sabang to Merauke in one frame. */
export const INDONESIA_RECTANGLE = Object.freeze([95, -11, 141, 6]);

/** Cinematic first flight: start high over the archipelago, settle on the full extent. */
export function flyToIndonesia(viewer, { duration = 3.5 } = {}) {
  const [west, south, east, north] = INDONESIA_RECTANGLE;
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(118, -2.5, 14_000_000),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
  });
  setTimeout(() => {
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
      duration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 400);
}

/** Fly to a province by its bbox (falls back to the capital). */
export function flyToProvince(viewer, province, { duration = 2.5 } = {}) {
  if (!viewer || !province) return false;
  if (Array.isArray(province.bbox) && province.bbox.length === 4) {
    const [west, south, east, north] = province.bbox;
    const padLon = Math.max(0.15, (east - west) * 0.08);
    const padLat = Math.max(0.15, (north - south) * 0.08);
    viewer.camera.flyTo({
      destination: Cesium.Rectangle.fromDegrees(west - padLon, south - padLat, east + padLon, north + padLat),
      duration,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
    return true;
  }
  if (Number.isFinite(province.lat) && Number.isFinite(province.lon)) {
    flyToPoint(viewer, province.lat, province.lon, { heightM: 400_000, duration });
    return true;
  }
  return false;
}

/** Fly to a point at a given height (metres) with a tilted or top-down view. */
export function flyToPoint(viewer, lat, lon, { heightM = 40_000, pitchDeg = -55, headingDeg = 0, duration = 2.2 } = {}) {
  if (!viewer || !Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightM),
    orientation: { heading: Cesium.Math.toRadians(headingDeg), pitch: Cesium.Math.toRadians(pitchDeg), roll: 0 },
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
  return true;
}

/** Suggested fly-to height for an event type (metres). */
export function heightForEventType(type) {
  return { earthquake: 180_000, tsunami: 300_000, volcano: 45_000, weather: 60_000, news: 80_000, flood: 50_000, landslide: 30_000, fire: 60_000 }[type] || 60_000;
}

/**
 * Ground point under the screen centre: the ellipsoid pick (works with the
 * globe hidden under photoreal tiles), else the camera's own position.
 * @returns {{lat:number, lon:number, heightM:number, headingDeg:number, pitchDeg:number}}
 */
export function viewCenter(viewer) {
  const canvas = viewer.scene.canvas;
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const camera = viewer.camera;
  const cartographic = camera.positionCartographic;
  let lat = Cesium.Math.toDegrees(cartographic.latitude);
  let lon = Cesium.Math.toDegrees(cartographic.longitude);
  let heightM = cartographic.height;
  const picked = camera.pickEllipsoid(center, viewer.scene.globe.ellipsoid);
  if (picked) {
    const pickedCarto = Cesium.Cartographic.fromCartesian(picked);
    lat = Cesium.Math.toDegrees(pickedCarto.latitude);
    lon = Cesium.Math.toDegrees(pickedCarto.longitude);
    heightM = Cesium.Cartesian3.distance(camera.positionWC, picked);
  }
  return {
    lat, lon, heightM,
    headingDeg: Cesium.Math.toDegrees(camera.heading),
    pitchDeg: Cesium.Math.toDegrees(camera.pitch),
  };
}
