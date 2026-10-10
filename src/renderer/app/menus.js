import { $, current } from './core.js';
import { isSharedFolder, schem } from './schematics.js';
import { fillJoinMenu } from './servers.js';
import { appSettings, gb, memoryOptions } from './settings.js';
import { fillCapeMenu } from './skins.js';

// What you do to an instance or server itself (rename, icon, folder, delete), kept out of the way of playing it.
// Both menus behave the same: they open under their ⋯ button, and close on a click outside, on Escape, and after
// any item except a choice in a select (the instance's memory).
export const MENUS = [
  { button: '#inst-more', menu: '#inst-menu', fill: () => memoryOptions($('#inst-memory'), current().memoryMb || null, `Default (${gb(appSettings.memoryMb)})`) },
  { button: '#srv-more', menu: '#srv-menu', fill: () => {} },
  { button: '#srv-join', menu: '#join-menu', fill: () => fillJoinMenu() }, // opened by Start and join's own click
  { button: '#cape-change', menu: '#cape-menu', fill: () => fillCapeMenu() }, // in the skin window
  // New folders go in the shared folder shown: not in an instance's own, nor in the filter's results.
  { button: '#schem-more', menu: '#schem-more-menu', fill: () => { $('#schem-new-folder').disabled = !isSharedFolder(schem.at) || Boolean(schem.filter.trim()); } },
];

export function openMenu({ button, menu, fill }) {
  closeMenus();
  fill();
  $(menu).hidden = false;
  $(button).setAttribute('aria-expanded', 'true');
  $(`${menu} [role^="menuitem"]:not(:disabled)`)?.focus();
}

export function closeMenu({ button, menu }, returnFocus = false) {
  if ($(menu).hidden) return;
  $(menu).hidden = true;
  $(button).setAttribute('aria-expanded', 'false');
  if (returnFocus) $(button).focus();
}

export function closeMenus() {
  for (const entry of MENUS) closeMenu(entry);
}

export const closeInstanceMenu = () => closeMenu(MENUS[0]);

for (const entry of MENUS) {
  const menu = $(entry.menu);
  $(entry.button).onclick = () => (menu.hidden ? openMenu(entry) : closeMenu(entry));
  menu.addEventListener('click', (event) => {
    if (event.target.closest('[role^="menuitem"]')) closeMenu(entry);
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[role^="menuitem"]:not(:disabled), select')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault(); // in a dialog (the cape menu), Escape closes only the menu, not the dialog too
      closeMenu(entry, true);
    }
    if (event.target.tagName === 'SELECT') return; // arrow keys pick the memory there
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
  });
}
document.addEventListener('mousedown', (event) => {
  if (!event.target.closest('.more-wrap')) closeMenus();
});
