// settings.js — Settings view: pick VLM provider, enter API key, choose a
// model fetched from the provider, save to server. Model is mandatory —
// the user cannot save (and therefore cannot continue) without picking one.

(function () {
  const providerEl = document.getElementById('settings-provider');
  const baseUrlLabelEl = document.getElementById('settings-baseurl-label');
  const baseUrlEl = document.getElementById('settings-baseurl');
  const apiKeyEl = document.getElementById('settings-apikey');
  const modelEl = document.getElementById('settings-model');
  const modelInputEl = document.getElementById('settings-model-input');
  const statusEl = document.getElementById('settings-status');
  const saveBtn = document.getElementById('settings-save');
  const loadModelsBtn = document.getElementById('settings-load-models');

  let savedModel = null; // model already on file for this provider, to preselect once loaded

  function providerLabel(provider) {
    if (provider === 'custom-openai') return 'Custom (OpenAI-compatible)';
    return provider === 'anthropic' ? 'Anthropic' : 'OpenAI';
  }

  function updateProviderUI() {
    const isCustom = providerEl.value === 'custom-openai';
    if (baseUrlLabelEl) baseUrlLabelEl.style.display = isCustom ? 'block' : 'none';
    if (baseUrlEl) baseUrlEl.style.display = isCustom ? 'block' : 'none';
    if (modelInputEl) modelInputEl.style.display = isCustom ? 'block' : 'none';
    apiKeyEl.placeholder = isCustom ? 'Optional (if server requires one)...' : 'sk-...';
    updateSaveEnabled();
  }

  function getSelectedModel() {
    if (providerEl.value === 'custom-openai' && modelInputEl && modelInputEl.value.trim()) {
      return modelInputEl.value.trim();
    }
    return modelEl.value;
  }

  function resetModelSelect(message) {
    modelEl.innerHTML = `<option value="">${message}</option>`;
    updateSaveEnabled();
  }

  function updateSaveEnabled() {
    saveBtn.disabled = !getSelectedModel();
  }

  async function loadModels() {
    const provider = providerEl.value;
    const apiKey = apiKeyEl.value;
    const baseUrl = baseUrlEl ? baseUrlEl.value.trim() : '';
    if (provider === 'custom-openai') {
      if (!baseUrl) {
        statusEl.textContent = 'Enter Base URL before loading models.';
        return;
      }
    } else if (!apiKey) {
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
        body: JSON.stringify({ provider, apiKey, baseUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'failed to load models');
      if (!data.models || data.models.length === 0) {
        resetModelSelect('No models available for this endpoint');
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
      if (data.baseUrl && baseUrlEl) baseUrlEl.value = data.baseUrl;
      updateProviderUI();

      if (data.provider === 'custom-openai' && savedModel && modelInputEl) {
        modelInputEl.value = savedModel;
      }
      if (data.apiKeySet && data.apiKeySuffix) {
        apiKeyEl.placeholder = `sk-••••••${data.apiKeySuffix}`;
        statusEl.textContent = `${providerLabel(data.provider)} configured ✓ (model: ${savedModel || 'none'})`;
      } else if (data.provider === 'custom-openai' && data.baseUrl && savedModel) {
        statusEl.textContent = `${providerLabel(data.provider)} configured ✓ (model: ${savedModel})`;
      } else {
        statusEl.textContent = 'No API key or custom endpoint set yet.';
      }
      resetModelSelect(data.provider === 'custom-openai' ? 'Select model or type below…' : 'Enter API key, then load models…');
      updateSaveEnabled();
    } catch (e) {
      statusEl.textContent = 'Could not load current settings.';
    }
  }

  loadModelsBtn.addEventListener('click', loadModels);
  providerEl.addEventListener('change', () => {
    updateProviderUI();
    resetModelSelect(providerEl.value === 'custom-openai' ? 'Select model or type below…' : 'Enter API key, then load models…');
  });
  modelEl.addEventListener('change', () => {
    if (modelEl.value && providerEl.value === 'custom-openai' && modelInputEl) {
      modelInputEl.value = modelEl.value;
    }
    updateSaveEnabled();
  });
  if (modelInputEl) modelInputEl.addEventListener('input', updateSaveEnabled);
  if (baseUrlEl) baseUrlEl.addEventListener('input', updateSaveEnabled);

  saveBtn.addEventListener('click', async () => {
    const chosenModel = getSelectedModel();
    if (!chosenModel) {
      statusEl.textContent = 'Choose or type a model before saving.';
      return;
    }
    if (providerEl.value === 'custom-openai' && baseUrlEl && !baseUrlEl.value.trim()) {
      statusEl.textContent = 'Enter Base URL before saving.';
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
          model: chosenModel,
          baseUrl: baseUrlEl ? baseUrlEl.value.trim() : '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'save failed');
      statusEl.textContent = `${providerLabel(data.provider)} configured ✓ (model: ${data.model})`;
      loadCurrent();
      if (window.emotionMapperRefreshApiKeyState) window.emotionMapperRefreshApiKeyState();
    } catch (e) {
      statusEl.textContent = 'Error: ' + e.message;
    }
  });

  // Called by other views when an action needs a VLM configuration but none is
  // configured yet, so the user is prompted immediately instead of just
  // seeing a raw error string.
  window.emotionMapperRequireApiKey = function (message) {
    statusEl.textContent = message || 'A VLM provider configuration is required before photos can be scored.';
    const section = document.getElementById('panel-sdk');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (providerEl.value === 'custom-openai' && baseUrlEl) {
      baseUrlEl.focus();
    } else {
      apiKeyEl.focus();
    }
  };

  updateProviderUI();
  updateSaveEnabled();
  loadCurrent();
})();
