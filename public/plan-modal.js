// plan-modal.js — DXF import + wall-layer selection, inside the Plan modal.

(function () {
  const dxfFileEl = document.getElementById('plan-dxf-file');
  const importBtn = document.getElementById('plan-import');
  const statusEl = document.getElementById('plan-status');
  const layerPanel = document.getElementById('plan-layer-panel');

  window.emotionMapperState = window.emotionMapperState || {};
  const state = window.emotionMapperState;

  importBtn.addEventListener('click', async () => {
    if (!state.projectId) {
      statusEl.textContent = 'Open a project first.';
      return;
    }
    const file = dxfFileEl.files[0];
    if (!file) {
      statusEl.textContent = 'Choose a DXF file first.';
      return;
    }
    setLoading('Parsing DXF…');
    const form = new FormData();
    form.append('dxf', file);
    try {
      const res = await fetch(`/plan/import?projectId=${encodeURIComponent(state.projectId)}`, {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'import failed');
      const pointCount = Object.keys(data.points).length;
      statusEl.textContent = `Plan imported — ${pointCount} point${pointCount === 1 ? '' : 's'} found. Choose which layers are walls below.`;
      renderLayerPanel(data);
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  });

  function setLoading(text) {
    statusEl.innerHTML = `<span class="spinner"></span>${text}`;
  }

  function renderLayerPanel(data) {
    layerPanel.style.display = 'block';
    layerPanel.innerHTML = '';

    const heading = document.createElement('div');
    heading.style.fontWeight = '600';
    heading.style.marginBottom = '8px';
    heading.textContent = 'Layers';
    layerPanel.appendChild(heading);

    const rows = {};
    for (const layer of data.layerDetails) {
      const row = document.createElement('div');
      row.className = 'layer-row';

      const wallCb = document.createElement('input');
      wallCb.type = 'checkbox';
      wallCb.checked = layer.isWallLayer;
      wallCb.title = 'Wall layer';

      const nameEl = document.createElement('span');
      nameEl.className = 'layer-name';
      const dominant = Object.entries(layer.entityTypes).sort((a, b) => b[1] - a[1])[0];
      nameEl.textContent = layer.name;

      const countEl = document.createElement('span');
      countEl.className = 'layer-count';
      countEl.textContent = `${layer.entityCount} entities (${dominant ? dominant[0] : '—'})`;

      const contextCb = document.createElement('input');
      contextCb.type = 'checkbox';
      contextCb.title = 'Show as context (secondary)';

      const contextLabel = document.createElement('label');
      contextLabel.style.fontSize = '11px';
      contextLabel.style.color = '#888';
      contextLabel.style.margin = '0';
      contextLabel.style.fontWeight = '400';
      contextLabel.appendChild(contextCb);
      contextLabel.appendChild(document.createTextNode(' context'));

      row.appendChild(wallCb);
      row.appendChild(nameEl);
      row.appendChild(countEl);
      row.appendChild(contextLabel);
      layerPanel.appendChild(row);

      rows[layer.name] = { wallCb, contextCb };
    }

    const applyBtn = document.createElement('button');
    applyBtn.className = 'action';
    applyBtn.textContent = 'Apply wall layers';
    applyBtn.addEventListener('click', () => applyWallLayers(rows));
    layerPanel.appendChild(applyBtn);
  }

  async function applyWallLayers(rows) {
    const wallLayers = Object.entries(rows).filter(([, r]) => r.wallCb.checked).map(([name]) => name);
    const contextLayers = Object.entries(rows).filter(([, r]) => r.contextCb.checked).map(([name]) => name);

    setLoading('Applying wall layers…');
    try {
      const res = await fetch('/plan/wall-layers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: state.projectId, wallLayers, contextLayers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to apply wall layers');

      state.planBounds = data.bounds;
      state.wallSegmentsForPlacement = data.wallSegments;
      state.wallLayers = wallLayers;
      state.contextLayers = contextLayers;

      statusEl.textContent = `Walls selected — ${data.wallSegmentCount} wall segments rendered.`;
      document.dispatchEvent(new CustomEvent('emotionMapperPlanUpdated'));
      window.emotionMapperCloseModal('plan-modal');
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }
})();
