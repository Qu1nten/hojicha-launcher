import { resetSearch, runSearch } from './browse.js';
import {
  $,
  api,
  askConfirm,
  current,
  el,
  errorText,
  formatLastPlayed,
  formatPlaytime,
  icon,
  isBusy,
  loaderLabel,
  reduceMotion,
  state,
  SYNC_ITEMS,
} from './core.js';
import { openIconPicker } from './iconPicker.js';
import { closeInstanceMenu } from './menus.js';
import { loadMods, renderMods } from './mods.js';
import { remember, renderMain } from './nav.js';
import { confirmDiscard } from './serverFiles.js';
import { currentServer, renderServer } from './servers.js';
import { renderSidebar } from './sidebar.js';

export async function refreshInstances(selectId) {
  const before = state.selected;
  state.instances = await api.listInstances();
  for (const inst of state.instances) {
    if (inst.running && !state.status[inst.id]) state.status[inst.id] = { state: 'running', text: 'Playing' };
  }
  if (selectId) {
    state.selected = selectId;
    state.view = 'instance';
  }
  if (!current()) state.selected = state.instances[0]?.id ?? null;
  if (state.selected !== before) resetSearch(); // e.g. a new instance, or the selected one was deleted
  renderSidebar();
  renderMain();
}

export function selectInstance(id) {
  if (state.view === 'server' && !confirmDiscard(() => selectInstance(id))) return;
  if (state.view === 'instance' && id === state.selected) return;
  const changed = id !== state.selected;
  state.selected = id;
  state.view = 'instance';
  if (changed) resetSearch();
  renderSidebar();
  renderMain();
}

export function renderInstance() {
  const inst = current();
  if (!inst) return;

  $('#inst-name').textContent = inst.name;
  renderMeta();
  renderStatus();
  showTab(state.tab);
}

function renderMeta() {
  const inst = current();
  if (!inst) return;
  const playing = state.status[inst.id]?.state === 'running';
  const item = (glyph, text, title) => el('span', { className: 'meta-item', title: title || '' }, [glyph, text]);
  const version = inst.loader === 'fabric'
    ? item(el('img', { className: 'pixel-icon', src: 'icons/fabric.png', alt: '' }), loaderLabel(inst), `Fabric loader ${inst.loaderVersion}`)
    : item(icon('block'), loaderLabel(inst));
  $('#inst-meta').replaceChildren(...[
    version,
    inst.playtime >= 60000 ? item(icon('hourglass'), formatPlaytime(inst.playtime), 'Time played') : null,
    item(icon('clock'), playing ? 'Playing now' : formatLastPlayed(inst.lastPlayed),
      inst.lastPlayed ? `Last played ${new Date(inst.lastPlayed).toLocaleString()}` : ''),
  ].filter(Boolean));
}

// As the launch progresses, hojicha roasts from leaf green to tea liquor to roasted brown; matcha is whisked from
// fresh to deep green. Both start well apart from the empty cup (--clay), so the first few percent already show.
const ROAST_STOPS = {
  hojicha: [[156, 178, 106], [217, 148, 74], [176, 100, 56]],
  matcha: [[141, 178, 85], [94, 138, 46], [79, 125, 38]],
};
function roastColor(fraction) {
  const stops = ROAST_STOPS[document.documentElement.dataset.theme] || ROAST_STOPS.hojicha;
  const f = Math.min(1, Math.max(0, fraction)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const t = f - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return a.map((v, k) => Math.round(v + (b[k] - v) * t));
}

// WCAG relative luminance of an [r, g, b] or a #rrggbb colour.
function luminance(color) {
  const rgb = Array.isArray(color) ? color : [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// The label over the tea: whichever of the theme's text and background colours reads better on the fill.
const themeText = {};
function textOn(rgb) {
  const theme = document.documentElement.dataset.theme || 'hojicha';
  if (!themeText[theme]) {
    const css = getComputedStyle(document.documentElement);
    themeText[theme] = [css.getPropertyValue('--steam').trim(), css.getPropertyValue('--roast').trim()];
  }
  const fill = luminance(rgb);
  const contrast = (hex) => {
    const l = luminance(hex);
    return (Math.max(l, fill) + 0.05) / (Math.min(l, fill) + 0.05);
  };
  return themeText[theme].reduce((best, hex) => (contrast(hex) > contrast(best) ? hex : best));
}

// Play as a cup: fills once from empty to full while the instance is prepared, and stays full while the game runs.
// The tea follows the launch progress but never faster than a full cup in CUP_MIN_FILL seconds, so a launch where
// everything is already downloaded still pours in one smooth go instead of a flicker. The launch steps show under
// Play only once preparing takes longer than DETAIL_DELAY, so quick launches stay calm.
const CUP_MIN_FILL = 0.9;
const DETAIL_DELAY = 700;
const cup = { id: null, state: 'idle', text: '', shown: 0, target: 0, since: 0, last: 0, frame: 0, detailTimer: null };

function renderPlay(id, s) {
  const busy = s.state === 'installing' || s.state === 'running';
  const progress = s.state === 'running' ? 1 : s.state === 'installing' ? (s.progress ?? 0) : 0;
  if (cup.id !== id) {
    // Another instance: show where its launch is, without pouring.
    cup.id = id;
    cup.target = cup.shown = busy ? progress : 0;
    cup.since = performance.now() - DETAIL_DELAY;
  } else if (s.state === 'installing' && cup.state !== 'installing') {
    cup.target = cup.shown = 0; // a new launch starts with an empty cup
    cup.since = performance.now();
  }
  cup.state = s.state;
  cup.text = s.text;
  cup.target = busy ? Math.max(cup.target, progress) : 0; // progress only ever rises within one launch
  if (!busy || reduceMotion.matches) cup.shown = cup.target;

  clearTimeout(cup.detailTimer);
  const untilDetail = cup.since + DETAIL_DELAY - performance.now();
  if (s.state === 'installing' && untilDetail > 0) cup.detailTimer = setTimeout(drawCup, untilDetail);

  drawCup();
  if (cup.shown < cup.target && !cup.frame) {
    cup.last = performance.now();
    cup.frame = requestAnimationFrame(pourCup);
  }
}

function pourCup(now) {
  const dt = Math.min(0.05, (now - cup.last) / 1000);
  cup.last = now;
  const gap = cup.target - cup.shown;
  // Ease towards the target, at least a little each frame so it always arrives, and never faster than the cap.
  const step = Math.min(gap, dt / CUP_MIN_FILL, Math.max(gap * (1 - Math.exp(-dt / 0.12)), 0.3 * dt));
  cup.shown += step;
  if (cup.target - cup.shown < 0.0005) cup.shown = cup.target;
  drawCup();
  cup.frame = cup.shown < cup.target ? requestAnimationFrame(pourCup) : 0;
}

function drawCup() {
  const play = $('#play');
  // "Playing" waits for the cup to be full, so the pour always finishes.
  const label = cup.state === 'installing' || (cup.state === 'running' && cup.shown < 1) ? 'Preparing'
    : cup.state === 'running' ? 'Playing' : 'Play';
  $('#play-label').textContent = label;
  $('#play-fill-label').textContent = label;
  play.style.setProperty('--play-progress', `${(cup.shown * 100).toFixed(2)}%`);
  if (reduceMotion.matches) {
    play.style.removeProperty('--play-fill');
    play.style.removeProperty('--play-fill-text');
  } else {
    const rgb = roastColor(cup.shown);
    play.style.setProperty('--play-fill', `rgb(${rgb.join(', ')})`);
    play.style.setProperty('--play-fill-text', textOn(rgb));
  }
  const showDetail = cup.state === 'installing' && performance.now() - cup.since >= DETAIL_DELAY;
  $('#play-detail').textContent = showDetail ? cup.text : '';
}

export function renderStatus() {
  const inst = current();
  if (!inst) return;
  const s = state.status[inst.id] || { state: 'idle', text: '' };
  const statusEl = $('#status');
  // Launch steps go under Play, and Play itself says when the game is running.
  statusEl.textContent = s.state === 'installing' || s.state === 'running' ? '' : s.text;
  statusEl.className = `status${s.state === 'error' ? ' error' : ''}`;
  renderPlay(inst.id, s);

  const play = $('#play');
  play.disabled = isBusy(inst.id);
  $('#delete-instance').disabled = isBusy(inst.id);
  if (state.tab === 'sync') renderSync();
  // The mod switches and update buttons lock while the game is prepared or running.
  if (state.tab === 'mods' && state.mods.id === inst.id && state.mods.busy !== isBusy(inst.id)) renderMods();
}

export function showTab(tab) {
  state.tab = tab;
  for (const button of document.querySelectorAll('#instance-view .tabs button')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll('#instance-view .tab')) {
    panel.hidden = panel.id !== `tab-${tab}`;
  }
  if (tab === 'mods') loadMods();
  if (tab === 'browse' && !state.search.done && !state.search.loading) runSearch(false); // show popular projects straight away
  if (tab === 'sync') renderSync();
  if (tab === 'log') renderLog();
  remember();
}

function renderSync() {
  const inst = current();
  $('#sync-options').replaceChildren(...SYNC_ITEMS.map(([item, title, description]) => {
    const box = el('input', { type: 'checkbox', className: 'switch', checked: inst.sync?.[item] !== false, disabled: isBusy(inst.id) });
    box.onchange = async () => {
      $('#sync-error').textContent = '';
      try {
        Object.assign(inst, await api.setSync(inst.id, item, box.checked));
      } catch (err) {
        box.checked = !box.checked;
        $('#sync-error').textContent = errorText(err);
      }
    };
    // The label wraps the whole row so clicking anywhere on it flips the switch.
    return el('li', {}, [
      el('label', { className: 'sync-row' }, [
        el('div', { className: 'info' }, [
          el('div', { className: 'title', textContent: title }),
          el('div', { className: 'desc', textContent: description }),
        ]),
        box,
      ]),
    ]);
  }));
}

export function renderLog() {
  const logEl = $('#log');
  logEl.textContent = (state.logs[state.selected] || []).join('\n');
  logEl.parentElement.scrollTop = logEl.parentElement.scrollHeight;
}

async function updateInstance(patch) {
  const inst = current();
  try {
    Object.assign(inst, await api.updateInstance(inst.id, patch));
    $('#inst-name').textContent = inst.name;
    renderSidebar();
  } catch (err) {
    if (!isBusy(inst.id)) {
      state.status[inst.id] = { state: 'error', text: errorText(err) };
      renderStatus();
    }
  }
}

// Renaming happens on the name itself: it turns into a text box. Enter or clicking away saves, Escape cancels.
function startRename() {
  closeInstanceMenu();
  const input = $('#inst-rename');
  input.value = current().name;
  $('#inst-name').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

async function finishRename(save) {
  const input = $('#inst-rename');
  if (input.hidden) return;
  input.hidden = true;
  $('#inst-name').hidden = false;
  const name = input.value.trim();
  if (save && name && name !== current().name) await updateInstance({ name });
}

api.onStatus(({ id, state: s, text, progress }) => {
  const previous = state.status[id];
  // Starting and closing the game update last played and play time: fetch them.
  if ((s === 'running') !== (previous?.state === 'running')) {
    api.listInstances().then((list) => {
      state.instances = list;
      if (state.view === 'instance' && id === state.selected) renderMeta();
    });
  }
  state.status[id] = { state: s, text, progress: progress ?? previous?.progress ?? null };
  renderSidebar();
  if (id === state.selected) {
    renderStatus();
    // Refresh the mods list after an install finishes (dependencies may have been added).
    if (s === 'idle' && state.tab === 'mods') loadMods();
  }
  if (state.view === 'server' && currentServer()) renderServer(); // join button depends on instance state
});

// Game output arrives in batches. Only the new lines are added to the page: redrawing a long log for every batch
// would slow the launcher down while the game loads.
api.onLog(({ id, lines: added }) => {
  const lines = (state.logs[id] ??= []);
  for (const line of added) lines.push(line);
  if (id === state.selected && state.tab === 'log') {
    const logEl = $('#log');
    const scroller = logEl.parentElement;
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 20;
    logEl.append(`${lines.length > added.length ? '\n' : ''}${added.join('\n')}`);
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }
});

for (const button of document.querySelectorAll('#instance-view .tabs button')) {
  button.onclick = () => showTab(button.dataset.tab);
}

$('#play').onclick = async () => {
  const inst = current();
  state.logs[inst.id] = [];
  if (state.tab === 'log') renderLog(); // new lines are added to what's shown, so clear it now
  state.status[inst.id] = { state: 'installing', text: 'Getting ready', progress: 0 };
  renderStatus();
  try {
    await api.launch(inst.id);
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
    renderStatus();
  }
};

$('#open-folder').onclick = () => api.openFolder(state.selected);

$('#delete-instance').onclick = async () => {
  const inst = current();
  const remove = await askConfirm({
    title: `Delete ${inst.name}?`,
    text: "Its mods, and any worlds or packs it doesn't share with other instances, are deleted. This can't be undone.",
    note: 'Shared worlds, resource packs and shaders stay for the other instances.',
    confirm: 'Delete instance',
    cancel: 'Keep it',
  });
  if (!remove) return;
  try {
    await api.deleteInstance(inst.id);
    state.selected = null;
    await refreshInstances();
  } catch (err) {
    state.status[inst.id] = { state: 'error', text: errorText(err) };
    await refreshInstances(); // a half-finished delete may have removed the instance already
  }
};

// The Mods and Browse lists fade under their bar only once scrolled, so the first row stays crisp at the top.
for (const scroller of document.querySelectorAll('.tab-scroll')) {
  scroller.addEventListener('scroll', () => scroller.classList.toggle('scrolled', scroller.scrollTop > 0), { passive: true });
}

$('#menu-rename').onclick = startRename;
$('#inst-name').ondblclick = startRename;
$('#menu-icon').onclick = () => {
  closeInstanceMenu();
  openIconPicker('instance', current());
};
$('#inst-memory').onchange = () => updateInstance({ memoryMb: $('#inst-memory').value ? Number($('#inst-memory').value) : null });
$('#inst-rename').onkeydown = (event) => {
  if (event.key === 'Enter') finishRename(true);
  if (event.key === 'Escape') finishRename(false);
};
$('#inst-rename').onblur = () => finishRename(true);
