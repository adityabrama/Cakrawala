import { test } from 'node:test';
import assert from 'node:assert/strict';

import { heightToZoom, zoomToHeight } from './mapModeController.js';

test('height ↔ zoom conversion round-trips and behaves sensibly at the equator', () => {
  const heightPx = 1000;
  const zoomAt100km = heightToZoom(100_000, -6.2, heightPx);
  // A camera 100 km up with a 60° vertical FOV sees ~115 km of ground on a
  // 1000 px canvas: Web Mercator zoom ≈ 9.4 at 512 px tiles.
  assert.ok(zoomAt100km > 9 && zoomAt100km < 10, `100 km camera ≈ regional zoom, got ${zoomAt100km}`);
  const zoomAt1km = heightToZoom(1_000, -6.2, heightPx);
  assert.ok(zoomAt1km > 15.5 && zoomAt1km < 16.5, `1 km camera ≈ street zoom, got ${zoomAt1km}`);
  for (const heightM of [500, 5_000, 50_000, 500_000, 5_000_000]) {
    const back = zoomToHeight(heightToZoom(heightM, -2.5, heightPx), -2.5, heightPx);
    assert.ok(Math.abs(back - heightM) / heightM < 0.01, `round trip ${heightM} → ${back}`);
  }
  assert.equal(heightToZoom(1, 0, heightPx), 20, 'zoom is clamped at 20');
  assert.equal(heightToZoom(1e9, 0, heightPx), 0, 'zoom is clamped at 0');
  assert.ok(zoomToHeight(25, 0, heightPx) >= 200, 'height floor keeps the camera above the ground');
});
