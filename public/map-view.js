// map-view.js — the single always-visible map: walls, placed-photo icons
// (thumbnail + PANAS scores), optional heatmap color overlay, click-to-place.

(function () {
  const canvas = document.getElementById('map-canvas');
  const ctx = canvas.getContext('2d');
  const fitBtn = document.getElementById('map-fit');
  const heatmapToggle = document.getElementById('heatmap-toggle');
  const heatmapEmotionEl = document.getElementById('heatmap-emotion');
  const heatmapStatusEl = document.getElementById('heatmap-status');
  const heatmapLegendEl = document.getElementById('heatmap-legend');
  const heatmapLegendMinEl = document.getElementById('heatmap-legend-min');
  const heatmapLegendMaxEl = document.getElementById('heatmap-legend-max');

  window.emotionMapperState = window.emotionMapperState || {};
  const state = window.emotionMapperState;

  let walls = null;          // { wallSegments, bounds, points }
  let placedPhotos = [];     // [{id, baseName, thumbnailUrl, scores, x, y}]
  let overlayImg = null;
  let heatmapLoading = false;
  const link = window.SelectionLink();
  const thumbCache = new Map(); // photoId -> HTMLImageElement

  const panZoom = new window.CanvasPanZoom(canvas, { onRedraw: draw });

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  window.addEventListener('resize', () => {
    resizeCanvas();
    draw();
  });

  fitBtn.addEventListener('click', () => {
    if (walls) {
      resizeCanvas();
      panZoom.fitToView(walls.bounds);
    }
  });

  // Fixed score ranges per emotion, mirroring server/routes.js's GET /heatmap
  // vmin/vmax logic — keep both in sync if that logic changes.
  function heatmapRange(emotion) {
    if (emotion === 'pa_minus_na') return [-40, 40];
    if (emotion === 'positive_affect' || emotion === 'negative_affect') return [10, 50];
    return [1, 5]; // individual PANAS item
  }

  function updateLegend() {
    const [min, max] = heatmapRange(heatmapEmotionEl.value);
    heatmapLegendMinEl.textContent = min;
    heatmapLegendMaxEl.textContent = max;
    heatmapLegendEl.hidden = false;
  }

  heatmapToggle.addEventListener('change', () => {
    if (heatmapToggle.checked) loadHeatmap();
    else { overlayImg = null; heatmapLegendEl.hidden = true; draw(); }
  });
  heatmapEmotionEl.addEventListener('change', () => {
    if (heatmapToggle.checked) loadHeatmap();
  });

  async function loadWorkspace() {
    if (!state.projectId) return;
    await loadWalls();
    await loadPlacedPhotos();
    resizeCanvas();
    if (walls) panZoom.fitToView(walls.bounds);
    draw();
    if (heatmapToggle.checked) loadHeatmap();
  }
  window.emotionMapperMapLoadWorkspace = loadWorkspace;

  async function loadWalls() {
    try {
      const res = await fetch(`/plan/walls?projectId=${encodeURIComponent(state.projectId)}`);
      if (!res.ok) { walls = null; return; }
      walls = await res.json();
    } catch (e) {
      walls = null;
    }
  }

  async function loadPlacedPhotos() {
    try {
      const [photosRes, placementsRes] = await Promise.all([
        fetch(`/photos?projectId=${encodeURIComponent(state.projectId)}`),
        fetch(`/placements?projectId=${encodeURIComponent(state.projectId)}`),
      ]);
      const photosData = await photosRes.json();
      const placementsData = await placementsRes.json();
      if (!photosRes.ok || !placementsRes.ok) return;

      placedPhotos = photosData.photos
        .filter((p) => p.placed && placementsData.placements[p.id])
        .map((p) => ({
          id: p.id,
          baseName: p.baseName,
          thumbnailUrl: p.thumbnailUrl,
          scores: p.scores,
          x: placementsData.placements[p.id].x,
          y: placementsData.placements[p.id].y,
        }));
    } catch (e) {
      // leave placedPhotos as-is
    }
  }
  window.emotionMapperMapReloadPlaced = async function () {
    await loadPlacedPhotos();
    draw();
  };

  async function loadHeatmap() {
    if (!state.projectId || !walls) return;
    heatmapLoading = true;
    heatmapStatusEl.innerHTML = '<span class="spinner"></span>Rendering heatmap…';
    const url = `/heatmap?projectId=${encodeURIComponent(state.projectId)}&emotion=${encodeURIComponent(heatmapEmotionEl.value)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        overlayImg = null;
        heatmapLegendEl.hidden = true;
        draw();
        if (res.status === 422) {
          heatmapStatusEl.textContent = 'No scored/placed data yet.';
        } else {
          const data = await res.json().catch(() => ({}));
          heatmapStatusEl.textContent = 'Error: ' + (data.error || `HTTP ${res.status}`);
        }
        return;
      }
      const blob = await res.blob();
      const img = new Image();
      img.onload = () => {
        overlayImg = img;
        updateLegend();
        draw();
        heatmapStatusEl.textContent = 'Heatmap up to date.';
        if (window.emotionMapperSetProgress) window.emotionMapperSetProgress('heatmap', true);
      };
      img.src = URL.createObjectURL(blob);
    } catch (e) {
      heatmapStatusEl.textContent = 'Error: ' + e.message;
    } finally {
      heatmapLoading = false;
    }
  }
  window.emotionMapperRefreshHeatmapIfOn = function () {
    if (heatmapToggle.checked) loadHeatmap();
  };

  function getThumb(photo) {
    let img = thumbCache.get(photo.id);
    if (!img) {
      img = new Image();
      img.onload = draw;
      img.src = photo.thumbnailUrl;
      thumbCache.set(photo.id, img);
    }
    return img;
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fafaf5';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!walls) {
      ctx.fillStyle = '#999';
      ctx.font = 'italic 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Import a plan to get started', canvas.width / 2, canvas.height / 2);
      ctx.textAlign = 'left';
      return;
    }

    if (overlayImg && heatmapToggle.checked) {
      const [x0, y0] = panZoom.worldToScreen(walls.bounds[0], walls.bounds[3]);
      const [x1, y1] = panZoom.worldToScreen(walls.bounds[2], walls.bounds[1]);
      ctx.drawImage(overlayImg, x0, y0, x1 - x0, y1 - y0);
    }

    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2;
    for (const seg of walls.wallSegments || []) {
      const [x0, y0] = panZoom.worldToScreen(seg[0], seg[1]);
      const [x1, y1] = panZoom.worldToScreen(seg[2], seg[3]);
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    const ICON = 40;
    for (const photo of placedPhotos) {
      const [px, py] = panZoom.worldToScreen(photo.x, photo.y);
      const selected = link.get() === photo.id;

      const img = getThumb(photo);
      ctx.save();
      ctx.beginPath();
      ctx.arc(px, py, ICON / 2, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();
      if (img.complete && img.naturalWidth) {
        ctx.drawImage(img, px - ICON / 2, py - ICON / 2, ICON, ICON);
      } else {
        ctx.fillStyle = '#ddd';
        ctx.fillRect(px - ICON / 2, py - ICON / 2, ICON, ICON);
      }
      ctx.restore();

      ctx.lineWidth = selected ? 3 : 2;
      ctx.strokeStyle = selected ? '#c00' : '#0a7';
      ctx.beginPath();
      ctx.arc(px, py, ICON / 2, 0, Math.PI * 2);
      ctx.stroke();

      if (photo.scores) {
        const label = `PA ${photo.scores.positive_affect?.toFixed(1) ?? '–'} / NA ${photo.scores.negative_affect?.toFixed(1) ?? '–'}`;
        ctx.font = '11px sans-serif';
        const textWidth = ctx.measureText(label).width;
        const lx = px - textWidth / 2 - 4;
        const ly = py + ICON / 2 + 4;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(lx, ly, textWidth + 8, 16);
        ctx.fillStyle = '#222';
        ctx.textAlign = 'center';
        ctx.fillText(label, px, ly + 12);
        ctx.textAlign = 'left';
      }
    }
  }

  let dragMoved = false;
  let draggingPhoto = null; // photo object being repositioned, while mouse is down on it

  function hitTestPhoto(px, py) {
    return placedPhotos.find((p) => {
      const [mx, my] = panZoom.worldToScreen(p.x, p.y);
      return Math.hypot(mx - px, my - py) <= 20;
    });
  }

  canvas.addEventListener('mousedown', (ev) => {
    dragMoved = false;
    draggingPhoto = null;
    if (!walls) return;
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const hit = hitTestPhoto(px, py);
    if (hit) {
      draggingPhoto = hit;
      panZoom.cancelDrag(); // don't pan the map while repositioning an icon
    }
  });

  window.addEventListener('mousemove', (ev) => {
    if (ev.buttons === 1) dragMoved = true;
    if (!draggingPhoto) return;
    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const [x, y] = panZoom.screenToWorld(px, py);
    draggingPhoto.x = x;
    draggingPhoto.y = y;
    draw();
  });

  window.addEventListener('mouseup', async () => {
    if (!draggingPhoto) return;
    const photo = draggingPhoto;
    draggingPhoto = null;
    const res = await fetch('/placements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: state.projectId, photoId: photo.id, x: photo.x, y: photo.y }),
    });
    if (res.ok) window.emotionMapperRefreshHeatmapIfOn();
    await loadPlacedPhotos();
    draw();
  });

  canvas.addEventListener('click', async (ev) => {
    if (dragMoved) return; // was a pan/icon drag, not a click
    if (!walls) return;

    const rect = canvas.getBoundingClientRect();
    const px = ev.clientX - rect.left, py = ev.clientY - rect.top;
    const [x, y] = panZoom.screenToWorld(px, py);

    const hit = hitTestPhoto(px, py);
    if (hit) {
      if (!confirm(`Remove ${hit.baseName} from the map and move it back to the sidebar?`)) return;
      const res = await fetch(`/placements/${encodeURIComponent(hit.id)}?projectId=${encodeURIComponent(state.projectId)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        if (window.emotionMapperReloadUnplaced) window.emotionMapperReloadUnplaced();
        await loadPlacedPhotos();
        draw();
        window.emotionMapperRefreshHeatmapIfOn();
      }
      return;
    }

    const selectedPhotoId = window.emotionMapperGetSelectedUnplaced && window.emotionMapperGetSelectedUnplaced();
    if (!selectedPhotoId) return;

    const res = await fetch('/placements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: state.projectId, photoId: selectedPhotoId, x, y }),
    });
    if (!res.ok) return;

    if (window.emotionMapperSelectUnplaced) window.emotionMapperSelectUnplaced(null);
    if (window.emotionMapperReloadUnplaced) window.emotionMapperReloadUnplaced();
    await loadPlacedPhotos();
    draw();
    window.emotionMapperRefreshHeatmapIfOn();
  });

  document.addEventListener('emotionMapperPlanUpdated', () => {
    loadWalls().then(() => {
      resizeCanvas();
      if (walls) panZoom.fitToView(walls.bounds);
      draw();
    });
  });

  document.addEventListener('emotionMapperProjectOpened', () => {
    walls = null;
    placedPhotos = [];
    overlayImg = null;
    heatmapToggle.checked = false;
    heatmapLegendEl.hidden = true;
    thumbCache.clear();
    loadWorkspace();
  });

  resizeCanvas();
  draw();
})();
