const TOKEN_EXPANSIONS = new Map([
  ['thnx', 'thanks'], ['thx', 'thanks'], ['tnx', 'thanks'], ['thanx', 'thanks'], ['thks', 'thanks'], ['tks', 'thanks'], ['ty', 'thanks'],
  ['pls', 'please'], ['plz', 'please'], ['u', 'you'], ['ur', 'your'], ['r', 'are'],
  ['w/', 'with'], ['w/o', 'without'], ['bcoz', 'because'], ['bcuz', 'because'],
  ['coz', 'because'], ['cuz', 'because'], ['abt', 'about'], ['prev', 'previous'],
  ['nxt', 'next'], ['futre', 'future'], ['futr', 'future'], ['futrue', 'future'],
  ['upcomming', 'upcoming'], ['upcomng', 'upcoming'], ['upcomingg', 'upcoming'],
  ['summry', 'summary'], ['sumary', 'summary'], ['summery', 'summary'], ['smry', 'summary'],
  ['wht', 'what'], ['whts', 'what is'], ['curr', 'current'], ['proj', 'project'],
]);

const PHRASE_EXPANSIONS = [
  [/\bwhat['’]?s\b/g, 'what is'],
  [/\bwhats\b/g, 'what is'],
  [/\bcan['’]?t\b/g, 'cannot'],
  [/\bdon['’]?t\b/g, 'do not'],
  [/\bwon['’]?t\b/g, 'will not'],
  [/\bi['’]?m\b/g, 'i am'],
  [/\bit['’]?s\b/g, 'it is'],
];

function cleanToken(token) {
  return String(token ?? '').replace(/^[\s"'`([{<]+|[\s"'`\])}>.,!?;:]+$/g, '');
}

export function normalizeAssistantInput(value) {
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  let lowered = trimmed.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\bw\/o\b/g, 'without').replace(/\bw\//g, 'with ');
  PHRASE_EXPANSIONS.forEach(([pattern, replacement]) => { lowered = lowered.replace(pattern, replacement); });
  const expanded = lowered
    .split(/\s+/)
    .map((token) => {
      const leading = token.match(/^[^a-z0-9]*/i)?.[0] ?? '';
      const trailing = token.match(/[^a-z0-9]*$/i)?.[0] ?? '';
      const core = cleanToken(token);
      return `${leading}${TOKEN_EXPANSIONS.get(core) ?? core}${trailing}`;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = expanded.replace(/^[\s.,!?;:'"()\[\]{}<>:_=-]+|[\s.,!?;:'"()\[\]{}<>:_=-]+$/g, '').replace(/\s+/g, ' ').trim();
  const tokens = normalized.replace(/[^a-z0-9._-]+/g, ' ').split(/\s+/).filter(Boolean);
  return { raw, normalized, tokens };
}

export function normaliseLookup(value) {
  return normalizeAssistantInput(value).normalized.replace(/\s+/g, ' ');
}

export function assistantLookupTokens(value) {
  return normaliseLookup(value)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}
