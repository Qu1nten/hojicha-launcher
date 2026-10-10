import { $, api, current, state } from './core.js';
import { renderInstance, selectInstance, showTab } from './instance.js';
import { openSchematic, schemOpen } from './schematicViewer.js';
import { closeSchematicMenu, openSchematicFolder, openSchematics, renderSchematics, schem } from './schematics.js';
import { askDiscard, dropEdits, hasUnsaved } from './serverFiles.js';
import { currentServer, renderServer, selectServer, showServerTab } from './servers.js';
import { openSettings, renderAppSettings } from './settings.js';

export function renderMain() {
  const showSchematics = state.view === 'schematics';
  const showSettings = state.view === 'settings';
  const showServer = !showSettings && !showSchematics && state.view === 'server' && currentServer();
  const showInstance = !showSettings && !showSchematics && !showServer && current();
  $('#empty').hidden = Boolean(showSchematics || showSettings || showServer || showInstance);
  $('#schematics-view').hidden = !showSchematics;
  $('#settings-view').hidden = !showSettings;
  $('#server-view').hidden = !showServer;
  $('#instance-view').hidden = !showInstance;
  if (showSchematics) renderSchematics();
  if (showSettings) renderAppSettings();
  if (showServer) renderServer();
  if (showInstance) renderInstance();
  remember();
}

// Where you've been: an instance or server, and its tab; in Schematics, the folder and the schematic open in the 3D
// view (id: the folder's keys as JSON, tab: the open one's path). The mouse's back and forward buttons (and Alt+Left
// and Alt+Right) step through it like a browser. Places deleted since are skipped.
export const nav = { stack: [], index: -1, moving: false, lastStep: 0 };
const MAX_HISTORY = 50;

export function here() {
  if (state.view === 'settings') return { view: 'settings', id: '', tab: '' };
  if (state.view === 'schematics') return { view: 'schematics', id: JSON.stringify(schem.at), tab: schemOpen.item?.path || '' };
  if (state.view === 'server' && currentServer()) return { view: 'server', id: state.selectedServer, tab: state.serverTab };
  if (current()) return { view: 'instance', id: state.selected, tab: state.tab };
  return null;
}

function samePlace(a, b) {
  return Boolean(a && b) && a.view === b.view && a.id === b.id && a.tab === b.tab;
}

export function remember() {
  if (nav.moving) return;
  const place = here();
  if (!place || samePlace(place, nav.stack[nav.index])) return;
  nav.stack.splice(nav.index + 1, Infinity, place); // a new place drops the forward history, as in a browser
  if (nav.stack.length > MAX_HISTORY) nav.stack.shift();
  nav.index = nav.stack.length - 1;
}

// Goes to a remembered place. Returns false if unsaved changes kept us where we were.
function goTo(place) {
  nav.moving = true;
  try {
    if (place.view !== 'schematics' && $('#schem-dialog').open) {
      $('#schem-dialog').close(); // stepping away from a schematic open in 3D
      schemOpen.item = null;
    }
    if (place.view === 'settings') {
      openSettings();
    } else if (place.view === 'schematics') {
      goToSchematics(place);
    } else if (place.view === 'server') {
      selectServer(place.id);
      if (state.view === 'server' && state.selectedServer === place.id) showServerTab(place.tab);
    } else {
      const switching = !(state.view === 'instance' && state.selected === place.id);
      const tab = state.tab;
      if (switching) state.tab = place.tab; // the instance opens straight on its tab
      selectInstance(place.id);
      if (state.view !== 'instance' || state.selected !== place.id) state.tab = tab;
      else if (state.tab !== place.tab) showTab(place.tab);
    }
  } finally {
    nav.moving = false;
  }
  return samePlace(here(), place);
}

// A Schematics place: its folder (or the nearest one above it still there), with the schematic open in the 3D view or
// the view closed.
function goToSchematics(place) {
  if (state.view !== 'schematics') openSchematics();
  closeSchematicMenu();
  if (schem.filter) {
    schem.filter = '';
    $('#schem-filter').value = '';
  }
  const keys = JSON.parse(place.id || '[]');
  if (JSON.stringify(keys) !== JSON.stringify(schem.at)) openSchematicFolder(keys);
  const item = place.tab && schem.items?.find((one) => one.path === place.tab);
  if (item) {
    if (schemOpen.item?.path !== item.path) openSchematic(item);
  } else if ($('#schem-dialog').open) {
    $('#schem-dialog').close();
    schemOpen.item = null; // now, not when the close event comes: here() asks straight after
  }
}

// Whether a remembered place is still there to go back to.
function placeExists(place) {
  if (place.view === 'settings') return true;
  if (place.view === 'schematics') return !place.tab || !schem.items || schem.items.some((item) => item.path === place.tab);
  if (place.view === 'server') return state.servers.some((s) => s.id === place.id);
  return state.instances.some((inst) => inst.id === place.id);
}

function stepHistory(direction) {
  // One press can arrive twice (a mouse event and a Windows app command): take the first.
  if (Date.now() - nav.lastStep < 80) return;
  nav.lastStep = Date.now();
  // A popup keeps you where you are, except the schematic 3D view, which back and forward go in and out of.
  if ([...document.querySelectorAll('dialog[open]')].some((dialog) => dialog.id !== 'schem-dialog')) return;
  // Stepping away from unsaved server edits: ask first, then take the same step.
  if (state.view === 'server' && hasUnsaved()) {
    askDiscard().then((discard) => {
      if (!discard) return;
      dropEdits();
      nav.lastStep = 0;
      stepHistory(direction);
    });
    return;
  }
  for (let i = nav.index + direction; i >= 0 && i < nav.stack.length; i += direction) {
    const place = nav.stack[i];
    if (!placeExists(place)) continue;
    if (goTo(place)) nav.index = i;
    return;
  }
}

// Mouse buttons 4 (back) and 5 (forward).
document.addEventListener('mouseup', (event) => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  stepHistory(event.button === 3 ? -1 : 1);
});
document.addEventListener('keydown', (event) => {
  if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  stepHistory(event.key === 'ArrowLeft' ? -1 : 1);
});
api.onNavigate((direction) => stepHistory(direction === 'back' ? -1 : 1));
