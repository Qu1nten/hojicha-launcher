import { $, api, errorText, listNames } from './core.js';

// Closing the launcher while a server, a game, or an instance getting ready is running: say what happens to each.
// Servers save and stop first; a game can only end with the launcher, without saving; getting ready just stops.
let stoppingToClose = false;
let closeStopsServers = false;

api.onCloseRequested(({ servers, games }) => {
  if (stoppingToClose) return; // already stopping; the window closes when that's done
  const playing = games.filter((g) => !g.preparing).map((g) => g.name);
  const preparing = games.filter((g) => g.preparing).map((g) => g.name);
  const isAre = (names) => (names.length > 1 ? 'are' : 'is');
  const itThem = (names) => (names.length > 1 ? 'them' : 'it');
  closeStopsServers = servers.length > 0;

  const sentences = [];
  if (playing.length) {
    sentences.push(`${listNames(playing)} ${isAre(playing)} still running. Closing Hojicha closes ${itThem(playing)} too, `
      + 'and anything since the last autosave is lost.');
  }
  if (preparing.length) sentences.push(`${listNames(preparing)} ${isAre(preparing)} still getting ready to play. Closing stops that.`);
  if (servers.length) {
    sentences.push(`${listNames(servers)} ${servers.length > 1 ? 'are' : 'is'} still running. Hojicha saves and stops `
      + `${itThem(servers)} before closing, which can take up to a minute.`);
  }

  const onlyServers = !games.length;
  $('#close-title').textContent = onlyServers ? (servers.length > 1 ? 'Stop the servers first?' : 'Stop the server first?')
    : playing.length && !preparing.length && !servers.length ? (playing.length > 1 ? 'Close the games too?' : 'Close the game too?')
      : 'Close Hojicha?';
  $('#close-text').textContent = sentences.join('\n'); // one line per thing still going (white-space: pre-line)
  $('#close-note').textContent = playing.length ? 'To keep everything, quit from the game\'s own menu first, then close Hojicha.' : '';
  $('#close-note').hidden = !playing.length;
  $('#close-error').textContent = '';
  $('#close-confirm').disabled = false;
  $('#close-confirm').textContent = onlyServers ? (servers.length > 1 ? 'Stop servers and close' : 'Stop server and close') : 'Close anyway';
  $('#close-cancel').disabled = false;
  $('#close-cancel').textContent = onlyServers ? 'Keep running' : 'Keep Hojicha open';
  if (!$('#close-dialog').open) $('#close-dialog').showModal();
});

$('#close-cancel').onclick = () => $('#close-dialog').close();
$('#close-confirm').onclick = async () => {
  stoppingToClose = true;
  $('#close-confirm').disabled = true;
  $('#close-cancel').disabled = true;
  $('#close-confirm').textContent = closeStopsServers ? 'Saving and stopping…' : 'Closing…';
  try {
    await api.stopServersAndClose();
  } catch (err) {
    stoppingToClose = false;
    $('#close-error').textContent = errorText(err);
    $('#close-cancel').disabled = false;
    $('#close-confirm').disabled = false;
    $('#close-confirm').textContent = 'Try again';
  }
};
// While servers are stopping, Escape mustn't hide the dialog: the window is about to close.
$('#close-dialog').addEventListener('cancel', (event) => {
  if (stoppingToClose) event.preventDefault();
});
