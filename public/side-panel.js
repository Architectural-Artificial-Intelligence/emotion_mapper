// side-panel.js — plan summary + "Edit plan" launcher, and the unplaced
// photos list (upload -> auto stitch+score, select-to-place).

(function () {
  const planSummaryText = document.getElementById('plan-summary-text');
  const planEditBtn = document.getElementById('plan-edit-btn');

  const imagesEl = document.getElementById('placement-images');
  const ingestBtn = document.getElementById('placement-ingest');
  const statusEl = document.getElementById('placement-status');
  const listEl = document.getElementById('unplaced-list');

  window.emotionMapperState = window.emotionMapperState || {};
  const state = window.emotionMapperState;

  let photoList = [];       // all photos for this project, from GET /photos
  let selectedUnplacedId = null;
  const scoringInFlight = new Set();
  let apiKeySet = false;
  let vlmConfigured = false;

  window.emotionMapperGetSelectedUnplaced = () => selectedUnplacedId;
  window.emotionMapperSelectUnplaced = (id) => {
    selectedUnplacedId = id;
    renderList();
  };

  planEditBtn.addEventListener('click', () => {
    if (!state.projectId) return;
    window.emotionMapperOpenModal('plan-modal');
  });

  function renderPlanSummary() {
    if (state.planBounds) {
      const layerCount = (state.wallLayers || []).length;
      planSummaryText.textContent = `Plan imported — ${layerCount} wall layer${layerCount === 1 ? '' : 's'} selected`;
    } else {
      planSummaryText.textContent = 'No plan imported';
    }
    if (window.emotionMapperSetProgress) window.emotionMapperSetProgress('plan', !!state.planBounds);
  }
  window.emotionMapperRenderPlanSummary = renderPlanSummary;

  async function loadPhotos() {
    if (!state.projectId) return;
    try {
      const res = await fetch(`/photos?projectId=${encodeURIComponent(state.projectId)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to load photos');
      photoList = data.photos;
      renderList();
      if (window.emotionMapperSetProgress) window.emotionMapperSetProgress('images', photoList.length > 0);
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }
  window.emotionMapperReloadUnplaced = loadPhotos;

  function badgeFor(photo) {
    if (photo.status === 'scored') return 'scored';
    if (photo.status === 'scoring' || scoringInFlight.has(photo.id)) return 'scoring';
    if (photo.status === 'error') return 'error';
    return 'ingested';
  }

  function renderList() {
    listEl.innerHTML = '';
    const unplaced = photoList.filter((p) => !p.placed);

    if (unplaced.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No unplaced photos.';
      listEl.appendChild(empty);
      return;
    }

    for (const photo of unplaced) {
      const item = document.createElement('div');
      item.className = 'unplaced-item' + (selectedUnplacedId === photo.id ? ' selected' : '');

      const img = document.createElement('img');
      img.src = photo.thumbnailUrl;
      item.appendChild(img);

      const info = document.createElement('div');
      info.className = 'item-info';

      const name = document.createElement('div');
      name.className = 'item-name';
      name.textContent = photo.baseName;
      info.appendChild(name);

      const badge = document.createElement('span');
      const status = badgeFor(photo);
      badge.className = `status-badge badge-${status}`;
      badge.textContent = status;
      info.appendChild(badge);

      if (photo.scores) {
        const scores = document.createElement('div');
        scores.className = 'item-scores';
        scores.textContent = `PA ${photo.scores.positive_affect?.toFixed(1) ?? '–'} / NA ${photo.scores.negative_affect?.toFixed(1) ?? '–'}`;
        info.appendChild(scores);
      }

      if (photo.status === 'error' && photo.error) {
        const errEl = document.createElement('div');
        errEl.className = 'item-error';
        errEl.style.color = '#c00';
        errEl.textContent = photo.error;
        info.appendChild(errEl);
      }

      item.appendChild(info);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'item-remove';
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', `Remove ${photo.baseName}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Remove ${photo.baseName}? This cannot be undone.`)) return;
        try {
          const res = await fetch(`/photos/${encodeURIComponent(photo.id)}`, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'failed to remove photo');
          if (selectedUnplacedId === photo.id) window.emotionMapperSelectUnplaced(null);
          await loadPhotos();
          if (window.emotionMapperMapReloadPlaced) window.emotionMapperMapReloadPlaced();
          window.emotionMapperRefreshHeatmapIfOn && window.emotionMapperRefreshHeatmapIfOn();
        } catch (e) {
          statusEl.textContent = 'Error: ' + e.message;
        }
      });
      item.appendChild(removeBtn);

      item.addEventListener('click', () => {
        window.emotionMapperSelectUnplaced(photo.id === selectedUnplacedId ? null : photo.id);
        statusEl.textContent = selectedUnplacedId ? `Selected ${photo.baseName}. Click the map to place it.` : '';
      });

      listEl.appendChild(item);
    }
  }

  async function refreshApiKeyState() {
    try {
      const res = await fetch('/settings/vlm-config');
      const data = await res.json();
      apiKeySet = !!(res.ok && data.apiKeySet);
      vlmConfigured = !!(res.ok && data.apiKeySet && data.provider && data.model);
    } catch (e) {
      apiKeySet = false;
      vlmConfigured = false;
    }
    ingestBtn.disabled = !vlmConfigured;
    imagesEl.disabled = !vlmConfigured;
    if (window.emotionMapperSetProgress) window.emotionMapperSetProgress('apikey', vlmConfigured);
    if (!vlmConfigured) {
      statusEl.textContent = apiKeySet
        ? 'Choose a model in Settings before uploading photos.'
        : 'Set an API key and model in Settings before uploading photos.';
    } else if (/before uploading photos\.$/.test(statusEl.textContent)) {
      statusEl.textContent = '';
    }
  }
  window.emotionMapperRefreshApiKeyState = refreshApiKeyState;

  ingestBtn.addEventListener('click', async () => {
    const projectId = state.projectId;
    if (!projectId) {
      statusEl.textContent = 'Open a project first.';
      return;
    }
    await refreshApiKeyState();
    if (!vlmConfigured) {
      if (window.emotionMapperRequireApiKey) {
        window.emotionMapperRequireApiKey('An API key and model are required before uploading photos. Complete both below.');
      }
      return;
    }
    if (!imagesEl.files.length) {
      statusEl.textContent = 'Choose at least one image.';
      return;
    }
    const form = new FormData();
    for (const f of imagesEl.files) form.append('images', f);
    statusEl.innerHTML = '<span class="spinner"></span>Uploading, stitching &amp; scoring…';
    try {
      const res = await fetch(`/photos/ingest?projectId=${encodeURIComponent(projectId)}`, {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 400 && /No API key configured|No model configured|Unknown or unset VLM provider/.test(data.error || '')) {
          if (window.emotionMapperRequireApiKey) {
            window.emotionMapperRequireApiKey(data.error);
            return;
          }
        }
        throw new Error(data.error || 'ingest failed');
      }
      pollJob(data.jobId);
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  });

  async function pollJob(jobId) {
    const poll = async () => {
      const res = await fetch(`/jobs/${jobId}`);
      const job = await res.json();
      if (job.status === 'done') {
        statusEl.textContent = 'Photos ready.';
        imagesEl.value = '';
        loadPhotos();
      } else if (job.status === 'error') {
        statusEl.textContent = 'Error: ' + job.error;
      } else {
        setTimeout(poll, 1000);
      }
    };
    poll();
  }

  document.addEventListener('emotionMapperProjectOpened', () => {
    photoList = [];
    selectedUnplacedId = null;
    renderPlanSummary();
    loadPhotos();
    refreshApiKeyState();
  });

  document.addEventListener('emotionMapperPlanUpdated', renderPlanSummary);
})();
