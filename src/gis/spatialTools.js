/**
 * @module gis/spatialTools
 *
 * The spatial analysis toolbox behind the GIS panel and the voice tools.
 * Pure functions over GeoJSON (Turf, MIT), so every operation is unit-tested
 * without a map. Tool semantics follow GeoLibre's vector toolbox (buffer,
 * centroid, intersection, union, select by location); the code is this
 * application's own.
 */

import buffer from '@turf/buffer';
import distance from '@turf/distance';
import bearing from '@turf/bearing';
import area from '@turf/area';
import length from '@turf/length';
import centroid from '@turf/centroid';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import nearestPoint from '@turf/nearest-point';
import bbox from '@turf/bbox';
import intersect from '@turf/intersect';
import union from '@turf/union';
import { point, polygon, featureCollection, lineString } from '@turf/helpers';

const isFeature = (value) => value && value.type === 'Feature' && value.geometry;
const asPoint = (value) => {
  if (isFeature(value) && value.geometry.type === 'Point') return value;
  if (Array.isArray(value) && value.length >= 2) return point([Number(value[0]), Number(value[1])]);
  if (value && Number.isFinite(value.lon) && Number.isFinite(value.lat)) return point([value.lon, value.lat]);
  throw new TypeError('Expected a point feature, [lon, lat], or {lat, lon}');
};
const asPolygon = (value) => {
  if (isFeature(value) && /^(Multi)?Polygon$/.test(value.geometry.type)) return value;
  if (value && /^(Multi)?Polygon$/.test(value.type)) return { type: 'Feature', properties: {}, geometry: value };
  throw new TypeError('Expected a (Multi)Polygon feature or geometry');
};

/** Buffer a point, line, or polygon by `km`. */
export function bufferKm(feature, km) {
  const radius = Number(km);
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('Buffer radius must be a positive number of kilometres');
  const input = isFeature(feature) ? feature : asPoint(feature);
  const result = buffer(input, radius, { units: 'kilometers' });
  if (!result) throw new Error('Buffer produced no geometry');
  result.properties = { ...(input.properties || {}), tool: 'buffer', radiusKm: radius };
  return result;
}

/** Great-circle distance in kilometres between two points. */
export function distanceKm(from, to) {
  return distance(asPoint(from), asPoint(to), { units: 'kilometers' });
}

/** Initial bearing in degrees (0–360) from `from` to `to`. */
export function bearingDeg(from, to) {
  const value = bearing(asPoint(from), asPoint(to));
  return (value + 360) % 360;
}

/** Area of a polygon in km². */
export function areaKm2(feature) {
  return area(asPolygon(feature)) / 1_000_000;
}

/** Perimeter of a polygon (or length of a line) in km. */
export function perimeterKm(feature) {
  const input = isFeature(feature) ? feature : { type: 'Feature', properties: {}, geometry: feature };
  return length(input, { units: 'kilometers' });
}

/** Centroid as { lat, lon }. */
export function centroidOf(feature) {
  const [lon, lat] = centroid(isFeature(feature) ? feature : { type: 'Feature', properties: {}, geometry: feature }).geometry.coordinates;
  return { lat, lon };
}

/** Point-in-polygon. */
export function pointInPolygon(pt, poly) {
  return booleanPointInPolygon(asPoint(pt), asPolygon(poly));
}

/** Bounding box [west, south, east, north] of one feature or a collection. */
export function bboxOf(features) {
  return bbox(Array.isArray(features) ? featureCollection(features) : features);
}

/** Intersection of two polygons, or null when they do not overlap. */
export function intersectPolygons(a, b) {
  return intersect(featureCollection([asPolygon(a), asPolygon(b)])) || null;
}

/** Union of two or more polygons. */
export function unionPolygons(...polygons) {
  const features = polygons.flat().map(asPolygon);
  if (features.length === 1) return features[0];
  return union(featureCollection(features));
}

/** Nearest feature (points) to a reference point, with distance in km. */
export function nearestFeature(reference, features) {
  const points = (Array.isArray(features) ? features : features?.features || [])
    .filter((feature) => isFeature(feature) && feature.geometry.type === 'Point');
  if (!points.length) return null;
  const nearest = nearestPoint(asPoint(reference), featureCollection(points));
  return { feature: points[nearest.properties.featureIndex], distanceKm: nearest.properties.distanceToPoint };
}

/** Events (with `location`) inside a polygon. */
export function eventsWithinPolygon(events, poly) {
  const target = asPolygon(poly);
  return (events || []).filter((event) => event?.location && booleanPointInPolygon(point([event.location.lon, event.location.lat]), target));
}

/** Events within `km` of a center, annotated with `distanceKm`, nearest first. */
export function eventsWithinRadius(events, center, km) {
  const origin = asPoint(center);
  const radius = Number(km);
  return (events || [])
    .filter((event) => event?.location)
    .map((event) => ({ ...event, distanceKm: distance(origin, point([event.location.lon, event.location.lat]), { units: 'kilometers' }) }))
    .filter((event) => event.distanceKm <= radius)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** Count how many point features fall inside each polygon of a collection. */
export function countPointsByPolygon(points, polygons, { key = 'name' } = {}) {
  const counts = [];
  for (const poly of Array.isArray(polygons) ? polygons : polygons?.features || []) {
    if (!isFeature(poly) || !/^(Multi)?Polygon$/.test(poly.geometry.type)) continue;
    let count = 0;
    for (const pt of points) {
      const feature = isFeature(pt) ? pt : asPoint(pt);
      if (booleanPointInPolygon(feature, poly)) count += 1;
    }
    counts.push({ key: poly.properties?.[key] ?? null, count, feature: poly });
  }
  return counts.sort((a, b) => b.count - a.count);
}

/** Attribute filter: op ∈ =, !=, >, >=, <, <=, contains. */
export function filterByAttribute(features, field, op, value) {
  const test = {
    '=': (a) => a == value, // eslint-disable-line eqeqeq
    '!=': (a) => a != value, // eslint-disable-line eqeqeq
    '>': (a) => Number(a) > Number(value),
    '>=': (a) => Number(a) >= Number(value),
    '<': (a) => Number(a) < Number(value),
    '<=': (a) => Number(a) <= Number(value),
    contains: (a) => String(a ?? '').toLowerCase().includes(String(value).toLowerCase()),
  }[op];
  if (!test) throw new RangeError(`Unknown operator ${op}`);
  return (features || []).filter((feature) => test(feature?.properties?.[field]));
}

/** Events → GeoJSON FeatureCollection (attribution preserved per feature). */
export function eventsToGeoJson(events) {
  return featureCollection((events || []).filter((event) => event?.location).map((event) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [event.location.lon, event.location.lat] },
    properties: {
      id: event.id, type: event.type, subtype: event.subtype, title: event.title, severity: event.severity, status: event.status,
      timestamp: event.timestamp, source: event.source, sourceUrl: event.sourceUrl, province: event.province, city: event.city,
      magnitude: event.magnitude ?? null, attribution: event.attribution,
    },
  })));
}

/** Events → CSV text (RFC 4180 quoting). */
export function eventsToCsv(events) {
  const columns = ['id', 'type', 'subtype', 'title', 'severity', 'status', 'timestamp', 'lat', 'lon', 'province', 'city', 'magnitude', 'source', 'sourceUrl', 'attribution'];
  const quote = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = (events || []).map((event) => columns.map((column) => {
    if (column === 'lat') return event.location?.lat ?? '';
    if (column === 'lon') return event.location?.lon ?? '';
    return event[column] ?? '';
  }).map(quote).join(','));
  return [columns.join(','), ...rows].join('\n');
}

/** Decimal degrees → DMS text. */
export function toDms(lat, lon) {
  const part = (value, pos, neg) => {
    const abs = Math.abs(value);
    const deg = Math.floor(abs);
    const min = Math.floor((abs - deg) * 60);
    const sec = ((abs - deg - min / 60) * 3600).toFixed(1);
    return `${deg}°${String(min).padStart(2, '0')}'${sec}"${value >= 0 ? pos : neg}`;
  };
  return `${part(lat, 'N', 'S')} ${part(lon, 'E', 'W')}`;
}

/** Line between two points (for measurement rendering). */
export function measurementLine(from, to) {
  const a = asPoint(from).geometry.coordinates;
  const b = asPoint(to).geometry.coordinates;
  return lineString([a, b], { tool: 'measure', distanceKm: distanceKm(from, to), bearingDeg: bearingDeg(from, to) });
}

export { point as makePoint, polygon as makePolygon, featureCollection as makeCollection };
