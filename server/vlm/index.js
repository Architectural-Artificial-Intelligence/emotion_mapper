/**
 * vlm/index.js
 * Provider-agnostic dispatch: scoreImage(imagePath, config) routes to the
 * configured VLM provider (openai | anthropic).
 */

const openai = require('./openai');
const anthropic = require('./anthropic');

const PROVIDERS = { openai, anthropic };

/**
 * @param {string} imagePath
 * @param {{provider: 'openai'|'anthropic', apiKey: string, model?: string}} config
 */
async function scoreImage(imagePath, config) {
  const provider = PROVIDERS[config?.provider];
  if (!provider) {
    throw new Error(`Unknown or unset VLM provider: ${config?.provider}. Expected "openai" or "anthropic".`);
  }
  return provider.scoreImage(imagePath, config);
}

module.exports = { scoreImage, PROVIDERS };
