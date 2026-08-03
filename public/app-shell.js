// app-shell.js — persistent top bar wiring + boot/resume sequence.

(function () {
  window.emotionMapperState = window.emotionMapperState || {};
  const state = window.emotionMapperState;

  const projectsLink = document.getElementById('topbar-projects-link');
  const currentProjectEl = document.getElementById('topbar-current-project');
  const gearBtn = document.getElementById('topbar-settings-gear');
  const appLayout = document.getElementById('app-layout');
  const dashboardSection = document.getElementById('dashboard');

  const renameInput = document.getElementById('rename-input');
  const renameSaveBtn = document.getElementById('rename-save');

  function showDashboard() {
    dashboardSection.classList.add('active');
    appLayout.classList.remove('active');
    if (window.emotionMapperRefreshDashboard) window.emotionMapperRefreshDashboard();
  }
  window.emotionMapperShowDashboard = showDashboard;

  function showWorkspace() {
    dashboardSection.classList.remove('active');
    appLayout.classList.add('active');
  }

  function renderCurrentProjectLabel() {
    currentProjectEl.textContent = state.projectName ? state.projectName : '';
  }
  window.emotionMapperRenderCurrentProjectLabel = renderCurrentProjectLabel;

  projectsLink.addEventListener('click', (ev) => {
    ev.preventDefault();
    showDashboard();
  });

  currentProjectEl.addEventListener('click', () => {
    if (!state.projectId) return;
    renameInput.value = state.projectName || '';
    window.emotionMapperOpenModal('rename-modal');
  });

  renameSaveBtn.addEventListener('click', async () => {
    const next = renameInput.value.trim();
    if (!next || next === state.projectName) {
      window.emotionMapperCloseModal('rename-modal');
      return;
    }
    try {
      const res = await fetch(`/project/${encodeURIComponent(state.projectId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'rename failed');
      state.projectName = data.name;
      renderCurrentProjectLabel();
      window.emotionMapperCloseModal('rename-modal');
      if (window.emotionMapperRefreshDashboard) window.emotionMapperRefreshDashboard();
    } catch (e) {
      alert('Error: ' + e.message);
    }
  });

  gearBtn.addEventListener('click', () => {
    if (!appLayout.classList.contains('active')) return;
    const section = document.getElementById('panel-sdk');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  async function openProject(id) {
    try {
      const res = await fetch(`/project/${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 404) clearActiveProject();
        showDashboard();
        return;
      }
      setActiveProject(id);
      state.projectId = data.id;
      state.projectName = data.name;
      state.planBounds = data.planBounds;
      state.wallSegmentsForPlacement = data.wallSegments;
      state.wallLayers = data.wallLayers;
      state.contextLayers = data.contextLayers;
      renderCurrentProjectLabel();
      showWorkspace();
      document.dispatchEvent(new CustomEvent('emotionMapperProjectOpened'));
    } catch (e) {
      showDashboard();
    }
  }
  window.emotionMapperOpenProject = openProject;

  document.addEventListener('DOMContentLoaded', () => {
    const storedId = getActiveProjectId();
    if (storedId) {
      openProject(storedId);
    } else {
      showDashboard();
    }
  });
})();
