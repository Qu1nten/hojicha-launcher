const path = require('path');
const { Worker } = require('worker_threads');
const paths = require('./paths');

// Copying a world folder when sync is switched off, the settings copied in and out around a game, deleting an
// instance: on the main thread these froze the window until they were done. They run in fileWorker.js instead, one
// at a time in the order asked, so a game's settings are always saved (afterExit) before the next launch copies them
// in (beforeLaunch), whatever else was asked meanwhile.
let worker = null;
let nextId = 0;
const waiting = new Map(); // id -> { resolve, reject }

function start() {
  worker = new Worker(path.join(__dirname, 'fileWorker.js'), { workerData: { root: paths.root } });
  worker.on('message', ({ id, result, error }) => {
    const job = waiting.get(id);
    waiting.delete(id);
    if (error !== undefined) job.reject(new Error(error));
    else job.resolve(result);
  });
  // A thread that dies takes its tasks with it: they fail, and the next task starts a new one.
  worker.on('error', (err) => console.error('The file worker stopped:', err));
  worker.on('exit', () => {
    worker = null;
    for (const job of waiting.values()) job.reject(new Error('The file worker stopped unexpectedly. Try again.'));
    waiting.clear();
  });
}

// Runs a task of fileWorker.js: resolves with what it returns, or rejects with its error.
function run(task, ...args) {
  if (!worker) start();
  const id = ++nextId;
  const job = {};
  job.done = new Promise((resolve, reject) => Object.assign(job, { resolve, reject }));
  waiting.set(id, job);
  worker.postMessage({ id, task, args });
  return job.done;
}

// Resolves once no task is waiting or running: closing the launcher waits for this, so a copy is never cut off halfway.
function whenIdle() {
  if (!waiting.size) return Promise.resolve();
  return Promise.allSettled([...waiting.values()].map((job) => job.done)).then(whenIdle);
}

module.exports = { run, whenIdle };
