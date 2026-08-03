// settings.js — Settings view: pick VLM provider, enter API key, choose a
// model fetched from the provider, save to server. Model is mandatory —
// the user cannot save (and therefore cannot continue) without picking one.

(function () {
  const providerEl = document.getElementById('settings-provider');
  const apiKeyEl = document.getElementById('settings-apikey');
  const modelEl = document.getElementById('settings-model');
  const statusEl = document.getElementById('settings-status');
  const saveBtn = document.getElementById('settings-save');
  const loadModelsBtn = document.getElementById('settings-load-models');

  let savedModel = null; // model already on file for this provider, to preselect once loaded

  function providerLabel(provider) {
    return provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  }

  function resetModelSelect(message) {
    modelEl.innerHTML = `<option value="">${message}</option>`;
    updateSaveEnabled();
  }

  function updateSaveEnabled() {
    saveBtn.disabled = !modelEl.value;
  }

  async function loadModels() {
    const provider = providerEl.value;
    const apiKey = apiKeyEl.value;
    if (!apiKey) {
      resetModelSelect('Enter API key, then load models…');
      return;
    }
    resetModelSelect('Loading models…');
    loadModelsBtn.disabled = true;
    loadModelsBtn.textContent = 'Loading…';
    try {
      const res = await fetch('/settings/vlm-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to load models');
      if (!data.models || data.models.length === 0) {
        resetModelSelect('No models available for this key');
        return;
      }
      modelEl.innerHTML = '<option value="">Select a model…</option>' +
        data.models.map(m => `<option value="${m}">${m}</option>`).join('');
      if (savedModel && data.models.includes(savedModel)) {
        modelEl.value = savedModel;
      }
      updateSaveEnabled();
    } catch (e) {
      resetModelSelect('Could not load models');
      statusEl.textContent = 'Error: ' + e.message;
    } finally {
      loadModelsBtn.disabled = false;
      loadModelsBtn.textContent = 'Load available models';
    }
  }

  async function loadCurrent() {
    try {
      const res = await fetch('/settings/vlm-config');
      const data = await res.json();
      if (data.provider) providerEl.value = data.provider;
      savedModel = data.model || null;
      if (data.apiKeySet && data.apiKeySuffix) {
        apiKeyEl.placeholder = `sk-••••••${data.apiKeySuffix}`;
        statusEl.textContent = `${providerLabel(data.provider)} key saved ✓`;
      } else {
        statusEl.textContent = 'No API key set yet.';
      }
      resetModelSelect('Enter API key, then load models…');
    } catch (e) {
      statusEl.textContent = 'Could not load current settings.';
    }
  }

  loadModelsBtn.addEventListener('click', loadModels);
  providerEl.addEventListener('change', () => resetModelSelect('Enter API key, then load models…'));
  modelEl.addEventListener('change', updateSaveEnabled);

  saveBtn.addEventListener('click', async () => {
    if (!modelEl.value) {
      statusEl.textContent = 'Choose a model before saving.';
      return;
    }
    statusEl.innerHTML = '<span class="spinner"></span>Saving…';
    try {
      const res = await fetch('/settings/vlm-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: providerEl.value,
          apiKey: apiKeyEl.value,
          model: modelEl.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'save failed');
      statusEl.textContent = `${providerLabel(data.provider)} key saved ✓ (model: ${data.model})`;
      loadCurrent();
      if (window.emotionMapperRefreshApiKeyState) window.emotionMapperRefreshApiKeyState();
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  });

  // Called by other views when an action needs a VLM API key but none is
  // configured yet, so the user is prompted immediately instead of just
  // seeing a raw error string.
  window.emotionMapperRequireApiKey = function (message) {
    statusEl.textContent = message || 'An API key is required before photos can be scored.';
    const section = document.getElementById('panel-sdk');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    apiKeyEl.focus();
  };

  updateSaveEnabled();
  loadCurrent();
})();
