import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeIndonesiaShareState, encodeIndonesiaShareState } from './indonesiaState.js';

test('share token carries mode, province, and GIS flag and round-trips', () => {
  assert.equal(encodeIndonesiaShareState({ enabled: true, provinceCode: '32', mapMode: 'gis' }), 'm.1_p.32_g.1');
  assert.equal(encodeIndonesiaShareState({ enabled: false, provinceCode: null, mapMode: '3d' }), 'm.0');
  assert.deepEqual(decodeIndonesiaShareState('m.1_p.32_g.1'), { enabled: true, provinceCode: '32', mapMode: 'gis' });
  assert.deepEqual(decodeIndonesiaShareState('m.0'), { enabled: false });
});

test('session preferences stay out of the token and malformed pieces are ignored', () => {
  assert.equal(encodeIndonesiaShareState({ enabled: true, timelineHours: 6, typeGroups: ['fire'], provinceCode: 'XX' }), 'm.1');
  assert.deepEqual(decodeIndonesiaShareState('m.1_p.abc_g.2_zz.9_p.3.1'), { enabled: true });
  assert.equal(decodeIndonesiaShareState(''), null);
  assert.equal(decodeIndonesiaShareState('nonsense'), null);
  assert.equal(decodeIndonesiaShareState(null), null);
});
