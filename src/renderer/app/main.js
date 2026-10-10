// The launcher's page, started from index.html. Each part of the page is a module of its own in this folder, which
// wires up its own buttons when it loads; this one loads them all, handles what every popup does, and starts up.
//   core.js            the bridge to main.js (api), shared state, and small helpers used everywhere
//   sidebar.js         the instance and server lists, and the activity pill in the title bar
//   nav.js             which view shows (renderMain), and back and forward through the places visited
//   instance.js        an instance: Play, its status, tabs, Sync and Log, renaming
//   mods.js            the Installed tab: mods, resource packs and shaders, updates, the version picker
//   browse.js          the Browse tab: searching Modrinth
//   newInstance.js     the Create instance window: custom, from a Modrinth modpack, or from a file
//   servers.js         a local server: console, online play (playit.gg), New server, joining
//   serverFiles.js     a server's Settings (server.properties as a form) and Files tabs
//   settings.js        the Settings view, the theme switch, and updates
//   accounts.js        accounts and signing in with Microsoft
//   skins.js           the skin window
//   iconPicker.js      the item icon picker for instances and servers
//   menus.js           the ⋯ menus
//   schematics.js      the Schematics view: folders, tiles, pictures, moving and deleting
//   schematicViewer.js a schematic open big, in 3D
//   drop.js            files dropped anywhere on the launcher
//   closing.js         closing the launcher while something runs
import './closing.js';
import './drop.js';
import { renderAccounts, refreshAccounts } from './accounts.js';
import { api } from './core.js';
import { refreshInstances } from './instance.js';
import { loadSchematics } from './schematics.js';
import { loadOnlinePlay, refreshServers } from './servers.js';
import { loadAppSettings, loadUpdate } from './settings.js';

// A popup's backdrop dims the page, but not the Windows title bar buttons drawn over it: tell main.js when one is
// open so it dims those too.
{
  const dialogs = [...document.querySelectorAll('dialog')];
  let open = false;
  const watcher = new MutationObserver(() => {
    const now = dialogs.some((d) => d.open);
    if (now !== open) api.setPopupOpen((open = now));
  });
  for (const dialog of dialogs) watcher.observe(dialog, { attributes: true, attributeFilter: ['open'] });
}

// A click outside a popup (on its backdrop) closes it, as Escape does: through its cancel event, so a popup that
// refuses Escape refuses this too. The press must start outside as well, so a drag that ends there (turning the
// skin, selecting text) doesn't count. With a menu open in the popup, that click only closes the menu.
for (const dialog of document.querySelectorAll('dialog')) {
  const outside = (event) => {
    if (event.target !== dialog) return false; // the backdrop counts as the dialog itself; its padding does too
    const box = dialog.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
  };
  let pressedOutside = false;
  dialog.addEventListener('pointerdown', (event) => {
    pressedOutside = outside(event) && !dialog.querySelector('.menu:not([hidden])');
  });
  dialog.addEventListener('click', (event) => {
    if (!pressedOutside || !outside(event)) return;
    pressedOutside = false;
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  });
}

// Startup: what main.js knows, then the lists, then what can wait.
(async () => {
  await loadAppSettings();
  await refreshAccounts();
  api.refreshProfiles().then(renderAccounts, () => {}); // new skins show up once Mojang answers
  await refreshInstances();
  await refreshServers();
  await loadOnlinePlay();
  await loadUpdate();
  loadSchematics(); // the count in the sidebar
})();
