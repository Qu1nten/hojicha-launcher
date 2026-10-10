import { $, current, errorText, state } from './core.js';
import { addDroppedMods, droppedMods } from './mods.js';
import { dropModpack, droppedModpack } from './newInstance.js';
import { droppedFiles, importSchematics, showSchemNote } from './schematics.js';

{
  let depth = 0;
  const draggingFiles = (event) => event.dataTransfer?.types.includes('Files') && !document.querySelector('dialog[open]');
  const end = () => {
    depth = 0;
    document.body.classList.remove('dropping-files');
  };
  window.addEventListener('dragenter', (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    // What the files are isn't known until they're dropped: say what an open instance takes too.
    if (!depth++) {
      const inst = state.view === 'instance' ? current() : null;
      $('#app-drop span').textContent = inst && inst.loader !== 'vanilla'
        ? `Drop mods to add them to ${inst.name}, schematics to add them, or a modpack to install it`
        : 'Drop schematics to add them, or a modpack to install it';
    }
    document.body.classList.add('dropping-files');
  });
  window.addEventListener('dragover', (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!draggingFiles(event)) return;
    if (--depth <= 0) end();
  });
  window.addEventListener('drop', (event) => {
    if (!draggingFiles(event)) return;
    event.preventDefault();
    end();
    const mods = droppedMods(event);
    if (mods) {
      addDroppedMods(mods);
      return;
    }
    const pack = droppedModpack(event);
    if (pack) {
      dropModpack(pack);
      return;
    }
    // Folders can only be looked into while the drop is being handled: take hold of them now.
    const entries = [...event.dataTransfer.items].map((item) => item.webkitGetAsEntry?.()).filter(Boolean);
    droppedFiles(entries).then((dropped) => {
      if (dropped.length) importSchematics(dropped);
    }, (err) => showSchemNote(errorText(err)));
  });
}
