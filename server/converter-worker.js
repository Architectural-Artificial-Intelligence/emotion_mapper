const { parentPort, workerData } = require('worker_threads');
const { perspectiveFromPanorama, stitchToPanorama } = require('./converter');

async function main() {
  const { task } = workerData;

  if (task === 'stitch') {
    await stitchToPanorama(workerData.inputPath, workerData.outputPath, workerData.options || {});
  } else if (task === 'perspective') {
    await perspectiveFromPanorama(workerData.panoramaPath, workerData.outputPath, workerData.options || {});
  } else {
    throw new Error(`Unknown converter worker task: ${task}`);
  }

  parentPort.postMessage({ ok: true });
}

main().catch(err => {
  parentPort.postMessage({ ok: false, error: err.message });
});
