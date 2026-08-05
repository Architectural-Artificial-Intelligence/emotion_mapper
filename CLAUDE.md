# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Emotion Mapper: processes 360° dual-fisheye photos into PANAS (Positive and Negative Affect Schedule) emotion scores via a vision-language model, then renders those scores as geodesic (wall-aware) heatmaps over architectural floor plans (DXF).

Everything lives in one Node.js/Express app now: **`server/` + `public/`**. It used to be split between a standalone `prototype/` CLI pipeline and a server that wrapped it; the pipeline modules (`converter.js`, `converter-worker.js`, `csv.js`) have since been merged straight into `server/`, and `prototype/` has been deleted. This is a prototype, not a packaged desktop app — the longer-term plan is Tauri packaging (the actual processing core is Node, not Python).

## Commands

```bash
npm install         # installs everything: express, multer, dxf-parser, canvas, sharp
npm start            # or: npm run server — starts Express on http://localhost:3000 (PORT env var to override)
```

No test suite (beyond `server/heatmap/dxf.test.js`, run via `npm test`) or lint config exists yet.

Concurrency env vars: `PANAS_IMAGE_CONCURRENCY` (default 2), `PANAS_PROJECTION_CONCURRENCY` (default cpus-1, max 4), `PANAS_LLM_CONCURRENCY` (default 3) — enforced via the `pLimit()` pools in `server/concurrency.js`, wired up in `server/routes.js`.

## Architecture

### Pipeline

1. **Stitch**: dual-fisheye source photo → equirectangular panorama (`server/converter.js: stitchFisheyeToEquirectangular`)
2. **Slice**: equirectangular → 8 perspective crops (front/right/back/left × 0° and 45° pitch, defined in `server/routes.js` DIRECTIONS)
3. **Score**: each perspective image sent to a VLM with a PANAS-rating prompt, returns 20 item scores (1–5) + aggregate PA/NA/net scores
4. **Persist**: results written as CSV with a computed summary row (`server/csv.js`)
5. **Heatmap**: scores at known (x, y) plan positions → geodesic (wall-aware, not straight-line) inverse-distance-weighted interpolation → rendered image overlaid on the floor plan's walls

Steps 1–2 run in `worker_threads` (`server/converter-worker.js`) for parallelism; `server/routes.js` spawns this worker file directly rather than importing `converter.js` on the main thread.

### VLM provider abstraction

A pluggable interface so the backend is swappable per request or via stored settings:

- `server/vlm/panas-prompt.js` — the PANAS prompt text, item lists, and response parsing, shared by every provider so scoring semantics stay identical regardless of backend.
- `server/vlm/openai.js`, `server/vlm/anthropic.js`, `server/vlm/custom-openai.js` — one file per provider, each implementing `scoreImage(imagePath, config)`. `custom-openai.js` supports custom base URLs (e.g. Ollama, vLLM, Together) with optional API keys.
- `server/vlm/index.js` — dispatches on `config.provider` (`PROVIDERS` map: `openai`, `anthropic`, `custom-openai`).
- Provider + API key + optional model override (and `baseUrl` for custom endpoints) are stored via `POST /settings/vlm-config` → `data/settings.json`, and can also be overridden per-request in the `POST /photos/:id/score` body.

### Heatmap (`server/heatmap/`)

One file per stage, originally a faithful port of a Python script (long since removed — this JS version is now the only implementation):

- `dxf.js` — DXF parsing via `dxf-parser` npm package. Extracts wall line segments from `LINE`/`LWPOLYLINE`/`POLYLINE`/`ARC` entities on a fixed wall-layer allowlist, `POINT` entities on grid-point layers, and `MTEXT` labels on grid-name layers, then nearest-matches each label to its closest point.
- `geodesic.js` — rasterizes walls onto a boolean grid, then Dijkstra flood-fill (8-connected) from each measurement point to get wall-aware distances, then inverse-distance-weighted blending (power=2) across all measurement points.
- `render.js` — draws the interpolated grid, wall lines, point markers/labels, and a color legend onto a `canvas` `Image`/PNG buffer. Colormap cycles across runs via `data/.heatmap_run_counter`.

### Server state model

Everything in `server/routes.js` is **in-memory** (`Map()`s for `projects` and `photos`) plus files under `data/` — there is no database, and state is lost on restart except for what's been written to disk (`data/projects/<id>/plan.dxf`, `data/projects/<id>/photos/<photoId>/...`, `data/settings.json`). Long-running work (photo ingestion, scoring) runs through `server/jobs.js`, a simple in-memory job tracker (`pending`/`running`/`done`/`error`) — poll via `GET /jobs/:id`. This is intentionally prototype-grade; don't add a real database or job queue without discussing scope first.

### API surface

`GET /health`, `POST /project`, `POST /plan/import`, `POST /photos/ingest`, `POST /photos/:id/score` (GET + POST), `GET /jobs/:id`, `POST /placements`, `GET /heatmap`, `GET`/`POST /settings/vlm-config`, `POST /settings/vlm-models`. All defined in `server/routes.js`.

### Frontend

`public/` is plain HTML/JS/CSS with no build step — `index.html` plus one `.js` file per view (`settings.js`, `plan-editor.js`, `placement.js`, `heatmap-view.js`), each calling the Express API via `fetch()`. Served as static files by `server/app.js`.
