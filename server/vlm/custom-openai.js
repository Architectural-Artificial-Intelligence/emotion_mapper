/**
 * custom-openai.js
 * Custom OpenAI-compatible vision provider (e.g., Ollama, vLLM, Together, Llama.cpp),
 * using shared PANAS prompt/parsing logic. Supports HTTP/HTTPS base URLs and optional API keys.
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { PANAS_PROMPT, parsePANASResponse } = require('./panas-prompt');

function normalizeEndpoint(baseUrl, defaultPath) {
  if (!baseUrl) throw new Error('Base URL is required for custom-openai provider');
  let urlStr = baseUrl.trim();
  if (!/^https?:\/\//i.test(urlStr)) {
    urlStr = 'http://' + urlStr;
  }
  urlStr = urlStr.replace(/\/+$/, '');

  if (defaultPath === '/chat/completions') {
    if (!urlStr.endsWith('/chat/completions')) {
      if (urlStr.endsWith('/api') || urlStr.endsWith('/v1')) {
        urlStr += '/chat/completions';
      } else {
        urlStr += '/v1/chat/completions';
      }
    }
  } else if (defaultPath === '/models') {
    if (!urlStr.endsWith('/models')) {
      if (urlStr.endsWith('/chat/completions')) {
        urlStr = urlStr.slice(0, -'/chat/completions'.length) + '/models';
      } else if (urlStr.endsWith('/api') || urlStr.endsWith('/v1')) {
        urlStr += '/models';
      } else {
        urlStr += '/v1/models';
      }
    }
  }
  return new URL(urlStr);
}

/**
 * @param {string} imagePath
 * @param {{apiKey?: string, model: string, baseUrl: string}} config
 */
async function scoreImage(imagePath, config) {
  const { apiKey, model, baseUrl } = config || {};
  if (!baseUrl) throw new Error('Base URL is required for custom-openai provider');
  if (!model) throw new Error('Model is required for custom-openai provider');

  const targetUrl = normalizeEndpoint(baseUrl, '/chat/completions');
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString('base64');
  const ext = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  const requestBody = JSON.stringify({
    model,
    max_tokens: 4096,
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

  const responseText = await makeRequest(targetUrl, 'POST', apiKey, requestBody);
  return parsePANASResponse(responseText);
}

function listModels(apiKey, baseUrl) {
  if (!baseUrl) throw new Error('Base URL is required to list models for custom provider');
  return new Promise((resolve, reject) => {
    let targetUrl;
    try {
      targetUrl = normalizeEndpoint(baseUrl, '/models');
    } catch (e) {
      return reject(e);
    }

    const client = targetUrl.protocol === 'http:' ? http : https;
    const headers = { 'Accept': 'application/json' };
    if (apiKey && apiKey.trim() !== '') {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'http:' ? 80 : 443),
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Server returned HTTP ${res.statusCode}: ${data || res.statusMessage}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Custom API error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
            return;
          }
          const list = parsed.data || (Array.isArray(parsed) ? parsed : []);
          const ids = list
            .map(m => m.id || m.name || (typeof m === 'string' ? m : null))
            .filter(Boolean)
            .sort();
          resolve(ids);
        } catch (e) {
          reject(new Error(`Failed to parse models response from ${targetUrl.href}: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Connection failed to ${targetUrl.href}: ${err.message}`)));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

function makeRequest(targetUrl, method, apiKey, body) {
  return new Promise((resolve, reject) => {
    const client = targetUrl.protocol === 'http:' ? http : https;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (body) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (apiKey && apiKey.trim() !== '') {
      headers['Authorization'] = `Bearer ${apiKey.trim()}`;
    }

    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'http:' ? 80 : 443),
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers,
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Custom inference server returned HTTP ${res.statusCode}: ${data || res.statusMessage}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(`Custom API error: ${parsed.error.message || JSON.stringify(parsed.error)}`));
          } else {
            resolve(parsed.choices?.[0]?.message?.content || '');
          }
        } catch (e) {
          reject(new Error(`Failed to parse API response from ${targetUrl.href}: ${e.message}`));
        }
      });
    });

    req.on('error', (err) => reject(new Error(`Request failed to ${targetUrl.href}: ${err.message}`)));
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('Request timed out after 120s'));
    });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { scoreImage, listModels, normalizeEndpoint };
