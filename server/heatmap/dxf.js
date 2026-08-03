/**
 * server/heatmap/dxf.js
 * Port of heatmap.py's parse_dxf / _collect_lines_from_entity, using the
 * `dxf-parser` npm package instead of ezdxf.
 *
 * Preserves: wall layer allowlist, grid-point/grid-name layers, nearest-match
 * of grid names to grid points.
 */

const fs = require('fs');
const DxfParser = require('dxf-parser');

const WALL_LAYERS = new Set([
  'A_WALL', 'A_WALL_PRTN', 'A_WALL_CMU', 'A_WALL_WOOD',
  'A_WALL_STON', 'A_WALL_CRM', 'A_WALL_EXIST',
  'A_WALL_PAHT', 'A_WALL_STON_COR',
  'WALLS NEW',
]);

const GRID_POINT_LAYERS = new Set(['GRID POINTS', 'GRID OUTSIDE POINT']);
const GRID_NAME_LAYERS = new Set(['GRID NAMES', 'OUTSIDE NAMES GRID']);

/**
 * Strip DXF/MTEXT RTF-style formatting codes (e.g. "{\fArial|b0|i0|c177|p34;text}")
 * down to plain text, so UI code never has to render raw formatting codes.
 */
function stripMtextFormatting(str) {
  if (!str) return '';
  let out = String(str);
  // Drop "{...;" formatting-group prefixes, keep trailing text, then strip closing "}"
  out = out.replace(/\{\\[^;{}]*;/g, '').replace(/[{}]/g, '');
  // MTEXT paragraph/line breaks
  out = out.replace(/\\P/g, '\n');
  // Any remaining inline control codes like \fArial|b0|i0;
  out = out.replace(/\\[A-Za-z][^;\\]*;/g, '');
  return out.trim();
}

/**
 * Yield [x0,y0,x1,y1] segments from LINE, LWPOLYLINE, POLYLINE, ARC entities.
 * Mirrors heatmap.py's _collect_lines_from_entity.
 */
function collectLinesFromEntity(entity) {
  const segments = [];
  const type = entity.type;

  if (type === 'LINE') {
    const v = entity.vertices;
    if (v && v.length >= 2) {
      segments.push([v[0].x, v[0].y, v[1].x, v[1].y]);
    } else if (entity.start && entity.end) {
      segments.push([entity.start.x, entity.start.y, entity.end.x, entity.end.y]);
    }
  } else if (type === 'ARC' || type === 'CIRCLE') {
    if (type === 'ARC') {
      const cx = entity.center.x, cy = entity.center.y, r = entity.radius;
      let a0 = (entity.startAngle || 0) * Math.PI / 180;
      let a1 = (entity.endAngle || 0) * Math.PI / 180;
      if (a1 <= a0) a1 += 2 * Math.PI;
      const n = Math.max(8, Math.floor((a1 - a0) * r / 50));
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * i / n;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      for (let i = 0; i < pts.length - 1; i++) {
        segments.push([pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]]);
      }
    }
  } else if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
    const verts = entity.vertices || [];
    for (let i = 0; i < verts.length - 1; i++) {
      segments.push([verts[i].x, verts[i].y, verts[i + 1].x, verts[i + 1].y]);
    }
    if (entity.shape && verts.length > 1) {
      // dxf-parser marks closed polylines via `shape` (LWPOLYLINE) or `closed` (POLYLINE)
      segments.push([verts[verts.length - 1].x, verts[verts.length - 1].y, verts[0].x, verts[0].y]);
    } else if (entity.closed && verts.length > 1) {
      segments.push([verts[verts.length - 1].x, verts[verts.length - 1].y, verts[0].x, verts[0].y]);
    }
  }

  return segments;
}

/**
 * Parse a DXF file (or buffer/string content).
 * @param {string} dxfPathOrContent - path to a .dxf file
 * @returns {{wallSegments: Array<[number,number,number,number]>, points: Object<string,[number,number]>, wallLayers: string[], allLayers: string[]}}
 */
function parseDxf(dxfPathOrContent, opts = {}) {
  const content = opts.isContent
    ? dxfPathOrContent
    : fs.readFileSync(dxfPathOrContent, 'utf-8');

  const parser = new DxfParser();
  const dxf = parser.parseSync(content);

  const wallSegments = [];
  const gridPoints = []; // [x, y]
  const gridNames = [];  // [code, x, y]
  const layersSeen = new Set();
  const layerStats = new Map(); // layer -> { entityCount, entityTypes: {type: count} }

  const wallLayerOverride = opts.wallLayers ? new Set(opts.wallLayers) : WALL_LAYERS;

  const entities = (dxf && dxf.entities) || [];

  for (const entity of entities) {
    const layer = entity.layer || '0';
    layersSeen.add(layer);

    if (!layerStats.has(layer)) layerStats.set(layer, { entityCount: 0, entityTypes: {} });
    const stats = layerStats.get(layer);
    stats.entityCount += 1;
    stats.entityTypes[entity.type] = (stats.entityTypes[entity.type] || 0) + 1;

    if (wallLayerOverride.has(layer) && ['LINE', 'LWPOLYLINE', 'POLYLINE', 'ARC', 'CIRCLE'].includes(entity.type)) {
      wallSegments.push(...collectLinesFromEntity(entity));
    }

    if (GRID_POINT_LAYERS.has(layer) && entity.type === 'POINT') {
      const pos = entity.position || entity.vertices?.[0];
      if (pos) gridPoints.push([pos.x, pos.y]);
    }

    if (GRID_NAME_LAYERS.has(layer) && entity.type === 'MTEXT') {
      const code = stripMtextFormatting(entity.text || '');
      const ins = entity.position || { x: 0, y: 0 };
      if (code) gridNames.push([code, ins.x, ins.y]);
    }
  }

  const layerDetails = [...layersSeen].map(name => {
    const stats = layerStats.get(name) || { entityCount: 0, entityTypes: {} };
    return {
      name,
      entityCount: stats.entityCount,
      entityTypes: stats.entityTypes,
      isWallLayer: wallLayerOverride.has(name),
    };
  });

  // Nearest-match each grid name to the nearest grid point (mirrors heatmap.py)
  const points = {};
  if (gridPoints.length && gridNames.length) {
    for (const [code, nx, ny] of gridNames) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < gridPoints.length; i++) {
        const dx = gridPoints[i][0] - nx;
        const dy = gridPoints[i][1] - ny;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      points[code] = [gridPoints[bestIdx][0], gridPoints[bestIdx][1]];
    }
  }

  return {
    wallSegments,
    points,
    wallLayers: [...wallLayerOverride],
    allLayers: [...layersSeen],
    layerDetails,
  };
}

module.exports = {
  parseDxf, WALL_LAYERS, GRID_POINT_LAYERS, GRID_NAME_LAYERS,
  collectLinesFromEntity, stripMtextFormatting,
};
