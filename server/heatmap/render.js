/**
 * server/heatmap/render.js
 * Renders just the interpolated heat field as a PNG whose pixel grid is 1:1
 * aligned (in aspect ratio) with `bounds` — no title, legend, walls, or point
 * markers baked in. The frontend (public/map-view.js) already draws walls and
 * placed-photo markers itself and stretches this image directly into the
 * world-bounds box, so any chrome or letterboxing here would misalign it.
 * The color scale (CMAPS.affect_rwg) is mirrored in public/map-view.js for
 * the on-screen legend — keep both in sync if it changes.
 *
 * Uses a fixed red/yellow/green diverging colormap (negative/neutral/positive)
 * and a HEATMAP_ALPHA blend.
 */

const { createCanvas } = require('canvas');
const { rasterizeWalls, interpolateScores, GRID_RES } = require('./geodesic');

const HEATMAP_ALPHA = 0.55;

// Fixed diverging scale: negative=red, neutral=yellow, positive=green.
// Not cycled — emotion valence should always map to the same colors across runs.
const CMAPS = {
  affect_rwg: ['#d73027', '#fdae61', '#ffffbf', '#a6d96a', '#1a9850'],
};
const CMAP_CYCLE = Object.keys(CMAPS);

function nextCmapName() {
  return CMAP_CYCLE[0];
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear-interpolate a color ramp of hex stops at t in [0,1]. */
function sampleRamp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const segs = stops.length - 1;
  const pos = t * segs;
  const i = Math.min(segs - 1, Math.floor(pos));
  const localT = pos - i;
  const [r0, g0, b0] = hexToRgb(stops[i]);
  const [r1, g1, b1] = hexToRgb(stops[i + 1]);
  return [
    Math.round(r0 + (r1 - r0) * localT),
    Math.round(g0 + (g1 - g0) * localT),
    Math.round(b0 + (b1 - b0) * localT),
  ];
}

function getBounds(wallSegments, measurementPoints, padding = 500) {
  let xs = [], ys = [];
  for (const [x0, y0, x1, y1] of wallSegments) {
    xs.push(x0, x1);
    ys.push(y0, y1);
  }
  for (const code of Object.keys(measurementPoints || {})) {
    const [x, y] = measurementPoints[code];
    xs.push(x);
    ys.push(y);
  }
  if (xs.length === 0) return [0, 0, 1000, 1000];
  return [
    Math.min(...xs) - padding,
    Math.min(...ys) - padding,
    Math.max(...xs) + padding,
    Math.max(...ys) + padding,
  ];
}

/**
 * Render just the heat field as a PNG, pixel-aligned 1:1 (in aspect ratio)
 * with `bounds`. The caller (public/map-view.js) stretches this directly
 * into the on-screen box for `bounds`, and draws walls/points itself.
 * @param {object} opts
 * @param {Array<[number,number,number,number]>} opts.wallSegments
 * @param {Object<string,[number,number]>} opts.measurementPoints {code: [x,y]}
 * @param {Object<string,number>} opts.scores {code: score}
 * @param {[number,number,number,number]} [opts.bounds]
 * @param {number} [opts.vmin]
 * @param {number} [opts.vmax]
 * @param {string} [opts.cmap] cmap name; defaults to run-counter cycling
 * @returns {Buffer} PNG buffer, or null if no data
 */
function renderHeatmap(opts) {
  const { wallSegments, measurementPoints, scores, vmin: vminIn, vmax: vmaxIn } = opts;

  const res = GRID_RES;
  const bounds = opts.bounds || getBounds(wallSegments, measurementPoints);
  const [xmin, ymin] = bounds;

  const { grid, W, H } = rasterizeWalls(wallSegments, bounds, res);

  const available = Object.keys(measurementPoints).filter(
    c => scores[c] !== undefined && scores[c] !== null && !Number.isNaN(scores[c])
  );
  if (available.length === 0) {
    return null; // [skip] no data
  }

  const measPx = [];
  const vals = [];
  for (const code of available) {
    const [x, y] = measurementPoints[code];
    const col = Math.floor((x - xmin) / res);
    const row = Math.floor((y - ymin) / res);
    if (row >= 0 && row < H && col >= 0 && col < W) {
      measPx.push([row, col]);
      vals.push(scores[code]);
    }
  }
  if (measPx.length === 0) return null; // [skip] all out of bounds

  const heat = interpolateScores(grid, W, H, measPx, vals);

  let vmin = vminIn, vmax = vmaxIn;
  if (vmin === undefined || vmax === undefined || vmin === null || vmax === null) {
    let lo = Infinity, hi = -Infinity;
    for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === hi) { lo -= 0.5; hi += 0.5; }
    vmin = vmin ?? lo;
    vmax = vmax ?? hi;
  }

  const cmapName = opts.cmap || nextCmapName();
  const ramp = CMAPS[cmapName] || CMAPS.affect_rwg;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(W, H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const idx = row * W + col;
      const v = heat[idx];
      const outRow = H - 1 - row; // flip vertically (origin upper)
      const outIdx = (outRow * W + col) * 4;
      if (Number.isNaN(v)) {
        imgData.data[outIdx + 3] = 0; // fully transparent outside the walkable area
        continue;
      }
      const t = (v - vmin) / (vmax - vmin || 1);
      const [r, g, b] = sampleRamp(ramp, t);
      imgData.data[outIdx] = r;
      imgData.data[outIdx + 1] = g;
      imgData.data[outIdx + 2] = b;
      imgData.data[outIdx + 3] = Math.round(255 * HEATMAP_ALPHA);
    }
  }
  ctx.putImageData(imgData, 0, 0);

  return canvas.toBuffer('image/png');
}

module.exports = { renderHeatmap, getBounds, CMAPS, CMAP_CYCLE };
