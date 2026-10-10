import { projectRow } from './browse.js';
import { $, api, el, emptyRow, errorText, state } from './core.js';
import { refreshInstances } from './instance.js';

const NEW_STEPS = {
  home: { title: 'Create instance' },
  custom: { title: 'Custom setup', placeholder: () => 'My instance' },
  modpack: { title: 'Start from a modpack', placeholder: () => packSearch.chosen?.title || 'Name of the modpack' },
  upload: { title: 'Upload a modpack', placeholder: () => newDialog.upload?.title || 'Name of the modpack' },
};
const newDialog = { step: 'home', upload: null, creating: false };
const packSearch = { query: '', offset: 0, total: 0, done: false, request: 0, timer: null, chosen: null };

async function fillVersions() {
  const select = $('#new-version');
  const showSnapshots = $('#new-snapshots').checked;
  state.versions ??= await api.listVersions();
  const versions = state.versions.filter((v) => v.type === 'release' || (showSnapshots && v.type === 'snapshot'));
  select.replaceChildren(...versions.map((v) => el('option', { value: v.id, textContent: v.id })));
}

function openNewDialog() {
  $('#new-name').value = '';
  newDialog.upload = null;
  newDialog.creating = false;
  $('#upload-info').textContent = 'No file chosen yet.';
  $('#upload-info').classList.remove('chosen');
  $('#upload-pick').textContent = 'Choose modpack file';
  $('#upload-startup').hidden = true;
  $('#upload-trust').checked = false;
  choosePack(null, null);
  showNewStep('home');
  $('#new-dialog').showModal();
}

function showNewStep(step) {
  newDialog.step = step;
  const home = step === 'home';
  $('#new-title').textContent = NEW_STEPS[step].title;
  $('#new-home').hidden = !home;
  $('#new-setup').hidden = home;
  $('#new-custom').hidden = step !== 'custom';
  $('#new-modpack').hidden = step !== 'modpack';
  $('#new-upload').hidden = step !== 'upload';
  $('#new-cancel').textContent = home ? 'Cancel' : 'Back';
  $('#new-create').hidden = home; // the start page's choices are its buttons
  $('#new-error').textContent = '';
  updateNewCreate();
  if (home) {
    document.querySelector('#new-home .choice').focus();
    return;
  }
  $('#new-name').focus(); // type a name straight away
  if (step === 'custom') {
    fillVersions().catch((err) => {
      $('#new-error').textContent = `Couldn't load the version list. Check your internet connection. (${errorText(err)})`;
    });
  }
  if (step === 'modpack' && !packSearch.done) runPackSearch(false); // show popular packs straight away
}

// Create needs whatever the page asks for; an empty name means the pack's own name.
function updateNewCreate() {
  const { step } = newDialog;
  const ready = step === 'custom'
    || (step === 'modpack' && Boolean(packSearch.chosen) && !$('#pack-version').disabled)
    || (step === 'upload' && Boolean(newDialog.upload) && (!newDialog.upload.startup || newDialog.upload.startup.trusted || $('#upload-trust').checked));
  $('#new-create').disabled = newDialog.creating || !ready;
  if (step !== 'home') $('#new-name').placeholder = NEW_STEPS[step].placeholder();
}

// Picking a pack lists the Minecraft versions it can be played on, newest first.
async function choosePack(hit, row) {
  packSearch.chosen = hit;
  for (const li of $('#pack-results').children) li.setAttribute('aria-selected', String(li === row));
  const select = $('#pack-version');
  select.disabled = true;
  select.replaceChildren(el('option', { textContent: hit ? 'Loading versions…' : 'Pick a modpack first' }));
  updateNewCreate();
  if (!hit) return;
  let versions;
  try {
    versions = await api.modpackGameVersions(hit.projectId);
  } catch (err) {
    if (packSearch.chosen !== hit) return;
    select.replaceChildren(el('option', { textContent: 'No versions found' }));
    $('#new-error').textContent = errorText(err);
    return;
  }
  if (packSearch.chosen !== hit) return; // another pack was picked meanwhile
  $('#new-error').textContent = '';
  select.replaceChildren(...versions.map((v) => el('option', {
    value: v.versionId,
    textContent: `${v.gameVersion}  ·  ${hit.title} ${v.versionNumber}${v.type === 'release' ? '' : ` (${v.type})`}`,
  })));
  // Start on the newest full release; alphas and betas stay one click away.
  select.selectedIndex = Math.max(0, versions.findIndex((v) => v.type === 'release'));
  select.disabled = false;
  updateNewCreate();
}

async function runPackSearch(append) {
  const results = $('#pack-results');
  const s = packSearch;
  if (!append) {
    s.query = $('#pack-query').value.trim();
    s.offset = 0;
  }
  const request = ++s.request;
  if (!append && !s.done) results.replaceChildren(emptyRow(s.query ? `Searching for "${s.query}"…` : 'Loading popular modpacks…'));
  let page;
  try {
    page = await api.searchModpacks(s.query, s.offset);
  } catch (err) {
    if (request === s.request) results.replaceChildren(emptyRow(`Modrinth couldn't be reached. Check your internet connection. (${errorText(err)})`));
    return;
  }
  if (request !== s.request) return;
  const rows = page.hits.map(packRow);
  if (append) results.append(...rows);
  else {
    results.replaceChildren(...(rows.length
      ? rows
      : [emptyRow(s.query ? `Nothing found for "${s.query}". Try a different word.` : 'Nothing found.')]));
    $('#pack-scroll').scrollTop = 0;
  }
  s.offset += page.hits.length;
  s.total = page.total;
  s.done = true;
  $('#pack-more').hidden = s.offset >= s.total;
}

// A modpack row: click (or Enter/Space) picks it; the title still opens its Modrinth page.
function packRow(hit) {
  const row = projectRow(hit, 'modpack', null);
  row.tabIndex = 0;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(packSearch.chosen?.projectId === hit.projectId));
  row.onclick = (event) => {
    if (!event.target.closest('a')) choosePack(hit, row);
  };
  row.onkeydown = (event) => {
    if (event.target !== row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    choosePack(hit, row);
  };
  return row;
}

// Shows what a modpack file would install; get picks it (or takes a dropped one) and returns that. A pack that runs
// its own code before the game says so, and installs once the player ticks that they trust it (or trusted its
// server before).
async function chooseModpackFile(get) {
  $('#new-error').textContent = '';
  try {
    const info = await get();
    if (!info) return; // cancelled
    newDialog.upload = info;
    const version = info.versionNumber ? ` ${info.versionNumber}` : '';
    // A pack with startup code may fetch its mods when it starts: not having any in the file says nothing then.
    const mods = info.mods === 1 ? ', 1 mod' : info.mods || !info.startup ? `, ${info.mods || 'no'} mods` : '';
    $('#upload-info').textContent = [
      `${info.title}${version}`,
      info.description,
      `Minecraft ${info.gameVersion}${info.loader ? ` with ${info.loader}` : ''}${mods}`,
    ].filter(Boolean).join('\n');
    $('#upload-info').classList.add('chosen');
    $('#upload-pick').textContent = 'Choose another file';
    const { startup } = info;
    $('#upload-startup').hidden = !startup;
    $('#upload-trust').checked = false;
    if (startup) {
      const names = startup.names.join(', ');
      const from = startup.source ? ` It downloads from ${startup.source}.` : '';
      $('#upload-startup-text').textContent = startup.trusted
        ? `This pack runs its own code (${names}) each time the game starts.${from} You trusted packs from there before.`
        : `This pack runs its own code (${names}) each time the game starts, before Minecraft. That code can download files and change this instance.${from} Only install it if you trust whoever made it.`;
      $('#upload-trust-row').hidden = startup.trusted;
    }
  } catch (err) {
    $('#new-error').textContent = errorText(err);
  } finally {
    updateNewCreate();
  }
}

// A modpack file dropped on the launcher opens Create instance on the upload page with it.
export function dropModpack(file) {
  if (!$('#new-dialog').open) openNewDialog();
  if (newDialog.creating) return;
  showNewStep('upload');
  chooseModpackFile(() => api.dropModpackFile(file));
}
const MODPACK_FILE = /\.(mrpack|zip)$/i;
// The one modpack file in a drop, if that's what it is.
export const droppedModpack = (event) => {
  const files = [...event.dataTransfer.files];
  return files.length === 1 && MODPACK_FILE.test(files[0].name) ? files[0] : null;
};

// Makes the instance at once and switches to it; a modpack's files then download in the background.
async function createInstance(event) {
  event.preventDefault();
  const { step } = newDialog;
  if (step === 'modpack' && document.activeElement === $('#pack-query')) { // Enter in the search box searches
    clearTimeout(packSearch.timer);
    runPackSearch(false);
    return;
  }
  if ($('#new-create').disabled || $('#new-create').hidden) return;
  const name = $('#new-name').value;
  newDialog.creating = true;
  updateNewCreate();
  $('#new-error').textContent = '';
  try {
    let created;
    if (step === 'custom') {
      created = await api.createInstance({ name, gameVersion: $('#new-version').value, loader: $('#new-loader').value });
    } else {
      created = step === 'modpack'
        ? await api.installModpack(packSearch.chosen.projectId, name, $('#pack-version').value)
        : await api.installModpackFile(name, $('#upload-trust').checked);
      state.tab = 'mods'; // watch the mods arrive
    }
    $('#new-dialog').close();
    await refreshInstances(created.id);
  } catch (err) {
    $('#new-error').textContent = errorText(err);
  } finally {
    newDialog.creating = false;
    updateNewCreate();
  }
}

// Every Minecraft item (core/icons.js); picking one sets the icon of an instance or server.

$('#new-instance').onclick = openNewDialog;
$('#empty-new-instance').onclick = openNewDialog;
$('#new-snapshots').onchange = fillVersions;
$('#new-cancel').onclick = () => (newDialog.step === 'home' ? $('#new-dialog').close() : showNewStep('home'));
$('#new-form').onsubmit = createInstance;
for (const choice of document.querySelectorAll('#new-home .choice')) choice.onclick = () => showNewStep(choice.dataset.step);
$('#upload-pick').onclick = () => chooseModpackFile(api.pickModpackFile);
$('#upload-trust').onchange = updateNewCreate;
// A modpack file dropped on Create instance goes to its upload page.
$('#new-dialog').addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
$('#new-dialog').addEventListener('drop', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  const pack = droppedModpack(event);
  if (pack) dropModpack(pack);
  else $('#new-error').textContent = 'Drop one modpack file: a Modrinth .mrpack or a Prism Launcher export (.zip).';
});
// Search as you type, once typing pauses.
$('#pack-query').oninput = () => {
  clearTimeout(packSearch.timer);
  packSearch.timer = setTimeout(() => runPackSearch(false), 350);
};
$('#pack-more').onclick = () => runPackSearch(true);
