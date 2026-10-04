// Runs before the stylesheet, so the launcher opens in the saved theme without a flash of the other one.
// main.js passes it in the page URL (?theme=matcha); the switch in the title bar changes it later (app.js).
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') === 'matcha'
  ? 'matcha'
  : 'hojicha';
