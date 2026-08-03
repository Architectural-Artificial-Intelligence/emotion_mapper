/**
 * converter.js
 *
 * Pipeline:
 *   1. stitchFisheyeToEquirectangular()
 *      Dual-fisheye image (two circular back-to-back lenses, side by side)
 *      → equirectangular panorama (2:1 aspect ratio)
 *
 *   2. equirectangularToPerspective()
 *      Equirectangular panorama → perspective crop at a given yaw/pitch/fov
 *
 *   3. convertImage()  ← called by index.js
 *      Runs both steps: fisheye → equirectangular → perspective PNG
 *
 *   4. stitchToPanorama()  ← optional helper / debug
 *      Runs only step 1 and saves the equirectangular PNG to disk
 */

const fs = require('fs');
const sharp = require('sharp');

// ─────────────────────────────────────────────────────────────────────────────
// Image I/O helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadPixels(inputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length),
    width: info.width,
    height: info.height,
  };
}

async function savePixels(pixels, outputPath) {
  await sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength), {
    raw: { width: pixels.width, height: pixels.height, channels: 4 },
  })
    .png()
    .toFile(outputPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 – Dual-fisheye → Equirectangular
// ─────────────────────────────────────────────────────────────────────────────

function stitchFisheyeToEquirectangular(srcData, srcW, srcH, outW, outH, opts = {}) {
  const {
    fisheyeFov   = 200,
    frontOffsetX = 0,
    frontOffsetY = 0,
    backOffsetX  = 0,
    backOffsetY  = 0,
  } = opts;

  const halfFovRad = (fisheyeFov / 2) * (Math.PI / 180);

  const fishW  = srcW / 2;
  const fishH  = srcH;
  const radius = Math.min(fishW, fishH) / 2;

  const frontCx = fishW / 2 + frontOffsetX;
  const frontCy = fishH / 2 + frontOffsetY;
  const backCx  = fishW + fishW / 2 + backOffsetX;
  const backCy  = fishH / 2 + backOffsetY;

  const outData = new Uint8ClampedArray(outW * outH * 4);

  const clampX = x => Math.max(0, Math.min(srcW - 1, x));
  const clampY = y => Math.max(0, Math.min(srcH - 1, y));

  for (let oy = 0; oy < outH; oy++) {
    const phi = (0.5 - (oy + 0.5) / outH) * Math.PI;

    for (let ox = 0; ox < outW; ox++) {
      const lambda = ((ox + 0.5) / outW - 0.5) * 2 * Math.PI;

      const sX = Math.cos(phi) * Math.sin(lambda);
      const sY = Math.sin(phi);
      const sZ = Math.cos(phi) * Math.cos(lambda);

      let srcX, srcY;

      if (sZ >= 0) {
        const theta = Math.atan2(Math.sqrt(sX * sX + sY * sY), sZ);
        if (theta > halfFovRad) {
          const oi = (oy * outW + ox) * 4;
          outData[oi] = outData[oi + 1] = outData[oi + 2] = 0;
          outData[oi + 3] = 255;
          continue;
        }
        const r    = radius * (theta / halfFovRad);
        const psi  = Math.atan2(sY, sX);
        srcX = frontCx + r * Math.cos(psi);
        srcY = frontCy - r * Math.sin(psi);
      } else {
        const theta = Math.atan2(Math.sqrt(sX * sX + sY * sY), -sZ);
        if (theta > halfFovRad) {
          const oi = (oy * outW + ox) * 4;
          outData[oi] = outData[oi + 1] = outData[oi + 2] = 0;
          outData[oi + 3] = 255;
          continue;
        }
        const r    = radius * (theta / halfFovRad);
        const psi  = Math.atan2(sY, -sX);
        srcX = backCx + r * Math.cos(psi);
        srcY = backCy - r * Math.sin(psi);
      }

      const x0 = Math.floor(srcX), y0 = Math.floor(srcY);
      const x1 = x0 + 1,          y1 = y0 + 1;
      const fx  = srcX - x0,       fy = srcY - y0;

      const i00 = (clampY(y0) * srcW + clampX(x0)) * 4;
      const i10 = (clampY(y0) * srcW + clampX(x1)) * 4;
      const i01 = (clampY(y1) * srcW + clampX(x0)) * 4;
      const i11 = (clampY(y1) * srcW + clampX(x1)) * 4;

      const oi = (oy * outW + ox) * 4;
      for (let c = 0; c < 3; c++) {
        outData[oi + c] = Math.round(
          srcData.data[i00 + c] * (1 - fx) * (1 - fy) +
          srcData.data[i10 + c] *      fx  * (1 - fy) +
          srcData.data[i01 + c] * (1 - fx) *      fy  +
          srcData.data[i11 + c] *      fx  *      fy
        );
      }
      outData[oi + 3] = 255;
    }
  }

  return { data: outData, width: outW, height: outH };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 – Equirectangular → Perspective crop
// ─────────────────────────────────────────────────────────────────────────────

async function equirectangularToPerspective(eqData, outputPath, options = {}) {
  const {
    yaw    = 0,
    pitch  = 0,
    fov    = 90,
    width  = 1024,
    height = 1024,
  } = options;

  const srcW = eqData.width;
  const srcH = eqData.height;

  const toRad    = d => d * Math.PI / 180;
  const yawRad   = toRad(yaw);
  const pitchRad = toRad(pitch);
  const tanHFov  = Math.tan(toRad(fov / 2));

  const outData = new Uint8ClampedArray(width * height * 4);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const nx = (px / (width  - 1)) * 2 - 1;
      const ny = 1 - (py / (height - 1)) * 2;

      let rx = nx * tanHFov;
      let ry = ny * tanHFov;
      let rz = -1.0;

      const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
      rx /= len; ry /= len; rz /= len;

      const cosPitch = Math.cos(pitchRad), sinPitch = Math.sin(pitchRad);
      const ry2 = ry * cosPitch - rz * sinPitch;
      const rz2 = ry * sinPitch + rz * cosPitch;
      ry = ry2; rz = rz2;

      const cosYaw = Math.cos(yawRad), sinYaw = Math.sin(yawRad);
      const rx2 =  rx * cosYaw + rz2 * sinYaw;
      const rz3 = -rx * sinYaw + rz2 * cosYaw;
      rx = rx2; rz = rz3;

      const theta = Math.atan2(rx, -rz);
      const phi   = Math.asin(Math.max(-1, Math.min(1, ry)));

      let u = (theta / (2 * Math.PI) + 0.5) * srcW;
      let v = (0.5 - phi / Math.PI) * srcH;
      u = ((u % srcW) + srcW) % srcW;
      v = Math.max(0, Math.min(srcH - 1, v));

      const x0 = Math.floor(u), y0 = Math.floor(v);
      const x1 = (x0 + 1) % srcW;
      const y1 = Math.min(y0 + 1, srcH - 1);
      const fx = u - x0, fy = v - y0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const oi = (py * width + px) * 4;
      for (let c = 0; c < 3; c++) {
        outData[oi + c] = Math.round(
          eqData.data[i00 + c] * (1 - fx) * (1 - fy) +
          eqData.data[i10 + c] *      fx  * (1 - fy) +
          eqData.data[i01 + c] * (1 - fx) *      fy  +
          eqData.data[i11 + c] *      fx  *      fy
        );
      }
      outData[oi + 3] = 255;
    }
  }

  await savePixels({ data: outData, width, height }, outputPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

async function convertImage(inputPath, outputPath, options = {}, eqSavePath = null) {
  const {
    yaw          = 0,
    pitch        = 0,
    fov          = 90,
    width        = 1024,
    height       = 1024,
    eqWidth      = null,
    eqHeight     = null,
    fisheyeFov   = 200,
    frontOffsetX = 0,
    frontOffsetY = 0,
    backOffsetX  = 0,
    backOffsetY  = 0,
  } = options;

  const srcData = await loadPixels(inputPath);
  const srcW = srcData.width;
  const srcH = srcData.height;

  const outW = eqWidth  || srcW;
  const outH = eqHeight || Math.round(outW / 2);

  const eqData = stitchFisheyeToEquirectangular(srcData, srcW, srcH, outW, outH, {
    fisheyeFov, frontOffsetX, frontOffsetY, backOffsetX, backOffsetY,
  });

  if (eqSavePath) {
    await savePixels(eqData, eqSavePath);
  }

  await equirectangularToPerspective(eqData, outputPath, { yaw, pitch, fov, width, height });
}

async function perspectiveFromPanorama(panoramaPath, outputPath, options = {}) {
  const eqData = await loadPixels(panoramaPath);
  await equirectangularToPerspective(eqData, outputPath, options);
}

async function stitchToPanorama(inputPath, outputPath, opts = {}) {
  const {
    eqWidth      = null,
    eqHeight     = null,
    fisheyeFov   = 200,
    frontOffsetX = 0,
    frontOffsetY = 0,
    backOffsetX  = 0,
    backOffsetY  = 0,
  } = opts;

  const srcData = await loadPixels(inputPath);
  const srcW = srcData.width;
  const srcH = srcData.height;

  const outW = eqWidth  || srcW;
  const outH = eqHeight || Math.round(outW / 2);

  const eqData = stitchFisheyeToEquirectangular(srcData, srcW, srcH, outW, outH, {
    fisheyeFov, frontOffsetX, frontOffsetY, backOffsetX, backOffsetY,
  });

  await savePixels(eqData, outputPath);
  console.log(`  Panorama saved: ${outputPath}`);
}

module.exports = { convertImage, perspectiveFromPanorama, stitchToPanorama };
