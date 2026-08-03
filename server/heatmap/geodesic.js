/**
 * server/heatmap/geodesic.js
 * Port of heatmap.py's rasterize_walls / geodesic_distances / interpolate_scores.
 * Uses typed arrays + a simple binary min-heap (dependency-free).
 */

const GRID_RES = 20; // mm per pixel, matches heatmap.py's GRID_RES
const IDW_POWER = 2;

/**
 * Binary min-heap of [dist, row, col] entries, keyed by dist.
 */
class MinHeap {
  constructor() {
    this.data = [];
  }
  get size() { return this.data.length; }
  push(item) {
    const d = this.data;
    d.push(item);
    let i = d.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (d[parent][0] <= d[i][0]) break;
      [d[parent], d[i]] = [d[i], d[parent]];
      i = parent;
    }
  }
  pop() {
    const d = this.data;
    const top = d[0];
    const last = d.pop();
    if (d.length > 0) {
      d[0] = last;
      let i = 0;
      const n = d.length;
      while (true) {
        let left = 2 * i + 1, right = 2 * i + 2, smallest = i;
        if (left < n && d[left][0] < d[smallest][0]) smallest = left;
        if (right < n && d[right][0] < d[smallest][0]) smallest = right;
        if (smallest === i) break;
        [d[i], d[smallest]] = [d[smallest], d[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/**
 * Burn wall segments into a boolean grid (Uint8Array, 1 = wall).
 * Mirrors rasterize_walls(segments, bounds, res).
 * @param {Array<[number,number,number,number]>} segments
 * @param {[number,number,number,number]} bounds [xmin, ymin, xmax, ymax]
 * @param {number} res mm per pixel
 */
function rasterizeWalls(segments, bounds, res = GRID_RES) {
  const [xmin, ymin, xmax, ymax] = bounds;
  const W = Math.ceil((xmax - xmin) / res) + 1;
  const H = Math.ceil((ymax - ymin) / res) + 1;
  const grid = new Uint8Array(W * H);

  const toPx = (x, y) => [
    Math.floor((x - xmin) / res),
    Math.floor((y - ymin) / res),
  ];

  for (const [x0, y0, x1, y1] of segments) {
    const length = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    const n = Math.max(2, Math.floor(length / res * 2));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const [px, py] = toPx(x0 + t * (x1 - x0), y0 + t * (y1 - y0));
      if (py >= 0 && py < H && px >= 0 && px < W) {
        grid[py * W + px] = 1;
      }
    }
  }

  return { grid, W, H };
}

/**
 * Dijkstra 8-connected geodesic flood fill from a source pixel over free cells.
 * Mirrors geodesic_distances(wall_grid, source_px). Returns Float64Array of
 * distances (Infinity for unreachable/walls).
 * @param {Uint8Array} grid wall grid (1=wall)
 * @param {number} W
 * @param {number} H
 * @param {[number,number]} sourcePx [row, col]
 */
function geodesicDistances(grid, W, H, sourcePx) {
  const dist = new Float64Array(W * H).fill(Infinity);
  let [r0, c0] = sourcePx;

  if (grid[r0 * W + c0]) {
    // source is on a wall — find nearest free cell in a 7x7 neighborhood
    outer:
    for (let dr = -3; dr <= 3; dr++) {
      for (let dc = -3; dc <= 3; dc++) {
        const nr = r0 + dr, nc = c0 + dc;
        if (nr >= 0 && nr < H && nc >= 0 && nc < W && !grid[nr * W + nc]) {
          r0 = nr; c0 = nc;
          break outer;
        }
      }
    }
  }

  dist[r0 * W + c0] = 0;
  const heap = new MinHeap();
  heap.push([0, r0, c0]);

  while (heap.size > 0) {
    const [d, r, c] = heap.pop();
    if (d > dist[r * W + c]) continue;

    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
        if (grid[nr * W + nc]) continue;
        const step = (dr !== 0 && dc !== 0) ? Math.SQRT2 : 1.0;
        const nd = d + step;
        const idx = nr * W + nc;
        if (nd < dist[idx]) {
          dist[idx] = nd;
          heap.push([nd, nr, nc]);
        }
      }
    }
  }

  return dist;
}

/**
 * Inverse-distance weighted interpolation using geodesic distances.
 * Mirrors interpolate_scores(wall_grid, measurement_pixels, values, power).
 * @param {Uint8Array} grid
 * @param {number} W
 * @param {number} H
 * @param {Array<[number,number]>} measurementPixels [row, col] pairs
 * @param {number[]} values
 * @param {number} power IDW exponent (default 2)
 * @returns {Float32Array} interpolated grid, NaN where no data reaches
 */
function interpolateScores(grid, W, H, measurementPixels, values, power = IDW_POWER) {
  const weightSum = new Float64Array(W * H);
  const valueSum = new Float64Array(W * H);

  for (let i = 0; i < measurementPixels.length; i++) {
    const [r, c] = measurementPixels[i];
    const v = values[i];
    const d = geodesicDistances(grid, W, H, [r, c]);

    for (let idx = 0; idx < W * H; idx++) {
      if (grid[idx]) continue; // walls excluded, like np.where(wall_grid, inf, d)
      const dd = d[idx];
      let w;
      if (dd === 0) w = 1e12;
      else if (!isFinite(dd)) w = 0;
      else w = 1 / Math.pow(dd, power);
      weightSum[idx] += w;
      valueSum[idx] += w * v;
    }
  }

  const result = new Float32Array(W * H);
  for (let idx = 0; idx < W * H; idx++) {
    result[idx] = weightSum[idx] > 0 ? valueSum[idx] / weightSum[idx] : NaN;
  }
  return result;
}

module.exports = { rasterizeWalls, geodesicDistances, interpolateScores, GRID_RES, IDW_POWER };
