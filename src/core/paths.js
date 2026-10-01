const path = require('path');

// Everything the launcher stores lives under one root folder.
// main.js points this at ./data while developing and at the app's userData folder when packaged.
let root = path.join(__dirname, '..', '..', 'data');

module.exports = {
  setRoot(dir) {
    root = dir;
  },
  get root() { return root; },
  get instances() { return path.join(root, 'instances'); },
  get versions() { return path.join(root, 'versions'); },
  get libraries() { return path.join(root, 'libraries'); },
  get assets() { return path.join(root, 'assets'); },
  get runtimes() { return path.join(root, 'runtimes'); },
  get shared() { return path.join(root, 'shared'); },
  get settingsFile() { return path.join(root, 'settings.json'); },
};
