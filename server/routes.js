/**
 * server/routes.js
 * Express routes wrapping the prototype pipeline + heatmap module as HTTP
 * endpoints, per the plan's API surface.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');
const archiver = require('archiver');
const { Worker } = require('worker_threads');

const jobs = require('./jobs');
const { parseDxf } = require('./heatmap/dxf');
const { renderHeatmap, getBounds } = require('./heatmap/render');
const { PANAS_POSITIVE, PANAS_NEGATIVE } = require('./vlm/panas-prompt');
const vlm = require('./vlm');
const { saveResults } = require('./csv');
const { pLimit } = require('./concurrency');
const crypto = require('crypto');

const DATA_DIR = process.env.EMOTION_MAPPER_DATA_DIR
  ? path.resolve(process.env.EMOTION_MAPPER_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const CONVERTER_WORKER_PATH = path.join(__dirname, 'converter-worker.js');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// Same 8-direction scoring targets as the original CLI pipeline.
const DIRECTIONS = [
  { name: 'front',      yaw: 0,   pitch: 0  },
  { name: 'right',      yaw: 90,  pitch: 0  },
  { name: 'back',       yaw: 180, pitch: 0  },
  { name: 'left',       yaw: 270, pitch: 0  },
  { name: 'front-up',   yaw: 0,   pitch: 45 },
  { name: 'right-up',   yaw: 90,  pitch: 45 },
  { name: 'back-up',    yaw: 180, pitch: 45 },
  { name: 'left-up',    yaw: 270, pitch: 45 },
];
const FOV = 90;
const FISHEYE_FOV = 200;
const OUTPUT_SIZE = 1024;

// How many photos / perspective slices / VLM calls run in parallel. See
// CLAUDE.md for the tuning rationale behind each default.
const IMAGE_CONCURRENCY = parseInt(process.env.PANAS_IMAGE_CONCURRENCY, 10) || 2;
const PROJECTION_CONCURRENCY = parseInt(process.env.PANAS_PROJECTION_CONCURRENCY, 10)
  || Math.min(4, Math.max(1, os.cpus().length - 1));
const LLM_CONCURRENCY = parseInt(process.env.PANAS_LLM_CONCURRENCY, 10) || 3;

const imageLimit = pLimit(IMAGE_CONCURRENCY);
const projectionLimit = pLimit(PROJECTION_CONCURRENCY);
const llmLimit = pLimit(LLM_CONCURRENCY);

const router = express.Router();

// ---------------------------------------------------------------------------
// In-memory state (prototype-grade)
// ---------------------------------------------------------------------------
const projects = new Map();       // projectId -> { id, dir, name, dxf, placements }
const photos = new Map();         // photoId -> { id, projectId, imagePath, outputDir, scores: {direction: row}, status }

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function writeSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function statePath(project) {
  return path.join(project.dir, 'state.json');
}

// `project.dxf.parsed`/`bounds` are derived from the plan.dxf file already
// saved on disk, so they're excluded here and rebuilt by re-parsing on load
// (see loadProjectsFromDisk) instead of being duplicated into every write.
function persistProject(project) {
  const photosForProject = [...photos.values()].filter(p => p.projectId === project.id);
  const { dir, ...projectFields } = project;
  const serializableProject = {
    ...projectFields,
    dxf: project.dxf ? { path: project.dxf.path } : null,
  };
  fs.writeFileSync(statePath(project), JSON.stringify({ project: serializableProject, photos: photosForProject }, null, 2));
}

function loadProjectsFromDisk() {
  let entries;
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, entry.name);
    const file = path.join(dir, 'state.json');
    if (!fs.existsSync(file)) continue;
    try {
      const { project: projectFields, photos: savedPhotos } = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const project = { ...projectFields, dir };
      if (project.dxf && project.dxf.path && fs.existsSync(project.dxf.path)) {
        const wallLayers = project.layerSelection ? project.layerSelection.wallLayers : undefined;
        const parsed = parseDxf(project.dxf.path, wallLayers ? { wallLayers } : {});
        project.dxf = { path: project.dxf.path, parsed, bounds: getBounds(parsed.wallSegments, parsed.points) };
      } else {
        project.dxf = null;
      }
      projects.set(project.id, project);
      for (const photo of savedPhotos || []) {
        photos.set(photo.id, photo);
      }
    } catch (e) {
      console.error(`Failed to load project state from ${file}:`, e.message);
    }
  }
}

loadProjectsFromDisk();

function touchProject(project, step) {
  project.lastEdited = Date.now();
  if (step !== undefined) project.currentStep = step;
  persistProject(project);
}

function photoCountFor(projectId) {
  let count = 0;
  for (const photo of photos.values()) {
    if (photo.projectId === projectId) count += 1;
  }
  return count;
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    lastEdited: project.lastEdited,
    currentStep: project.currentStep || 1,
    planImported: !!project.dxf,
    wallsSelected: !!project.layerSelection,
    photoCount: photoCountFor(project.id),
  };
}

// ---------------------------------------------------------------------------
// Multer upload configs
// ---------------------------------------------------------------------------
const UPLOAD_DIR = path.join(os.tmpdir(), 'emotion-mapper-uploads');
const uploadDxf = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024, files: 1 } });
const uploadImages = multer({ dest: UPLOAD_DIR, limits: { fileSize: 100 * 1024 * 1024, files: 20 } });

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
router.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// POST /project — create/open a project (a folder under a data dir)
// ---------------------------------------------------------------------------
router.post('/project', express.json(), (req, res) => {
  const name = (req.body && req.body.name) || `project-${Date.now()}`;
  const id = name.replace(/[^a-z0-9_-]/gi, '_');
  const dir = path.join(PROJECTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });

  const project = projects.get(id) || {
    id, dir, name,
    dxf: null,
    placements: {}, // photoId -> {x, y}
    createdAt: Date.now(),
    lastEdited: Date.now(),
    currentStep: 1,
  };
  projects.set(id, project);
  touchProject(project, project.currentStep || 1);

  res.json({ id: project.id, name: project.name, dir: project.dir });
});

// ---------------------------------------------------------------------------
// GET /projects — list all projects for the dashboard
// ---------------------------------------------------------------------------
router.get('/projects', (req, res) => {
  const list = [...projects.values()]
    .map(projectSummary)
    .sort((a, b) => b.lastEdited - a.lastEdited);
  res.json({ projects: list });
});

// ---------------------------------------------------------------------------
// GET /project/:id — rehydrate a single project's client state
// ---------------------------------------------------------------------------
router.get('/project/:id', (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  res.json({
    ...projectSummary(project),
    planBounds: project.dxf ? project.dxf.bounds : null,
    wallSegments: project.dxf ? project.dxf.parsed.wallSegments : null,
    wallLayers: project.layerSelection ? project.layerSelection.wallLayers : null,
    contextLayers: project.layerSelection ? project.layerSelection.contextLayers : null,
  });
});

// ---------------------------------------------------------------------------
// PATCH /project/:id — { name?, currentStep? }
// ---------------------------------------------------------------------------
router.patch('/project/:id', express.json(), (req, res) => {
  const project = projects.get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const { name, currentStep } = req.body || {};
  if (typeof name === 'string' && name.trim()) project.name = name.trim();
  if (typeof currentStep === 'number') project.currentStep = currentStep;
  touchProject(project, typeof currentStep === 'number' ? currentStep : undefined);
  res.json(projectSummary(project));
});

// ---------------------------------------------------------------------------
// POST /plan/import — upload DXF, return wall layer list + parsed points
// ---------------------------------------------------------------------------
router.post('/plan/import', uploadDxf.single('dxf'), (req, res) => {
  try {
    const projectId = req.query.projectId || req.body?.projectId;
    if (!req.file) return res.status(400).json({ error: 'dxf file is required (field name "dxf")' });

    const parsed = parseDxf(req.file.path);
    const bounds = getBounds(parsed.wallSegments, parsed.points);

    if (projectId && projects.has(projectId)) {
      const project = projects.get(projectId);
      const dest = path.join(project.dir, 'plan.dxf');
      fs.copyFileSync(req.file.path, dest);
      project.dxf = { path: dest, parsed, bounds };
      touchProject(project, 2);
    }

    res.json({
      wallLayers: parsed.wallLayers,
      allLayers: parsed.allLayers,
      layerDetails: parsed.layerDetails,
      wallSegmentCount: parsed.wallSegments.length,
      points: parsed.points,
      bounds,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

// ---------------------------------------------------------------------------
// POST /plan/wall-layers — { projectId, wallLayers, contextLayers } -> re-parse
// the already-uploaded plan.dxf restricted to the chosen wall layers.
// ---------------------------------------------------------------------------
router.post('/plan/wall-layers', express.json(), (req, res) => {
  const { projectId, wallLayers, contextLayers } = req.body || {};
  const project = projects.get(projectId);
  if (!project || !project.dxf) {
    return res.status(400).json({ error: 'project with an imported DXF plan is required' });
  }
  if (!Array.isArray(wallLayers)) {
    return res.status(400).json({ error: 'wallLayers must be an array of layer names' });
  }

  const parsed = parseDxf(project.dxf.path, { wallLayers });
  const bounds = getBounds(parsed.wallSegments, parsed.points);

  project.dxf.parsed = parsed;
  project.dxf.bounds = bounds;
  project.layerSelection = { wallLayers, contextLayers: contextLayers || [] };
  touchProject(project, 3);

  res.json({
    wallSegments: parsed.wallSegments,
    wallSegmentCount: parsed.wallSegments.length,
    points: parsed.points,
    bounds,
    layerDetails: parsed.layerDetails,
  });
});

// ---------------------------------------------------------------------------
// GET /plan/layer-selection?projectId= — last-applied wall/context layer choice
// ---------------------------------------------------------------------------
router.get('/plan/layer-selection', (req, res) => {
  const project = projects.get(req.query.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  res.json(project.layerSelection || null);
});

// ---------------------------------------------------------------------------
// GET /plan/walls?projectId= — walls-only JSON, independent of scored data
// ---------------------------------------------------------------------------
router.get('/plan/walls', (req, res) => {
  const project = projects.get(req.query.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  if (!project.dxf) {
    return res.status(400).json({ error: 'project has no imported DXF plan' });
  }
  res.json({
    wallSegments: project.dxf.parsed.wallSegments,
    bounds: project.dxf.bounds,
    points: project.dxf.parsed.points,
  });
});

// ---------------------------------------------------------------------------
// POST /photos/ingest — upload 360 image(s), enqueue stitch+slice job
// ---------------------------------------------------------------------------
function runConverterWorker(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(CONVERTER_WORKER_PATH, { workerData });
    worker.once('message', msg => {
      if (msg.ok) resolve();
      else reject(new Error(msg.error || 'Converter worker failed'));
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`Converter worker exited with code ${code}`));
    });
  });
}

async function scorePhoto(photo, config) {
  photo.status = 'scoring';
  await Promise.all(photo.perspectiveImages.map(img => llmLimit(async () => {
    try {
      const panasScores = await vlm.scoreImage(img.filePath, config);
      photo.scores[img.direction] = {
        source_image: photo.baseName,
        direction: img.direction,
        output_file: img.fileName,
        ...panasScores,
      };
    } catch (err) {
      photo.scores[img.direction] = {
        source_image: photo.baseName,
        direction: img.direction,
        output_file: img.fileName,
        error: err.message,
      };
    }
  })));

  const csvPath = path.join(photo.outputDir, `${photo.baseName}_panas.csv`);
  const orderedRows = DIRECTIONS.map(d => photo.scores[d.name]).filter(Boolean);
  saveResults(orderedRows, csvPath);

  const allFailed = orderedRows.length > 0 && orderedRows.every(r => r.error);
  if (allFailed) {
    photo.status = 'error';
    photo.error = orderedRows[0].error;
  } else {
    photo.status = 'scored';
  }
  photo.csvPath = csvPath;
  if (photo.projectId && projects.has(photo.projectId)) {
    touchProject(projects.get(photo.projectId));
  }
  return { csvPath, rows: orderedRows };
}

function resolveVlmConfig(body) {
  const settings = readSettings();
  return {
    provider: body?.provider || settings.provider || 'openai',
    apiKey: body?.apiKey || settings.apiKey,
    model: body?.model || settings.model,
    baseUrl: body?.baseUrl || settings.baseUrl,
  };
}

// Every VLM call needs configuration; a partially-configured provider
// (e.g. missing API key or Base URL) must block
// uploads instead of failing later inside the async scoring job.
function missingVlmConfigError(config) {
  if (!vlm.PROVIDERS[config.provider]) {
    return `Unknown or unset VLM provider: ${config.provider}. Expected "openai", "anthropic", or "custom-openai".`;
  }
  if (config.provider === 'custom-openai') {
    if (!config.baseUrl) {
      return 'No Base URL configured for custom provider. POST /settings/vlm-config first, or pass baseUrl in body.';
    }
  } else if (!config.apiKey) {
    return 'No API key configured. POST /settings/vlm-config first, or pass apiKey in body.';
  }
  if (!config.model) {
    return 'No model configured. POST /settings/vlm-config with a model first, or pass model in body.';
  }
  return null;
}

router.post('/photos/ingest', uploadImages.array('images'), (req, res) => {
  const projectId = req.query.projectId || req.body?.projectId;
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'at least one image file is required (field name "images")' });
  }
  const config = resolveVlmConfig(req.body);
  const configError = missingVlmConfigError(config);
  if (configError) {
    return res.status(400).json({ error: configError });
  }
  const project = projectId && projects.get(projectId);
  const baseDir = project ? project.dir : DATA_DIR;

  const uploadedFiles = req.files.map(f => ({ tmpPath: f.path, originalname: f.originalname }));

  const job = jobs.runAsJob('photos.ingest', async (job) => {
    const results = await Promise.all(uploadedFiles.map(file => imageLimit(async () => {
      const photoId = crypto.randomUUID();
      const baseName = path.basename(file.originalname, path.extname(file.originalname)).replace(/[^a-z0-9_-]/gi, '_');
      const photoOutputDir = path.join(baseDir, 'photos', photoId);
      fs.mkdirSync(photoOutputDir, { recursive: true });

      const srcPath = path.join(photoOutputDir, `source${path.extname(file.originalname) || '.jpg'}`);
      fs.copyFileSync(file.tmpPath, srcPath);
      fs.unlink(file.tmpPath, () => {});

      const eqPath = path.join(photoOutputDir, `${baseName}_equirectangular.png`);
      await runConverterWorker({
        task: 'stitch',
        inputPath: srcPath,
        outputPath: eqPath,
        options: { fisheyeFov: FISHEYE_FOV },
      });

      const perspectiveImages = await Promise.all(DIRECTIONS.map(direction => projectionLimit(async () => {
        const outFileName = `${baseName}_${direction.name}.png`;
        const outFilePath = path.join(photoOutputDir, outFileName);
        await runConverterWorker({
          task: 'perspective',
          panoramaPath: eqPath,
          outputPath: outFilePath,
          options: {
            yaw: direction.yaw, pitch: direction.pitch, fov: FOV,
            width: OUTPUT_SIZE, height: OUTPUT_SIZE,
          },
        });
        return { direction: direction.name, filePath: outFilePath, fileName: outFileName };
      })));

      const photo = {
        id: photoId,
        projectId: projectId || null,
        baseName,
        outputDir: photoOutputDir,
        equirectangular: eqPath,
        perspectiveImages,
        scores: {},
        status: 'ingested',
      };
      photos.set(photoId, photo);

      await scorePhoto(photo, config);

      return { photoId, baseName, perspectiveImages: perspectiveImages.map(p => p.fileName) };
    })));
    if (project) touchProject(project);
    return { photos: results };
  }, { projectId });

  res.status(202).json({ jobId: job.id, status: job.status });
});

// ---------------------------------------------------------------------------
// POST /photos/:id/score — enqueue PANAS (re-)scoring job (manual re-score)
// GET  /photos/:id/score — current score/status
// ---------------------------------------------------------------------------
router.post('/photos/:id/score', express.json(), (req, res) => {
  const photo = photos.get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'photo not found' });

  const config = resolveVlmConfig(req.body);
  const configError = missingVlmConfigError(config);
  if (configError) {
    return res.status(400).json({ error: configError });
  }

  const job = jobs.runAsJob('photos.score', async (job) => {
    const { csvPath, rows } = await scorePhoto(photo, config);
    return { photoId: photo.id, csvPath, rows };
  }, { photoId: photo.id });

  res.status(202).json({ jobId: job.id, status: job.status });
});

// ---------------------------------------------------------------------------
// GET /photos?projectId= — photo list with derived status/placement
// ---------------------------------------------------------------------------
router.get('/photos', (req, res) => {
  const projectId = req.query.projectId;
  const project = projects.get(projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  const list = [...photos.values()]
    .filter(p => p.projectId === projectId)
    .map(p => ({
      id: p.id,
      baseName: p.baseName,
      status: p.status,
      error: p.error || null,
      placed: !!project.placements[p.id],
      placement: project.placements[p.id] || null,
      thumbnailUrl: `/photo-thumb/${p.id}`,
      scores: scoreSummary(p),
    }));
  res.json({ photos: list });
});

// ---------------------------------------------------------------------------
// GET /photo-thumb/:id — a representative image for gallery thumbnails
// ---------------------------------------------------------------------------
router.get('/photo-thumb/:id', (req, res) => {
  const photo = photos.get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'photo not found' });
  const front = photo.perspectiveImages.find(p => p.direction === 'front');
  const filePath = (front && front.filePath) || photo.equirectangular;
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'thumbnail source not found' });
  }
  res.sendFile(filePath);
});

router.get('/photos/:id/score', (req, res) => {
  const photo = photos.get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'photo not found' });
  res.json({
    photoId: photo.id,
    status: photo.status,
    scores: photo.scores,
    csvPath: photo.csvPath || null,
  });
});

// ---------------------------------------------------------------------------
// GET /jobs/:id — poll job progress
// ---------------------------------------------------------------------------
router.get('/jobs/:id', (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// ---------------------------------------------------------------------------
// POST /placements — save a photo's DXF-space x,y
// ---------------------------------------------------------------------------
router.post('/placements', express.json(), (req, res) => {
  const { projectId, photoId, x, y, code } = req.body || {};
  if (!projectId || !photos.has(photoId) || x === undefined || y === undefined) {
    return res.status(400).json({ error: 'projectId, photoId, x, y are required' });
  }
  const project = projects.get(projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });

  project.placements[photoId] = { x, y, code: code || photoId };
  touchProject(project);
  res.json({ ok: true, placements: project.placements });
});

// ---------------------------------------------------------------------------
// GET /placements?projectId= — existing marker positions
// ---------------------------------------------------------------------------
router.get('/placements', (req, res) => {
  const project = projects.get(req.query.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  res.json({ placements: project.placements });
});

// ---------------------------------------------------------------------------
// DELETE /placements/:photoId?projectId= — unplace a photo (moves it back to
// the sidebar's unplaced list) without deleting the photo itself.
// ---------------------------------------------------------------------------
router.delete('/placements/:photoId', (req, res) => {
  const project = projects.get(req.query.projectId);
  if (!project) return res.status(404).json({ error: 'project not found' });
  delete project.placements[req.params.photoId];
  touchProject(project);
  res.json({ ok: true, placements: project.placements });
});

// ---------------------------------------------------------------------------
// DELETE /photos/:id — remove a photo entirely: its placement (if any),
// in-memory record, and files on disk.
// ---------------------------------------------------------------------------
router.delete('/photos/:id', (req, res) => {
  const photo = photos.get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'photo not found' });

  const project = photo.projectId && projects.get(photo.projectId);
  if (project) {
    delete project.placements[photo.id];
    touchProject(project);
  }
  photos.delete(photo.id);

  if (photo.outputDir) {
    fs.rm(photo.outputDir, { recursive: true, force: true }, () => {});
  }

  res.json({ ok: true });
});

// Builds the PNG for a single emotion/score dimension of a project's heatmap.
// Shared by GET /heatmap (one dimension) and GET /heatmap/all (all dimensions,
// zipped). Returns null if there's nothing scored/placed to render yet.
function renderHeatmapForEmotion(project, emotion) {
  const { wallSegments } = project.dxf.parsed;

  // Build measurementPoints from placements, scores from photo averages
  const measurementPoints = {};
  const scores = {};
  for (const [photoId, placement] of Object.entries(project.placements)) {
    const photo = photos.get(photoId);
    if (!photo) continue;
    const code = placement.code || photoId;
    measurementPoints[code] = [placement.x, placement.y];

    const rows = Object.values(photo.scores).filter(r => !r.error);
    if (rows.length === 0) continue;

    let value;
    if (emotion === 'positive_affect' || emotion === 'positive_affect_score') {
      value = average(rows.map(r => r.positive_affect_score));
    } else if (emotion === 'negative_affect' || emotion === 'negative_affect_score') {
      value = average(rows.map(r => r.negative_affect_score));
    } else if (emotion === 'pa_minus_na' || emotion === 'net_affect_score') {
      value = average(rows.map(r => r.net_affect_score));
    } else {
      value = average(rows.map(r => r[emotion]).filter(v => v !== undefined));
    }
    if (value !== undefined && !Number.isNaN(value)) scores[code] = value;
  }

  // Fixed ranges (not auto-scaled from this run's data) so the red/yellow/green
  // scale means the same thing across renders: yellow is always "neutral".
  // PA/NA are sums of 10 PANAS items scored 1-5 each (range 10-50, neutral 30);
  // net affect (PA-NA) ranges -40..40 with neutral at 0.
  let vmin, vmax;
  if (emotion === 'pa_minus_na' || emotion === 'net_affect_score') {
    vmin = -40; vmax = 40;
  } else if (PANAS_POSITIVE.includes(emotion) || PANAS_NEGATIVE.includes(emotion)) {
    vmin = 1; vmax = 5;
  } else {
    vmin = 10; vmax = 50;
  }

  return renderHeatmap({
    wallSegments,
    measurementPoints,
    scores,
    bounds: project.dxf.bounds,
    vmin,
    vmax,
  });
}

// ---------------------------------------------------------------------------
// GET /heatmap?floor=&emotion=&projectId=
// ---------------------------------------------------------------------------
router.get('/heatmap', (req, res) => {
  try {
    const { projectId, emotion = 'positive_affect' } = req.query;
    const project = projects.get(projectId);
    if (!project || !project.dxf) {
      return res.status(400).json({ error: 'project with an imported DXF plan is required' });
    }

    const png = renderHeatmapForEmotion(project, emotion);

    if (!png) {
      return res.status(422).json({ error: 'No scored/placed data available to render a heatmap yet.' });
    }

    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /heatmap/all?projectId=
// Zips up every PANAS dimension's heatmap (PA, NA, PA-NA, and each of the 20
// individual items) into a single downloadable archive.
// ---------------------------------------------------------------------------
router.get('/heatmap/all', (req, res) => {
  try {
    const { projectId } = req.query;
    const project = projects.get(projectId);
    if (!project || !project.dxf) {
      return res.status(400).json({ error: 'project with an imported DXF plan is required' });
    }

    const emotions = ['positive_affect', 'negative_affect', 'pa_minus_na', ...PANAS_POSITIVE, ...PANAS_NEGATIVE];
    const rendered = emotions
      .map(emotion => ({ emotion, png: renderHeatmapForEmotion(project, emotion) }))
      .filter(({ png }) => png);

    if (rendered.length === 0) {
      return res.status(422).json({ error: 'No scored/placed data available to render a heatmap yet.' });
    }

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${projectId}-heatmaps.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => res.status(500).json({ error: err.message }));
    archive.pipe(res);
    for (const { emotion, png } of rendered) {
      archive.append(png, { name: `${emotion}.png` });
    }
    archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function scoreSummary(photo) {
  const rows = Object.values(photo.scores || {}).filter(r => !r.error);
  if (rows.length === 0) return null;
  return {
    positive_affect: average(rows.map(r => r.positive_affect_score)),
    negative_affect: average(rows.map(r => r.negative_affect_score)),
    net_affect: average(rows.map(r => r.net_affect_score)),
  };
}

function average(arr) {
  const nums = arr.filter(v => typeof v === 'number' && !Number.isNaN(v));
  if (nums.length === 0) return undefined;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// ---------------------------------------------------------------------------
// POST /settings/vlm-config — { provider, apiKey, model, baseUrl } -> local JSON file
// ---------------------------------------------------------------------------
router.post('/settings/vlm-config', express.json(), (req, res) => {
  const { provider, apiKey, model, baseUrl } = req.body || {};
  if (!provider) {
    return res.status(400).json({ error: 'provider is required' });
  }
  if (!vlm.PROVIDERS[provider]) {
    return res.status(400).json({ error: `unknown provider "${provider}"; expected openai, anthropic, or custom-openai` });
  }
  if (provider === 'custom-openai') {
    if (!baseUrl) {
      return res.status(400).json({ error: 'baseUrl is required for custom-openai provider' });
    }
  } else if (!apiKey) {
    return res.status(400).json({ error: 'provider and apiKey are required' });
  }
  if (!model) {
    return res.status(400).json({ error: 'model is required; fetch available models via POST /settings/vlm-models first' });
  }
  const settings = { provider, apiKey: apiKey || '', model, baseUrl: baseUrl || '' };
  writeSettings(settings);
  res.json({ ok: true, provider, model: settings.model, baseUrl: settings.baseUrl, apiKeySet: !!settings.apiKey });
});

// ---------------------------------------------------------------------------
// POST /settings/vlm-models — { provider, apiKey?, baseUrl? } -> list models available
// to this key/url, so the UI can require the user to pick one instead of typing
// a model string blind. POST (not GET+query) so the API key never lands in
// a URL, access log, or browser history.
// ---------------------------------------------------------------------------
router.post('/settings/vlm-models', express.json(), async (req, res) => {
  const { provider } = req.body || {};
  const apiKey = req.body?.apiKey || readSettings().apiKey;
  const baseUrl = req.body?.baseUrl || readSettings().baseUrl;
  if (!vlm.PROVIDERS[provider]) {
    return res.status(400).json({ error: `unknown provider "${provider}"; expected openai, anthropic, or custom-openai` });
  }
  if (provider !== 'custom-openai' && !apiKey) {
    return res.status(400).json({ error: 'apiKey is required' });
  }
  if (provider === 'custom-openai' && !baseUrl) {
    return res.status(400).json({ error: 'baseUrl is required' });
  }
  try {
    const models = await vlm.PROVIDERS[provider].listModels(apiKey, baseUrl);
    res.json({ models });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/settings/vlm-config', (req, res) => {
  const settings = readSettings();
  res.json({
    provider: settings.provider || null,
    model: settings.model || null,
    baseUrl: settings.baseUrl || null,
    apiKeySet: !!settings.apiKey,
    apiKeySuffix: settings.apiKey ? settings.apiKey.slice(-4) : null,
  });
});

module.exports = router;
