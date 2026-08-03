/**
 * public/state.js
 * Shared client state + localStorage persistence for the active project id.
 * Bulky project data (walls, photos, placements) is never cached in
 * localStorage — it's always re-fetched from the server, which is the
 * source of truth.
 */
window.emotionMapperState = window.emotionMapperState || {};

const ACTIVE_PROJECT_KEY = 'emotionMapperActiveProjectId';

function setActiveProject(id) {
  if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id);
  else localStorage.removeItem(ACTIVE_PROJECT_KEY);
}

function getActiveProjectId() {
  return localStorage.getItem(ACTIVE_PROJECT_KEY);
}

function clearActiveProject() {
  localStorage.removeItem(ACTIVE_PROJECT_KEY);
}
