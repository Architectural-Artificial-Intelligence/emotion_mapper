/**
 * vlm/index.js
 * Provider-agnostic dispatch: scoreImage(imagePath, config) routes to the
 * configured VLM provider (openai | anthropic).
 */

const openai = require('./openai');
const anthropic = require('./anthropic');
const customOpenai = require('./custom-openai');

const PROVIDERS = { openai, anthropic, 'custom-openai': customOpenai };

/**
 * @param {string} imagePath
 * @param {{provider: 'openai'|'anthropic'|'custom-openai', apiKey?: string, model?: string, baseUrl?: string}} config
 */
async function scoreImage(imagePath, config) {
  const provider = PROVIDERS[config?.provider];
  if (!provider) {
    throw new Error(`Unknown or unset VLM provider: ${config?.provider}. Expected "openai", "anthropic", or "custom-openai".`);
  }
  return provider.scoreImage(imagePath, config);
}

module.exports = { scoreImage, PROVIDERS };
