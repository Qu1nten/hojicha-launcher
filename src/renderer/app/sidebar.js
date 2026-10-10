import { $, api, el, icon, loaderLabel, state } from './core.js';
import { openIconPicker } from './iconPicker.js';
import { refreshInstances, selectInstance } from './instance.js';
import { refreshServers, selectServer, serverFlavor } from './servers.js';
import { renderUpdate } from './settings.js';

// The item icon in front of an instance or server. Hovering shows a + and clicking opens the icon picker,
// without selecting the row.
function itemIcon(kind, thing) {
  const button = el('button', {
    type: 'button',
    className: 'item-icon',
    title: 'Change icon',
    ariaLabel: `Change the icon of ${thing.name}`,
  }, [thing.iconUrl ? el('img', { src: thing.iconUrl, alt: '', draggable: false }) : icon('block')]);
  button.onclick = () => {
    // A mouse click (detail > 0) lets go of focus first, so closing the picker doesn't hand focus back and ring
    // the icon. From the keyboard, focus comes back as usual.
    if (event.detail > 0) button.blur();
    openIconPicker(kind, thing);
  };
  return button;
}

// A sidebar row: the item icon (its own button, for the icon picker) and the name, a button that covers the whole
// row, so a click anywhere opens it and the keyboard reaches it with Tab, Enter and Space.
function sideRow(kind, thing, active, sub, running, open) {
  const select = el('button', { type: 'button', className: 'side-select' }, [
    el('span', { className: 'name', textContent: thing.name }),
    el('span', { className: 'sub' }, [sub, running ? el('span', { className: 'running-dot', title: running }) : null]),
  ]);
  if (active) select.setAttribute('aria-current', 'page');
  select.onclick = open;
  const row = el('li', { className: active ? 'active' : '' }, [itemIcon(kind, thing), select]);
  row.dataset.key = `${kind}:${thing.id}`;
  return row;
}

// Dragging an instance or server up or down its sidebar list puts it there. While one is dragged that list stays as
// it is (a status update would otherwise rebuild the rows under the pointer and end the drag); it's redrawn after.
const sidebarDrag = { kind: null, id: null };
const sidebarLists = {
  instance: {
    list: '#instance-list',
    items: () => state.instances,
    set: (items) => { state.instances = items; },
    save: (ids) => api.reorderInstances(ids),
    refresh: () => refreshInstances(),
  },
  server: {
    list: '#server-list',
    items: () => state.servers,
    set: (items) => { state.servers = items; },
    save: (ids) => api.reorderServers(ids),
    refresh: () => refreshServers(),
  },
};

function draggableRow(row, kind, thing) {
  row.draggable = true;
  row.addEventListener('dragstart', (event) => {
    Object.assign(sidebarDrag, { kind, id: thing.id });
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(`application/x-hojicha-${kind}`, thing.id);
    row.classList.add('dragging');
  });
  row.addEventListener('dragend', () => {
    Object.assign(sidebarDrag, { kind: null, id: null });
    row.classList.remove('dragging');
    showDrop(kind, undefined); // rows are kept when redrawn, so their drag marks are cleared here
    renderSidebar();
  });
}

// Where a drop at this height lands: the id of the row it goes in front of, or null for the bottom.
function dropBefore(kind, y) {
  const rows = [...$(sidebarLists[kind].list).children];
  const below = rows.find((row) => {
    const box = row.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return below ? below.dataset.key.slice(`${kind}:`.length) : null;
}

// Draws the line where the drop lands (before: as from dropBefore(); undefined for no line).
function showDrop(kind, before) {
  const rows = [...$(sidebarLists[kind].list).children];
  for (const row of rows) row.classList.remove('drop-before', 'drop-after');
  if (before === null) rows.at(-1)?.classList.add('drop-after');
  else rows.find((row) => row.dataset.key === `${kind}:${before}`)?.classList.add('drop-before');
}

for (const [kind, { list: selector, items, set, save, refresh }] of Object.entries(sidebarLists)) {
  const list = $(selector);
  // Only rows from this list: an instance can't be dropped among the servers.
  const ours = () => sidebarDrag.kind === kind;
  list.addEventListener('dragover', (event) => {
    if (!ours()) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    showDrop(kind, dropBefore(kind, event.clientY));
  });
  list.addEventListener('dragleave', (event) => {
    if (ours() && !list.contains(event.relatedTarget)) showDrop(kind, undefined);
  });
  list.addEventListener('drop', (event) => {
    if (!ours()) return;
    event.preventDefault();
    const moving = items().find((thing) => thing.id === sidebarDrag.id);
    const before = dropBefore(kind, event.clientY);
    Object.assign(sidebarDrag, { kind: null, id: null });
    if (!moving || before === moving.id) return renderSidebar();
    const rest = items().filter((thing) => thing !== moving);
    const at = before === null ? rest.length : rest.findIndex((thing) => thing.id === before);
    rest.splice(at, 0, moving);
    set(rest);
    renderSidebar();
    save(rest.map((thing) => thing.id)).catch((err) => {
      console.error(`Could not save the ${kind} order:`, err);
      refresh();
    });
  });
}

// Puts the rows in a sidebar list, keeping each row whose look hasn't changed: status updates come many times a
// second while a game launches, and rebuilding every row (and its icon) for each one made the sidebar flicker.
function updateSideList(list, kind, things, describe, open) {
  const old = new Map([...list.children].map((row) => [row.dataset.key, row]));
  const rows = things.map((thing) => {
    const { active, sub, running } = describe(thing);
    const look = JSON.stringify([thing.name, thing.iconUrl, active, sub, running]);
    const kept = old.get(`${kind}:${thing.id}`);
    if (kept?.look === look) return kept;
    const row = sideRow(kind, thing, active, sub, running, () => open(thing.id));
    row.look = look;
    draggableRow(row, kind, thing);
    return row;
  });
  if (rows.length === list.children.length && rows.every((row, i) => row === list.children[i])) return;
  // Some rows are new: keep keyboard focus on the same row and button (opening a row redraws it).
  const focusKey = document.activeElement?.closest?.('li[data-key]')?.dataset.key;
  const focusClass = document.activeElement?.classList.contains('item-icon') ? 'item-icon' : 'side-select';
  const hadFocus = list.contains(document.activeElement);
  list.replaceChildren(...rows);
  if (hadFocus) rows.find((row) => row.dataset.key === focusKey)?.querySelector(`.${focusClass}`)?.focus();
}

export function renderSidebar() {
  if (sidebarDrag.kind !== 'instance') {
    updateSideList($('#instance-list'), 'instance', state.instances, (inst) => ({
      active: state.view === 'instance' && inst.id === state.selected,
      sub: loaderLabel(inst),
      running: state.status[inst.id]?.state === 'running' ? 'Playing' : '',
    }), selectInstance);
  }
  if (sidebarDrag.kind !== 'server') {
    updateSideList($('#server-list'), 'server', state.servers, (server) => ({
      active: state.view === 'server' && server.id === state.selectedServer,
      sub: `${serverFlavor(server)} ${server.mcVersion}`,
      running: ['starting', 'running', 'stopping'].includes(state.serverStatus[server.id]?.state) ? 'Running' : '',
    }), selectServer);
  }
  $('#open-settings').classList.toggle('active', state.view === 'settings');
  $('#schematics-row').classList.toggle('active', state.view === 'schematics');
  if (state.view === 'schematics') $('#open-schematics').setAttribute('aria-current', 'page');
  else $('#open-schematics').removeAttribute('aria-current');
  renderActivity();
}

// The pill in the title bar: what's running, or being prepared, across all instances and servers.
function renderActivity() {
  const active = [
    ...state.instances.flatMap((inst) => {
      const s = state.status[inst.id]?.state;
      if (s === 'running') return [{ name: inst.name, label: 'Playing', go: () => selectInstance(inst.id) }];
      if (s === 'installing') return [{ name: inst.name, label: 'Preparing', preparing: true, go: () => selectInstance(inst.id) }];
      return [];
    }),
    ...state.servers.flatMap((server) => {
      const s = state.serverStatus[server.id]?.state;
      if (!['starting', 'running', 'stopping'].includes(s)) return [];
      const label = { starting: 'Starting', running: 'Running', stopping: 'Stopping' }[s];
      return [{ name: server.name, label, preparing: s !== 'running', go: () => selectServer(server.id) }];
    }),
  ];
  const pill = $('#activity');
  pill.classList.toggle('running', active.length > 0 && !active.every((a) => a.preparing));
  pill.classList.toggle('preparing', active.length > 0 && active.every((a) => a.preparing));
  pill.disabled = active.length === 0;
  if (active.length === 0) $('#activity-text').textContent = 'Nothing running';
  else if (active.length === 1) $('#activity-text').textContent = `${active[0].name} · ${active[0].label}`;
  else $('#activity-text').textContent = `${active.length} running`;
  renderUpdate();
  pill.title = active.map((a) => `${a.name}: ${a.label}`).join('\n');
  pill.onclick = () => active[0]?.go();
}
