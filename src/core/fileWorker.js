// The slow file work (fileTasks.js): copying and linking shared folders, deleting instances, tidying up at startup.
// Runs in a thread of its own, one task at a time, so the launcher's window stays responsive meanwhile.
const { parentPort, workerData } = require('worker_threads');
const paths = require('./paths');

paths.setRoot(workerData.root);
const instances = require('./instances');
const sync = require('./sync');
const modrinth = require('./modrinth');
const store = require('./store');

const TASKS = {
  setSync: (id, item, enabled) => sync.setSync(id, item, enabled),
  beforeLaunch: (instance) => sync.beforeLaunch(instance),
  markLoaded: (instance) => sync.markLoaded(instance),
  afterExit: (id) => sync.afterExit(instances.get(id)),
  deleteInstance: (id) => sync.deleteInstance(id),
  linkFolders: (id) => sync.linkFolders(instances.get(id)),
  // Before the page may ask for anything (see main.js).
  startup: () => {
    sync.relinkAll();
    modrinth.settleAll(); // pack details move to the shared folder they belong with
    store.prune(); // mods and packs no instance has any more (before anything downloads)
  },
};

parentPort.on('message', ({ id, task, args }) => {
  try {
    parentPort.postMessage({ id, result: TASKS[task](...args) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
