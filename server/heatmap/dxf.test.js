// dxf.test.js — plain Node assertion script (no framework yet, see CLAUDE.md).
// Guards against the "raw MTEXT formatting codes leak onto the wall canvas" bug:
// asserts TEXT/MTEXT/DIMENSION entities never contribute wall segments, and
// that MTEXT formatting codes are stripped before use as a label/point key.

const assert = require('assert');
const path = require('path');
const { parseDxf, stripMtextFormatting } = require('./dxf');

const fixture = path.join(__dirname, '__fixtures__', 'text-entities.dxf');
const parsed = parseDxf(fixture);

assert.strictEqual(parsed.wallSegments.length, 1, `expected exactly 1 wall segment (the LINE on A_WALL), got ${parsed.wallSegments.length}`);
assert.deepStrictEqual(parsed.wallSegments[0], [0, 0, 100, 0], 'wall segment should match the LINE entity coordinates');

// TEXT/MTEXT/DIMENSION layers must never contribute wall geometry, even if
// their layer name happened to be added to the wall allowlist by mistake.
const textOnlyParsed = parseDxf(fixture, { wallLayers: ['A_TEXT', 'GRID NAMES', 'A_DIM'] });
assert.strictEqual(textOnlyParsed.wallSegments.length, 0, 'TEXT/MTEXT/DIMENSION entities must never produce wall segments');

// Grid-name point key must be decoded plain text, not raw MTEXT formatting codes.
const pointKeys = Object.keys(parsed.points);
assert.ok(pointKeys.includes('A1'), `expected decoded grid name "A1" among point keys, got ${JSON.stringify(pointKeys)}`);
assert.ok(!pointKeys.some(k => k.includes('\\f') || k.includes('{')), 'point keys must never contain raw MTEXT formatting codes');

assert.strictEqual(stripMtextFormatting('{\\fArial|b0|i0|c177|p34;A1}'), 'A1');
assert.strictEqual(stripMtextFormatting('plain text'), 'plain text');
assert.strictEqual(stripMtextFormatting(''), '');

// layerDetails should report entity counts per layer for the UI layer picker.
const wallLayerDetail = parsed.layerDetails.find(l => l.name === 'A_WALL');
assert.ok(wallLayerDetail, 'A_WALL should appear in layerDetails');
assert.strictEqual(wallLayerDetail.entityCount, 1);
assert.strictEqual(wallLayerDetail.isWallLayer, true);

const textLayerDetail = parsed.layerDetails.find(l => l.name === 'A_TEXT');
assert.ok(textLayerDetail, 'A_TEXT should appear in layerDetails');
assert.strictEqual(textLayerDetail.isWallLayer, false);

console.log('dxf.test.js: all assertions passed');
