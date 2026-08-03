/**
 * server/jobs.js
 * Simple in-memory job/progress tracker for long-running ingestion+scoring
 * requests. Prototype-grade: no persistence, no cross-process sharing.
 */

const crypto = require('crypto');

const jobs = new Map();

function createJob(type, meta = {}) {
  const id = crypto.randomUUID();
  const job = {
    id,
    type,
    status: 'pending', // pending | running | done | error
    progress: 0,
    result: null,
    error: null,
    meta,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  return jobs.get(id) || null;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  return job;
}

function startJob(id) {
  return updateJob(id, { status: 'running' });
}

function completeJob(id, result) {
  return updateJob(id, { status: 'done', progress: 100, result });
}

function failJob(id, error) {
  return updateJob(id, { status: 'error', error: error?.message || String(error) });
}

/**
 * Run an async task, tracking it as a job. Returns the job immediately;
 * the task runs in the background.
 */
function runAsJob(type, taskFn, meta = {}) {
  const job = createJob(type, meta);
  startJob(job.id);
  Promise.resolve()
    .then(() => taskFn(job))
    .then(result => completeJob(job.id, result))
    .catch(err => failJob(job.id, err));
  return job;
}

module.exports = { createJob, getJob, updateJob, startJob, completeJob, failJob, runAsJob };
