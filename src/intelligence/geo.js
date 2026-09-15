/**
 * @module intelligence/geo
 *
 * Small geographic helpers shared by the intelligence engine and the
 * Indonesia data pack. Dependency-free so the dev-server engine can use them.
 */

/** Indonesia's bounding envelope [west, south, east, north] with sea margin. */
export const INDONESIA_BBOX = Object.freeze([94.5, -11.5, 141.5, 6.5]);

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance in kilometres. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Whether a point lies inside a [west, south, east, north] box. */
export function bboxContains(bbox, lat, lon) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return false;
  const [west, south, east, north] = bbox;
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= south && lat <= north && lon >= west && lon <= east;
}

/** Whether a point is within Indonesia's envelope. */
export function inIndonesia(lat, lon) {
  return bboxContains(INDONESIA_BBOX, lat, lon);
}

/** Bounding box of a GeoJSON geometry (Polygon or MultiPolygon). */
export function geometryBbox(geometry) {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      const [lon, lat] = coords;
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
      return;
    }
    for (const child of coords) visit(child);
  };
  if (geometry?.coordinates) visit(geometry.coordinates);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/** Ray-casting point-in-ring test (ring = array of [lon, lat]). */
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon for GeoJSON Polygon / MultiPolygon, honouring holes. */
export function pointInGeometry(lat, lon, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === 'Polygon'
    ? [geometry.coordinates]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  for (const polygon of polygons) {
    if (!polygon?.length || !pointInRing(lat, lon, polygon[0])) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i += 1) {
      if (pointInRing(lat, lon, polygon[i])) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/** Area-weighted-ish centroid: mean of the outer ring vertices (adequate for labels). */
export function geometryCentroid(geometry) {
  const bbox = geometryBbox(geometry);
  if (!bbox) return null;
  let sumLat = 0; let sumLon = 0; let count = 0;
  const rings = geometry.type === 'Polygon'
    ? [geometry.coordinates[0]]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates.map((polygon) => polygon[0]) : [];
  for (const ring of rings) {
    for (const [lon, lat] of ring) { sumLat += lat; sumLon += lon; count += 1; }
  }
  if (!count) return null;
  return { lat: sumLat / count, lon: sumLon / count };
}

/**
 * Build a locator over a FeatureCollection of administrative areas. Each
 * feature needs `properties[codeKey]` and `properties[nameKey]`. Lookups use a
 * bbox prefilter, then exact point-in-polygon.
 */
export function createAreaLocator(featureCollection, { codeKey, nameKey }) {
  const areas = [];
  for (const feature of featureCollection?.features || []) {
    const bbox = geometryBbox(feature.geometry);
    if (!bbox) continue;
    areas.push({
      code: String(feature.properties?.[codeKey] ?? '').trim(),
      name: String(feature.properties?.[nameKey] ?? '').trim(),
      bbox,
      geometry: feature.geometry,
    });
  }
  return {
    size: areas.length,
    locate(lat, lon) {
      for (const area of areas) {
        if (!bboxContains(area.bbox, lat, lon)) continue;
        if (pointInGeometry(lat, lon, area.geometry)) return { code: area.code, name: area.name };
      }
      return null;
    },
    list() {
      return areas.map(({ code, name, bbox }) => ({ code, name, bbox }));
    },
  };
}

/** Coarse grid key for clustering (cellDeg wide cells). */
export function gridKey(lat, lon, cellDeg = 0.5) {
  return `${Math.floor(lat / cellDeg)}:${Math.floor(lon / cellDeg)}`;
}
