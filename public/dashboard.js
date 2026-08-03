// dashboard.js — Project Dashboard: landing screen, list + create + resume.

(function () {
  window.emotionMapperState = window.emotionMapperState || {};
  const state = window.emotionMapperState;

  const gridEl = document.getElementById('dashboard-grid');
  const statusEl = document.getElementById('dashboard-status');
  const newBtn = document.getElementById('dashboard-new-project');

  function relativeTime(ts) {
    if (!ts) return 'never';
    const diffMs = Date.now() - ts;
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  async function refresh() {
    statusEl.textContent = 'Loading…';
    try {
      const res = await fetch('/projects');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to load projects');
      render(data.projects);
      statusEl.textContent = '';
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  }
  window.emotionMapperRefreshDashboard = refresh;

  function render(projects) {
    gridEl.innerHTML = '';
    if (!projects.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No projects yet — create one to get started.';
      gridEl.appendChild(empty);
      return;
    }
    for (const p of projects) {
      const card = document.createElement('div');
      card.className = 'project-card';

      const title = document.createElement('h3');
      title.textContent = p.name;
      card.appendChild(title);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `${p.photoCount} photo${p.photoCount === 1 ? '' : 's'} · edited ${relativeTime(p.lastEdited)}`;
      card.appendChild(meta);

      const flags = document.createElement('div');
      flags.className = 'flags';
      const planFlag = document.createElement('span');
      planFlag.className = 'flag' + (p.planImported ? ' on' : '');
      planFlag.textContent = p.planImported ? 'Plan imported' : 'No plan';
      const wallsFlag = document.createElement('span');
      wallsFlag.className = 'flag' + (p.wallsSelected ? ' on' : '');
      wallsFlag.textContent = p.wallsSelected ? 'Walls selected' : 'No walls';
      flags.appendChild(planFlag);
      flags.appendChild(wallsFlag);
      card.appendChild(flags);

      card.addEventListener('click', () => window.emotionMapperOpenProject(p.id));
      gridEl.appendChild(card);
    }
  }

  newBtn.addEventListener('click', async () => {
    const name = prompt('New project name');
    if (!name || !name.trim()) return;
    try {
      const res = await fetch('/project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'create failed');
      window.emotionMapperOpenProject(data.id);
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  });
})();
