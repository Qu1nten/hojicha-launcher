import { $, api, current, el, emptyRow, errorText, formatDownloads, state, thumb } from './core.js';
import { renderStatus } from './instance.js';
import { modsChanged } from './mods.js';

// Forget the previous instance's results; the Browse tab loads fresh ones the next time it is shown.
export function resetSearch() {
  state.search = { query: '', type: $('#search-type').value, offset: 0, total: 0, done: false };
  $('#search-query').value = '';
  $('#search-results').replaceChildren();
  $('#load-more').hidden = true;
}

const SEARCH_NOUNS = { mod: 'mods', resourcepack: 'resource packs', shader: 'shaders' };
let searchRequest = 0; // only the newest search may update the list
let searchTimer = null;

export async function runSearch(append) {
  const inst = current();
  const results = $('#search-results');
  const s = state.search;
  if (!append) {
    s.query = $('#search-query').value.trim();
    s.type = $('#search-type').value;
    s.offset = 0;
  }
  if (s.type === 'mod' && inst.loader === 'vanilla') {
    results.replaceChildren(emptyRow("This instance has no mod loader, so it can't use mods. Create a Fabric instance to add mods."));
    $('#load-more').hidden = true;
    s.done = true;
    return;
  }

  const request = ++searchRequest;
  // First load for this instance: say what's coming. Later searches keep the old results until new ones arrive.
  if (!append && !s.done) {
    results.replaceChildren(emptyRow(s.query ? `Searching for "${s.query}"…` : `Loading popular ${SEARCH_NOUNS[s.type]}…`));
  }
  let page;
  s.loading = true;
  try {
    page = await api.search(inst.id, s.query, s.type, s.offset);
  } catch (err) {
    if (request === searchRequest) results.replaceChildren(emptyRow(`Modrinth couldn't be reached. Check your internet connection. (${errorText(err)})`));
    return;
  } finally {
    if (request === searchRequest) s.loading = false;
  }
  if (request !== searchRequest || inst.id !== state.selected) return;
  const rows = page.hits.map((hit) => searchRow(inst, hit, s.type));
  if (append) results.append(...rows);
  else {
    results.replaceChildren(...(rows.length
      ? rows
      : [emptyRow(s.query ? `Nothing found for "${s.query}". Try a different word.` : 'Nothing found.')]));
    results.parentElement.scrollTop = 0;
  }
  s.offset += page.hits.length;
  s.total = page.total;
  s.done = true;
  $('#load-more').hidden = s.offset >= s.total;
}

function searchRow(inst, hit, type) {
  let action;
  if (hit.installed) {
    action = el('span', { className: 'installed', textContent: 'Installed' });
  } else {
    action = el('button', { textContent: 'Install' });
    action.onclick = async () => {
      action.disabled = true;
      action.textContent = 'Installing';
      try {
        Object.assign(inst, await api.install(inst.id, hit.projectId, type));
        action.replaceWith(el('span', { className: 'installed', textContent: 'Installed' }));
        modsChanged(inst.id); // dependencies may have come along: their rows update when Browse is next shown
      } catch (err) {
        action.disabled = false;
        action.textContent = 'Install';
        state.status[inst.id] = { state: 'error', text: errorText(err) };
        renderStatus();
      }
    };
  }
  return projectRow(hit, type, action);
}

export function projectRow(hit, type, action) {
  const title = el('a', { className: 'title', textContent: hit.title, tabIndex: 0 });
  title.onclick = () => api.openExternal(`https://modrinth.com/${type}/${hit.slug}`);
  return el('li', {}, [
    thumb(hit.iconUrl),
    el('div', { className: 'info' }, [
      el('div', {}, [title, el('span', { className: 'by', textContent: ` by ${hit.author}` })]),
      el('div', { className: 'desc', textContent: hit.description }),
    ]),
    el('span', { className: 'version', textContent: formatDownloads(hit.downloads) }),
    action,
  ]);
}

$('#search-form').onsubmit = (event) => {
  event.preventDefault();
  clearTimeout(searchTimer);
  runSearch(false);
};
// Search as you type, once typing pauses.
$('#search-query').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(false), 350);
};
$('#search-type').onchange = () => runSearch(false);
$('#load-more').onclick = () => runSearch(true);
