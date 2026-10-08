// Hides secrets in game and server output before it reaches the Log tab, so a log pasted into a chat for help can't
// be used to sign in as the player. A Minecraft access token is a JWT; old versions also print it in a session
// string ("token:<token>:<uuid>") or among the launch arguments, and a crashing mod may print anything it was given.

const HIDDEN = '[hidden]';

const PATTERNS = [
  /eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, // a JWT: header.payload.signature
  /(--(?:accessToken|session|clientId|xuid)[\s=]+)(?!\[hidden\])\S+/gi,
  /(\btoken:)[^:\s]{16,}(?=:[0-9a-f-]{32,36}\b)/gi, // followed by the player's UUID
  /("(?:accessToken|access_token|refreshToken|refresh_token|secret_?key)"\s*:\s*")[^"]+/gi,
];

// secrets: strings to hide wherever they appear, like this launch's access token. Short ones are skipped: an offline
// account's token is "0", and hiding every 0 would wreck the log.
function redactor(secrets = []) {
  const exact = secrets.filter((s) => typeof s === 'string' && s.length >= 16);
  return (line) => {
    for (const secret of exact) line = line.split(secret).join(HIDDEN);
    for (const pattern of PATTERNS) line = line.replace(pattern, (match, prefix) => (typeof prefix === 'string' ? prefix + HIDDEN : HIDDEN));
    return line;
  };
}

module.exports = { redactor };
