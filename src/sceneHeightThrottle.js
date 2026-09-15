/**
 * @module sceneHeightThrottle
 *
 * Cesium re-reads the ground height under the camera on every frame the camera
 * moves (Scene.initializeFrame → getGlobeHeight → Scene.getHeight). With 3D-tile
 * collision enabled, each read picks the photorealistic tileset, and under
 * WebGL 2 that pick reads tile vertex buffers back from the GPU — about 1.4 s of
 * main-thread time per 10 s of camera motion with every layer on.
 *
 * This wrapper rate-limits only that camera query, the one Cesium makes without
 * a height reference. Clamped billboards, labels and ellipses always pass a
 * height reference and still get Cesium's exact answer on every call. Camera
 * collision stays on; it just reacts within CAMERA_HEIGHT_MIN_INTERVAL_MS
 * instead of every frame, and Cesium's own tile-load callback still refreshes
 * the camera ground height as finer tiles arrive.
 */

/** A camera that moved less than this since the last read reuses that height. */
export const CAMERA_HEIGHT_REUSE_MOVE_M = 5;
/** A moving camera re-reads at most this often. */
export const CAMERA_HEIGHT_MIN_INTERVAL_MS = 100;
/** Any reuse older than this is re-read, even for a camera holding still. */
export const CAMERA_HEIGHT_MAX_AGE_MS = 1000;
/** Above this ellipsoid height no terrain plus structure can reach the camera
 *  (Everest 8,849 m; the tallest building is 828 m on near-sea-level ground),
 *  so the camera query skips the tileset and asks terrain alone. */
export const TILESET_COLLISION_CEILING_M = 9000;

const MEAN_EARTH_RADIUS_M = 6371008.8;

/**
 * Horizontal distance between two cartographics (radians), small-angle form.
 * @param {{longitude:number, latitude:number}} a
 * @param {{longitude:number, latitude:number}} b
 * @returns {number} Metres.
 */
function surfaceDistanceM(a, b) {
  const dLat = b.latitude - a.latitude;
  const dLon = (b.longitude - a.longitude) * Math.cos((a.latitude + b.latitude) / 2);
  return Math.hypot(dLat, dLon) * MEAN_EARTH_RADIUS_M;
}

/**
 * Wrap `scene.getHeight` so the per-frame camera ground query is rate-limited.
 * Idempotent per scene.
 * @param {{getHeight: Function}} scene Cesium scene.
 * @param {{now?: () => number, terrainOnlyReference?: number}} [options]
 *   Clock seam for tests, and Cesium.HeightReference.CLAMP_TO_TERRAIN so a
 *   camera above TILESET_COLLISION_CEILING_M can query terrain without the tileset.
 * @returns {() => void} Restores the original method.
 */
export function throttleCameraGroundHeight(scene, { now = () => performance.now(), terrainOnlyReference } = {}) {
  if (!scene || typeof scene.getHeight !== 'function' || scene.getHeight.cameraHeightThrottled) {
    return () => {};
  }
  const original = scene.getHeight;
  let last = null;

  function getHeight(cartographic, heightReference) {
    if (heightReference !== undefined || !cartographic) {
      return original.call(this, cartographic, heightReference);
    }
    if (terrainOnlyReference !== undefined && cartographic.height > TILESET_COLLISION_CEILING_M) {
      last = null;
      return original.call(this, cartographic, terrainOnlyReference);
    }
    const at = now();
    if (last) {
      const ageMs = at - last.at;
      const reusable = ageMs < CAMERA_HEIGHT_MAX_AGE_MS
        && (ageMs < CAMERA_HEIGHT_MIN_INTERVAL_MS || surfaceDistanceM(last, cartographic) <= CAMERA_HEIGHT_REUSE_MOVE_M);
      if (reusable) return last.height;
    }
    const height = original.call(this, cartographic, heightReference);
    last = { longitude: cartographic.longitude, latitude: cartographic.latitude, height, at };
    return height;
  }
  getHeight.cameraHeightThrottled = true;
  scene.getHeight = getHeight;

  return () => {
    if (scene.getHeight === getHeight) scene.getHeight = original;
  };
}
