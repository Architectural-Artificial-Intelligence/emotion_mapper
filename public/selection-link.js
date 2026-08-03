/**
 * public/selection-link.js
 * Tiny reusable bidirectional-selection helper — no framework, no deps.
 * Used by Photo Placement to sync canvas markers <-> gallery thumbnails,
 * and reusable later by Heatmap for click-to-inspect.
 */
window.SelectionLink = function SelectionLink() {
  let selectedId = null;
  const listeners = [];
  return {
    select(id) {
      selectedId = id;
      listeners.forEach(fn => fn(id));
    },
    get() {
      return selectedId;
    },
    onChange(fn) {
      listeners.push(fn);
    },
  };
};
