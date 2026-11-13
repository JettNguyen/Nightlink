import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cornerFlags } from './statusCorner.js';

const none = { statusCorner: false, cameraCorner: false, tabRow: false, tabsBesideClock: false, rowInset: 0 };

test('a phone with a Dynamic Island gets no flag', () => {
  assert.deepEqual(cornerFlags({ top: 62, sides: 0, width: 402 }), none);
});

test('the open Duo upright gets its clock corner', () => {
  assert.deepEqual(cornerFlags({ top: 82, sides: 0, width: 951 }), { ...none, statusCorner: true });
});

test('the folded Duo gets its camera corner', () => {
  assert.deepEqual(cornerFlags({ top: 0, sides: 62, width: 420 }), { ...none, cameraCorner: true });
});

test('an iPad with its tabs across the top gets the tab row, not the Duo corner', () => {
  assert.deepEqual(cornerFlags({ top: 96, sides: 0, width: 1032, ipad: true }), { ...none, tabRow: true, rowInset: 96 });
});

test('an iPad held sideways, with its tabs beside the clock, says so', () => {
  assert.deepEqual(
    cornerFlags({ top: 74, sides: 0, width: 1376, ipad: true }),
    { ...none, tabRow: true, tabsBesideClock: true, rowInset: 74 },
  );
});

test('an iPad with its tabs at the bottom or none showing gets no flag', () => {
  assert.deepEqual(cornerFlags({ top: 32, sides: 0, width: 507, ipad: true }), none);
  assert.deepEqual(cornerFlags({ top: 24, sides: 0, width: 1032, ipad: true }), none);
});

test('a sheet hiding the tabs keeps the tab row it had, at the inset it had', () => {
  assert.deepEqual(
    cornerFlags({ top: 32, sides: 0, width: 1032, ipad: true, tabsCovered: true, keptInset: 96 }),
    { ...none, tabRow: true, rowInset: 96 },
  );
  assert.deepEqual(
    cornerFlags({ top: 32, sides: 0, width: 1376, ipad: true, tabsCovered: true, keptInset: 74 }),
    { ...none, tabRow: true, tabsBesideClock: true, rowInset: 74 },
  );
});

test('a sheet does not make a tab row where there was none', () => {
  assert.deepEqual(
    cornerFlags({ top: 32, sides: 0, width: 507, ipad: true, tabsCovered: true, keptInset: 0 }),
    none,
  );
});

test('the tab row ends when the sheet closes and the tabs stay down', () => {
  assert.deepEqual(
    cornerFlags({ top: 32, sides: 0, width: 507, ipad: true, tabsCovered: false, keptInset: 96 }),
    none,
  );
});

test('only an iPad holds on to a tab row', () => {
  assert.deepEqual(
    cornerFlags({ top: 62, sides: 0, width: 402, tabsCovered: true, keptInset: 96 }),
    none,
  );
});
