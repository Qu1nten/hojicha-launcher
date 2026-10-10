import { $, api, el, errorText } from './core.js';
import { refreshInstances } from './instance.js';
import { refreshServers } from './servers.js';

const iconPicker = { kind: null, id: null, icons: null };

export async function openIconPicker(kind, thing) {
  Object.assign(iconPicker, { kind, id: thing.id });
  $('#icon-title').textContent = `Icon for ${thing.name}`;
  $('#icon-search').value = '';
  $('#icon-error').textContent = '';
  $('#icon-dialog').showModal();
  $('#icon-search').focus();
  if (!iconPicker.icons) {
    $('#icon-grid').replaceChildren(el('p', { className: 'hint', textContent: 'Loading items…' }));
    try {
      iconPicker.icons = await api.listIcons();
    } catch (err) {
      $('#icon-error').textContent = errorText(err);
      return;
    }
  }
  renderIconGrid(thing.icon);
}

function renderIconGrid(selected) {
  const query = $('#icon-search').value.trim().toLowerCase();
  const icons = iconPicker.icons || [];
  if (!icons.length) {
    $('#icon-grid').replaceChildren(el('p', {
      className: 'hint',
      textContent: 'Item icons come from the game itself, so they show up once a Minecraft version has been downloaded. Play any instance once.',
    }));
    $('#icon-random').disabled = true;
    return;
  }
  $('#icon-random').disabled = false;
  const shown = icons.filter((i) => !query || i.label.toLowerCase().includes(query) || i.name.includes(query));
  if (!shown.length) {
    $('#icon-grid').replaceChildren(el('p', { className: 'hint', textContent: `No item called "${query}".` }));
    return;
  }
  // The list arrives grouped by category (core/icons.js): a heading starts each group.
  const nodes = [];
  for (const i of shown) {
    if (i.category !== nodes.category) {
      nodes.push(el('h3', { className: 'icon-heading', textContent: i.category }));
      nodes.category = i.category;
    }
    const button = el('button', { type: 'button', className: 'icon-choice', title: i.label, ariaLabel: i.label }, [
      el('img', { src: i.url, alt: '' }),
    ]);
    if (i.name === selected) button.classList.add('selected');
    button.onclick = () => setIcon(i.name);
    nodes.push(button);
  }
  $('#icon-grid').replaceChildren(...nodes);
}

async function setIcon(name) {
  try {
    if (iconPicker.kind === 'instance') {
      await api.setInstanceIcon(iconPicker.id, name);
      await refreshInstances();
    } else {
      await api.setServerIcon(iconPicker.id, name);
      await refreshServers();
    }
    $('#icon-dialog').close();
  } catch (err) {
    $('#icon-error').textContent = errorText(err);
  }
}

$('#icon-search').oninput = () => renderIconGrid();
$('#icon-close').onclick = () => $('#icon-dialog').close();
$('#icon-random').onclick = () => {
  const icons = iconPicker.icons || [];
  if (icons.length) setIcon(icons[Math.floor(Math.random() * icons.length)].name);
};
