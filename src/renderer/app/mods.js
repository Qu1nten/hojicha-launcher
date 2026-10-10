import {
  $,
  api,
  askConfirm,
  current,
  dateFormat,
  el,
  emptyRow,
  errorText,
  icon,
  isBusy,
  listNames,
  loaderLabel,
  plural,
  state,
  SYNC_ITEMS,
  thumb,
} from './core.js';
import { renderStatus, showTab } from './instance.js';

// The installed mods changed: Browse reloads (keeping the search text) the next time it is shown,
// so its "Installed" labels are never stale.
function invalidateSearch() {
  state.search.done = false;
}

// The instance's mods changed (installed, removed, another version): Browse's "Installed" labels and the update
// check are out of date.
export function modsChanged(id) {
  invalidateSearch();
  delete state.modUpdates[id];
}

// Files in the mods, resource packs or shaders folder changed, by the launcher or by hand.
api.onContentChanged((id) => {
  modsChanged(id);
  if (state.view === 'instance' && current()?.id === id && state.tab === 'mods') loadMods();
});

// Mod files dropped on an open instance go into its mods folder, and the Installed tab shows them.
const MOD_FILE = /\.jar$/i;
export const droppedMods = (event) => {
  const files = [...event.dataTransfer.files];
  return state.view === 'instance' && current() && files.length && files.every((file) => MOD_FILE.test(file.name)) ? files : null;
};

export async function addDroppedMods(files) {
  const inst = current();
  if (state.tab !== 'mods') showTab('mods');
  if (state.mods.view !== 'all') state.mods.view = 'mod'; // not hidden behind Resource packs or Shaders
  let text;
  try {
    const { added, skipped } = await api.addModFiles(inst.id, files);
    text = [
      added.length ? `Added ${added.length === 1 ? added[0] : plural(added.length, 'mod', 'mods')}.` : '',
      skipped.length ? `${listNames(skipped)} ${skipped.length === 1 ? 'is' : 'are'} already in this instance.` : '',
    ].filter(Boolean).join(' ');
    state.status[inst.id] = { state: 'idle', text };
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
  }
  modsChanged(inst.id);
  if (current()?.id !== inst.id) return;
  renderStatus();
  loadMods();
}

// Mod versions repeat what the instance already says ("mc1.21.11-0.21.4-fabric", "0.141.6+1.21.11"): keep the
// mod's own part ("0.21.4", "0.141.6"). The full version stays in the tooltip and the version picker.
const LOADER_WORDS = /^(fabric|quilt|forge|neoforge)$/i;
function shortVersion(version, inst) {
  const game = inst.gameVersion.toLowerCase();
  const parts = version.split(/([-+])/); // parts and the - or + before each, so what's kept keeps its own separators
  let short = '';
  for (let i = 0; i < parts.length; i += 2) {
    const p = parts[i].toLowerCase();
    if (!p || LOADER_WORDS.test(p) || p === game || p === `mc${game}`) continue;
    short += (short ? parts[i - 1] : '') + parts[i];
  }
  return short || version;
}

// The Installed tab: mods, resource packs and shaders. All shows them one kind after the other, in this order.
const KINDS = [
  { type: 'mod', folder: 'mods', one: 'mod', many: 'mods', heading: 'Mods' },
  { type: 'resourcepack', folder: 'resourcepacks', one: 'resource pack', many: 'resource packs', heading: 'Resource packs' },
  { type: 'shader', folder: 'shaderpacks', one: 'shader', many: 'shaders', heading: 'Shaders' },
];

export async function loadMods() {
  const inst = current();
  if (state.mods.id !== inst.id) {
    state.mods = { ...state.mods, id: inst.id, content: { mod: [], resourcepack: [], shader: [] }, filter: '', busy: isBusy(inst.id) };
    $('#mod-filter').value = '';
  }
  api.watchContent(inst.id); // files added or removed by hand show up too
  const content = await api.listContent(inst.id);
  if (current()?.id !== inst.id) return; // another instance was picked meanwhile
  state.mods.content = content;
  checkModUpdates(inst);
  renderMods();
}

// Looks for newer versions at most every ten minutes per instance, or after its mods change.
function checkModUpdates(inst) {
  const known = state.modUpdates[inst.id];
  if (known?.pending || (known && Date.now() - known.at < 10 * 60 * 1000)) return;
  if (!state.mods.content.mod.some((m) => m.fromModrinth)) return;
  state.modUpdates[inst.id] = { pending: true };
  api.checkModUpdates(inst.id)
    .then((updates) => { state.modUpdates[inst.id] = { at: Date.now(), updates }; })
    .catch(() => { state.modUpdates[inst.id] = { at: Date.now(), updates: {} }; }) // offline: just no update marks
    .then(() => { if (state.tab === 'mods' && current()?.id === inst.id) renderMods(); });
}

// Opens Browse on the given kind, for the "nothing here yet" rows.
function browseFor(type) {
  const button = el('button', { className: 'primary', textContent: 'Browse Modrinth' });
  button.onclick = () => {
    if ($('#search-type').value !== type) {
      $('#search-type').value = type;
      invalidateSearch();
    }
    showTab('browse');
  };
  return button;
}

export function renderMods() {
  const inst = current();
  const list = $('#mod-list');
  const view = state.mods.view;
  const content = state.mods.content;
  state.mods.busy = isBusy(inst.id);

  const total = KINDS.reduce((n, kind) => n + content[kind.type].length, 0);
  $('#mods-bar').hidden = $('#content-kinds').hidden = !total;
  for (const button of document.querySelectorAll('#content-kinds button')) {
    const on = button.dataset.kind === view;
    button.classList.toggle('active', on);
    button.setAttribute('aria-pressed', String(on));
  }
  if (!total) {
    list.replaceChildren(emptyRow('Nothing installed yet.', browseFor('mod')));
    return;
  }

  const updates = state.modUpdates[inst.id]?.updates || {};
  const query = state.mods.filter.trim().toLowerCase();
  const matches = (item) => !query || `${item.title} ${item.file}`.toLowerCase().includes(query);
  const kinds = view === 'all' ? KINDS : KINDS.filter((kind) => kind.type === view);
  const shown = Object.fromEntries(kinds.map((kind) => [kind.type, content[kind.type].filter(matches)]));
  const shownCount = kinds.reduce((n, kind) => n + shown[kind.type].length, 0);

  // "12 mods, 3 resource packs", "12 mods, 1 switched off", or "3 of 16" while filtering.
  const off = content.mod.filter((m) => !m.enabled).length;
  const counts = kinds.filter((kind) => content[kind.type].length)
    .map((kind) => plural(content[kind.type].length, kind.one, kind.many));
  if (view === 'mod' && off) counts.push(`${off} switched off`);
  const all = kinds.reduce((n, kind) => n + content[kind.type].length, 0);
  $('#mod-count').textContent = query ? `${shownCount} of ${all}` : counts.join(', ');

  const updatable = view === 'all' || view === 'mod' ? content.mod.filter((m) => updates[m.file]) : [];
  const updateAll = $('#mods-update-all');
  updateAll.hidden = updatable.length < 2;
  updateAll.textContent = `Update all ${updatable.length}`;
  updateAll.disabled = state.mods.busy;

  const rows = [];
  for (const kind of kinds) {
    const items = shown[kind.type];
    if (view === 'all') {
      if (!items.length) continue;
      // A thin line, with the kind's name, between one kind and the next.
      if (rows.length) rows.push(el('li', { className: 'kind-divider', role: 'presentation' }, [el('span', { textContent: kind.heading })]));
    } else if (!items.length) {
      if (query) break;
      if (kind.type === 'mod' && inst.loader === 'vanilla') rows.push(emptyRow("This instance has no mod loader, so it can't use mods. Create a Fabric instance to add mods."));
      else rows.push(emptyRow(`No ${kind.many} yet.`, browseFor(kind.type)));
      continue;
    }
    for (const item of items) rows.push(kind.type === 'mod' ? modRow(inst, item, updates[item.file]) : installedPackRow(inst, kind, item));
  }
  if (!rows.length) rows.push(emptyRow(`Nothing matches "${state.mods.filter.trim()}".`));
  list.replaceChildren(...rows);
}

// Removes a mod or pack. A shared pack is also in other instances: say which before it goes from all of them.
async function removeItem(inst, kind, item) {
  if (item.shared) {
    const others = state.instances.filter((other) => other.id !== inst.id && other.sync?.[kind.folder] !== false).map((other) => other.name);
    if (others.length) {
      const remove = await askConfirm({
        title: `Remove ${item.title} from every instance?`,
        text: `This ${kind.one} is shared with ${listNames(others)}, so removing it here removes it there too.`,
        // Named as the switch in the Sync tab is: "Resource packs", "Shader packs".
        note: `To keep it in the others, first switch off ${SYNC_ITEMS.find(([item]) => item === kind.folder)[1]} in this instance's Sync tab.`,
        confirm: 'Remove everywhere',
        cancel: 'Keep it',
      });
      if (!remove) return;
    }
  }
  try {
    await api.removeContent(inst.id, kind.type, item.file);
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
    renderStatus();
  }
  modsChanged(inst.id);
  loadMods();
}

function removeButton(inst, kind, item) {
  const remove = el('button', { className: 'quiet danger mod-remove', textContent: 'Remove', ariaLabel: `Remove ${item.title}` });
  remove.onclick = () => removeItem(inst, kind, item);
  return remove;
}

function modRow(inst, mod, update) {
  const busy = state.mods.busy;

  let version;
  if (mod.fromModrinth) {
    version = el('button', {
      className: 'version-button',
      textContent: mod.versionNumber ? shortVersion(mod.versionNumber, inst) : 'Unknown',
      title: `Version ${mod.versionNumber || 'unknown'}. Click to change it.`,
      ariaLabel: `Change version of ${mod.title}, now ${mod.versionNumber}`,
    });
    version.onclick = () => openVersionPicker(inst, mod);
  } else {
    // The version the mod file names, if it does.
    version = el('span', {
      className: 'version',
      textContent: mod.versionNumber ? shortVersion(mod.versionNumber, inst) : 'Added by hand',
      title: mod.versionNumber ? `Version ${mod.versionNumber}, added by hand` : '',
    });
  }

  let updateButton = null;
  if (update) {
    updateButton = el('button', {
      className: 'mod-update',
      textContent: `Update to ${shortVersion(update.versionNumber, inst)}`,
      title: `Update to ${update.versionNumber}`,
      disabled: busy,
    });
    updateButton.onclick = () => updateMods(inst, [mod]);
  }

  const toggle = el('input', {
    type: 'checkbox',
    className: 'switch',
    checked: mod.enabled,
    disabled: busy,
    title: mod.enabled ? 'On: the game loads this mod' : 'Off: the game skips this mod',
    ariaLabel: `Load ${mod.title}`,
  });
  toggle.onchange = async () => {
    toggle.disabled = true;
    try {
      mod.file = await api.setModEnabled(inst.id, mod.file, toggle.checked);
      mod.enabled = toggle.checked;
    } catch (err) {
      state.status[inst.id] = { state: 'error', text: errorText(err) };
      renderStatus();
    }
    renderMods();
  };

  return el('li', { className: `mod-row${mod.enabled ? '' : ' off'}`, title: mod.file }, [
    thumb(mod.iconUrl),
    el('div', { className: 'info' }, [el('div', { className: 'title', textContent: mod.title })]),
    updateButton,
    version,
    toggle,
    removeButton(inst, KINDS[0], mod),
  ]);
}

// A resource pack or shader. Which ones are on is chosen in the game, so there's no switch; an empty space of the
// same size keeps the versions lined up with the mods'.
function installedPackRow(inst, kind, pack) {
  const title = el('div', { className: 'title' }, [pack.title]);
  if (pack.shared) {
    const others = state.instances.filter((other) => other.id !== inst.id && other.sync?.[kind.folder] !== false).map((other) => other.name);
    title.append(el('span', {
      className: 'shared-mark',
      title: others.length ? `Shared with ${listNames(others)}` : `Shared: every instance that syncs ${kind.many} has it`,
      ariaLabel: 'Shared with other instances',
    }, [icon('linked')]));
  }
  return el('li', { className: 'mod-row', title: pack.file }, [
    thumb(pack.iconUrl),
    el('div', { className: 'info' }, [title]),
    el('span', { className: 'version', textContent: pack.fromModrinth ? shortVersion(pack.versionNumber, inst) : 'Added by hand', title: pack.versionNumber }),
    el('span', { className: 'switch-space', ariaHidden: 'true' }),
    removeButton(inst, kind, pack),
  ]);
}

// Updates the given mods one by one to the versions the update check found.
async function updateMods(inst, mods) {
  const updates = state.modUpdates[inst.id]?.updates || {};
  const buttons = [...document.querySelectorAll('#mod-list .mod-update, #mods-update-all')];
  for (const button of buttons) button.disabled = true;
  let done = 0;
  try {
    for (const mod of mods) {
      if (mods.length > 1) $('#mods-update-all').textContent = `Updating ${done + 1} of ${mods.length}`;
      await api.setModVersion(inst.id, mod.file, updates[mod.file].versionId);
      done++;
    }
    state.status[inst.id] = {
      state: 'idle',
      text: mods.length === 1 ? `${mods[0].title} is now on version ${updates[mods[0].file].versionNumber}.` : `Updated ${mods.length} mods.`,
    };
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: done ? `Updated ${done} of ${mods.length} mods, then: ${errorText(err)}` : errorText(err) };
  }
  modsChanged(inst.id);
  renderStatus();
  await loadMods();
}

const CHANNELS = { release: 'Release', beta: 'Beta', alpha: 'Alpha' };

async function openVersionPicker(inst, mod) {
  const list = $('#versions-list');
  const errorEl = $('#versions-error');
  errorEl.textContent = '';
  $('#versions-title').textContent = `Versions of ${mod.title}`;
  $('#versions-hint').textContent = `Every version that works with ${loaderLabel(inst)}, newest first.`;
  list.replaceChildren(emptyRow('Loading versions…'));
  $('#versions-dialog').showModal();

  let versions;
  try {
    versions = await api.listModVersions(inst.id, mod.file);
  } catch (err) {
    list.replaceChildren();
    errorEl.textContent = errorText(err);
    return;
  }
  if (!versions.length) {
    list.replaceChildren(emptyRow(`Modrinth has no versions of ${mod.title} for ${loaderLabel(inst)}.`));
    return;
  }

  list.replaceChildren(...versions.map((v) => {
    let action;
    if (v.current) {
      action = el('span', { className: 'installed', textContent: 'Installed' });
    } else {
      action = el('button', { textContent: 'Use this version', type: 'button' });
      action.onclick = async () => {
        for (const button of list.querySelectorAll('button')) button.disabled = true;
        action.textContent = 'Switching';
        errorEl.textContent = '';
        try {
          const result = await api.setModVersion(inst.id, mod.file, v.id);
          modsChanged(inst.id); // a new version can pull in extra dependencies
          $('#versions-dialog').close();
          await loadMods();
          state.status[inst.id] = { state: 'idle', text: `${result.title} is now on version ${result.versionNumber}.` };
          renderStatus();
        } catch (err) {
          errorEl.textContent = errorText(err);
          for (const button of list.querySelectorAll('button')) button.disabled = false;
          action.textContent = 'Use this version';
        }
      };
    }
    return el('li', {}, [
      el('div', { className: 'info' }, [
        el('div', { className: 'title', textContent: v.versionNumber }),
        el('div', { className: 'channel', textContent: `${CHANNELS[v.type] || v.type}, ${dateFormat.format(new Date(v.published))}` }),
      ]),
      action,
    ]);
  }));
}

$('#mod-filter').oninput = () => {
  state.mods.filter = $('#mod-filter').value;
  renderMods();
};

$('#mods-update-all').onclick = () => {
  const inst = current();
  const updates = state.modUpdates[inst.id]?.updates || {};
  updateMods(inst, state.mods.content.mod.filter((m) => updates[m.file]));
};

for (const button of document.querySelectorAll('#content-kinds button')) {
  button.onclick = () => {
    state.mods.view = button.dataset.kind;
    renderMods();
  };
};

$('#versions-close').onclick = () => $('#versions-dialog').close();
