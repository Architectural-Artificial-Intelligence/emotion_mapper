/**
 * anthropic.js
 * Claude vision PANAS provider. Uses raw https + base64 image, so no
 * @anthropic-ai/sdk dependency is required. Uses the shared PANAS
 * prompt/parsing logic.
 *
 * Default model: claude-opus-4-8 (current Opus-tier model as of this writing —
 * see the claude-api skill / shared/models.md for the up-to-date catalog).
 * Callers may override via config.model.
 */

const fs = require('fs');
const https = require('https');
const { PANAS_PROMPT, parsePANASResponse } = require('./panas-prompt');

const DEFAULT_MODEL = 'claude-opus-4-8';

/**
 * @param {string} imagePath
 * @param {{apiKey: string, model?: string}} config
 */
async function scoreImage(imagePath, config) {
  const { apiKey, model = DEFAULT_MODEL } = config;
  if (!apiKey) throw new Error('Anthropic API key is required');

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const mediaType = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  const requestBody = JSON.stringify({
    model,
    max_tokens: 600,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Image },
          },
          { type: 'text', text: PANAS_PROMPT },
        ],
      },
    ],
  });

  const responseText = await makeRequest(apiKey, requestBody);
  return parsePANASResponse(responseText);
}

function makeRequest(apiKey, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Anthropic API error: ${parsed.error.message}`));
          } else {
            const textBlock = (parsed.content || []).find(b => b.type === 'text');
            resolve(textBlock ? textBlock.text : '');
          }
        } catch (e) {
          reject(new Error(`Failed to parse Anthropic API response: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}

// Current vision-capable Claude models. Static list — Anthropic has no
// public list-models endpoint usable for this UI's "pick a model" purpose.
const AVAILABLE_MODELS = [
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

function listModels() {
  return Promise.resolve(AVAILABLE_MODELS);
}

module.exports = { scoreImage, DEFAULT_MODEL, listModels };
