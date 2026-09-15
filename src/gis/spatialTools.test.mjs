import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bufferKm, distanceKm, bearingDeg, areaKm2, perimeterKm, centroidOf, pointInPolygon, bboxOf,
  intersectPolygons, unionPolygons, nearestFeature, eventsWithinPolygon, eventsWithinRadius,
  countPointsByPolygon, filterByAttribute, eventsToGeoJson, eventsToCsv, toDms, measurementLine, makePoint, makePolygon,
} from './spatialTools.js';

const JAKARTA = { lat: -6.2088, lon: 106.8456 };
const BANDUNG = { lat: -6.9175, lon: 107.6191 };
const square = makePolygon([[[106, -7], [108, -7], [108, -5], [106, -5], [106, -7]]], { name: 'Box A' });
const overlapping = makePolygon([[[107, -8], [109, -8], [109, -6], [107, -6], [107, -8]]], { name: 'Box B' });
const events = [
  { id: 'a', type: 'earthquake', title: 'A', severity: 'medium', status: 'live', timestamp: '2026-09-15T00:00:00Z', location: JAKARTA, source: 'bmkg', attribution: 'BMKG', magnitude: 5.1 },
  { id: 'b', type: 'flood', title: 'B, "quoted"', severity: 'low', status: 'delayed', timestamp: '2026-09-14T00:00:00Z', location: BANDUNG, source: 'bnpb', attribution: 'BNPB' },
  { id: 'c', type: 'news', title: 'C', severity: 'info', status: 'live', timestamp: '2026-09-14T00:00:00Z', location: { lat: 3.6, lon: 98.7 }, source: 'gdelt', attribution: 'GDELT' },
  { id: 'd', type: 'news', title: 'no location', severity: 'info', status: 'live', timestamp: '2026-09-14T00:00:00Z', location: null, source: 'gdelt', attribution: 'GDELT' },
];

test('distance, bearing, buffer, area, perimeter, centroid', () => {
  const km = distanceKm(JAKARTA, BANDUNG);
  assert.ok(km > 115 && km < 122, `Jakarta–Bandung ${km} km`);
  const brg = bearingDeg(JAKARTA, BANDUNG);
  assert.ok(brg > 125 && brg < 140, `bearing ${brg}`);
  const ring = bufferKm(JAKARTA, 10);
  assert.equal(ring.geometry.type, 'Polygon');
  assert.equal(ring.properties.radiusKm, 10);
  const ringArea = areaKm2(ring);
  assert.ok(Math.abs(ringArea - Math.PI * 100) / (Math.PI * 100) < 0.03, `area ${ringArea}`);
  assert.ok(Math.abs(perimeterKm(ring) - 2 * Math.PI * 10) < 1.5);
  const center = centroidOf(square);
  assert.ok(Math.abs(center.lat + 6) < 1e-6 && Math.abs(center.lon - 107) < 1e-6);
  assert.throws(() => bufferKm(JAKARTA, -1), RangeError);
  assert.throws(() => distanceKm('x', JAKARTA), TypeError);
});

test('point-in-polygon, bbox, intersection, union, nearest', () => {
  assert.ok(pointInPolygon(JAKARTA, square));
  assert.ok(!pointInPolygon({ lat: 0, lon: 100 }, square));
  assert.deepEqual(bboxOf(square), [106, -7, 108, -5]);
  const overlap = intersectPolygons(square, overlapping);
  assert.ok(Math.abs(areaKm2(overlap) - areaKm2(makePolygon([[[107, -7], [108, -7], [108, -6], [107, -6], [107, -7]]]))) < 1);
  assert.equal(intersectPolygons(square, makePolygon([[[120, 0], [121, 0], [121, 1], [120, 1], [120, 0]]])), null);
  const merged = unionPolygons(square, overlapping);
  assert.ok(areaKm2(merged) > areaKm2(square));
  const airports = [makePoint([106.65, -6.13], { name: 'CGK' }), makePoint([107.58, -6.9], { name: 'BDO' })];
  const nearest = nearestFeature(BANDUNG, airports);
  assert.equal(nearest.feature.properties.name, 'BDO');
  assert.ok(nearest.distanceKm < 10);
  assert.equal(nearestFeature(BANDUNG, []), null);
});

test('event selections, counts, attribute filter, and exports', () => {
  assert.deepEqual(eventsWithinPolygon(events, square).map((event) => event.id), ['a', 'b']);
  const near = eventsWithinRadius(events, JAKARTA, 50);
  assert.deepEqual(near.map((event) => event.id), ['a']);
  assert.equal(near[0].distanceKm, 0);
  const counts = countPointsByPolygon(events.filter((event) => event.location).map((event) => makePoint([event.location.lon, event.location.lat])), [square, overlapping]);
  assert.deepEqual(counts.map((row) => [row.key, row.count]), [['Box A', 2], ['Box B', 1]]);
  assert.equal(filterByAttribute([square, overlapping], 'name', 'contains', 'box b').length, 1);
  assert.equal(filterByAttribute([square, overlapping], 'name', '=', 'Box A').length, 1);
  assert.throws(() => filterByAttribute([], 'x', '~', 1), RangeError);
  const geojson = eventsToGeoJson(events);
  assert.equal(geojson.features.length, 3, 'events without a location are not exported as points');
  assert.equal(geojson.features[0].properties.attribution, 'BMKG');
  const csv = eventsToCsv(events);
  const lines = csv.split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^id,type,subtype,title/);
  assert.match(lines[2], /"B, ""quoted"""/);
  assert.match(lines[4], /no location,info,live,2026-09-14T00:00:00Z,,,/);
  assert.equal(toDms(-6.2088, 106.8456), '6°12\'31.7"S 106°50\'44.2"E');
  const line = measurementLine(JAKARTA, BANDUNG);
  assert.equal(line.geometry.coordinates.length, 2);
  assert.ok(line.properties.distanceKm > 100);
});
