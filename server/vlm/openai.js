/**
 * openai.js
 * OpenAI GPT-4o/GPT-5 vision provider, using the shared PANAS prompt/parsing
 * logic.
 */

const fs = require('fs');
const https = require('https');
const { PANAS_PROMPT, parsePANASResponse } = require('./panas-prompt');

/**
 * @param {string} imagePath
 * @param {{apiKey: string, model?: string}} config
 */
async function scoreImage(imagePath, config) {
  const { apiKey, model = 'gpt-5.4' } = config;
  if (!apiKey) throw new Error('OpenAI API key is required');

  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const ext = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  const requestBody = JSON.stringify({
    model,
    max_completion_tokens: 600,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:${ext};base64,${base64Image}`, detail: 'low' },
          },
          { type: 'text', text: PANAS_PROMPT },
        ],
      },
    ],
  });

  const responseText = await makeRequest(apiKey, requestBody);
  return parsePANASResponse(responseText);
}

/**
 * Fetch the caller's available OpenAI models and filter to vision-capable
 * chat models suitable for PANAS scoring, so the UI can present a real
 * "which model does this key have access to" list instead of a free-text field.
 * @param {string} apiKey
 * @returns {Promise<string[]>}
 */
function listModels(apiKey) {
  if (!apiKey) throw new Error('OpenAI API key is required');
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/models',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`OpenAI API error: ${parsed.error.message}`));
            return;
          }
          const ids = (parsed.data || [])
            .map(m => m.id)
            .filter(id => /^(gpt-4o|gpt-4\.1|gpt-5)/.test(id) && !/audio|realtime|transcribe|tts/.test(id))
            .sort();
          resolve(ids);
        } catch (e) {
          reject(new Error(`Failed to parse OpenAI models response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function makeRequest(apiKey, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
            reject(new Error(`OpenAI API error: ${parsed.error.message}`));
          } else {
            resolve(parsed.choices?.[0]?.message?.content || '');
          }
        } catch (e) {
          reject(new Error(`Failed to parse OpenAI API response: ${e.message}`));
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

module.exports = { scoreImage, listModels };
