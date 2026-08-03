// modal.js — tiny shared open/close helper for .modal overlays.

(function () {
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }
  window.emotionMapperOpenModal = openModal;

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }
  window.emotionMapperCloseModal = closeModal;

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-close-modal]').forEach((el) => {
      el.addEventListener('click', () => closeModal(el.dataset.closeModal));
    });
  });
})();
