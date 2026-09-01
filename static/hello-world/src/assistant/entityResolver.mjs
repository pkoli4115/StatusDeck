import { assistantLookupTokens, normaliseLookup } from './normalize.mjs';

const GENERIC_TOKENS = new Set([
  'project', 'projects', 'jira', 'software', 'team', 'teams', 'app', 'application',
  'benchmark', 'benchmarks', 'program', 'programme', 'delivery', 'status', 'report',
  'summary', 'details', 'overview', 'current', 'sprint', 'board', 'please', 'give',
]);
const CONTEXT_ONLY_PHRASES = new Set(['this', 'that', 'it', 'this project', 'that project', 'current project', 'same project', 'this sprint', 'that sprint']);

export function assistantLevenshtein(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const old = previous[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
      diagonal = old;
    }
  }
  return previous[right.length];
}

export function buildAssistantProjectCatalogue(projects) {
  return (projects ?? []).map((project) => {
    const name = normaliseLookup(project.name);
    const key = normaliseLookup(project.key);
    const nameTokens = assistantLookupTokens(project.name);
    const meaningful = nameTokens.filter((token) => token.length >= 3 && !GENERIC_TOKENS.has(token));
    const aliases = new Set([name, key]);
    meaningful.forEach((token) => { if (token.length >= 4) aliases.add(token); });
    for (let size = 2; size <= Math.min(4, meaningful.length); size += 1) {
      for (let index = 0; index <= meaningful.length - size; index += 1) aliases.add(meaningful.slice(index, index + size).join(' '));
    }
    return { project, key, name, tokens: meaningful, aliases: [...aliases].filter(Boolean) };
  });
}

export function extractAssistantProjectPhrase(question) {
  const text = String(question ?? '').trim();
  const patterns = [
    /(?:in|for|of|about|from)\s+["']?(.+?)["']?\s+project\b/i,
    /(?:summary|status|details?|overview|report|health)\s+(?:of|for|on|about)\s+["']?([^,?.:;!]+?)["']?(?=\s+(?:sprint|board)\b|[,.?]|$)/i,
    /(?:^|[,:;.!?]\s*)["']?([^,?.:;!]+?)["']?\s+project\b/i,
    /project\s+(?:called\s+|named\s+)?["']?([^,?.]+?)["']?(?=\s+(?:sprint|board)\b|[,.?]|$)/i,
  ];
  for (const pattern of patterns) {
    const value = text.match(pattern)?.[1]?.trim();
    if (value && !CONTEXT_ONLY_PHRASES.has(normaliseLookup(value))) return value;
  }
  return '';
}

function scoreProjectMention(question, entry) {
  const q = normaliseLookup(question);
  const qTokens = assistantLookupTokens(question);
  let score = 0;
  let matchedAlias = '';

  if (entry.key && new RegExp(`\\b${entry.key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i').test(q)) {
    score = 160; matchedAlias = entry.key;
  }
  if (entry.name && q.includes(entry.name) && entry.name.length > 3 && score < 150) {
    score = 150; matchedAlias = entry.name;
  }
  entry.aliases.forEach((alias) => {
    if (!alias || alias === entry.key || alias === entry.name) return;
    const words = alias.split(' ').length;
    const exact = words > 1 ? q.includes(alias) : qTokens.includes(alias);
    if (exact) {
      const aliasScore = words > 1 ? 112 + words * 5 : 82;
      if (aliasScore > score) { score = aliasScore; matchedAlias = alias; }
    }
  });
  if (score < 82) {
    qTokens.filter((token) => token.length >= 5).forEach((questionToken) => {
      entry.tokens.filter((token) => token.length >= 5).forEach((projectToken) => {
        const distance = assistantLevenshtein(questionToken, projectToken);
        const threshold = Math.max(questionToken.length, projectToken.length) >= 8 ? 2 : 1;
        if (distance <= threshold && score < 68) { score = 68; matchedAlias = projectToken; }
      });
    });
  }
  return { ...entry, score, matchedAlias };
}

export function resolveAssistantProject({ question, catalogue = [], fallbackKey = '', references = {} }) {
  const explicitPhrase = extractAssistantProjectPhrase(question);
  const ranked = catalogue
    .map((entry) => scoreProjectMention(explicitPhrase || question, entry))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.name.length - a.name.length || String(a.project.name).localeCompare(String(b.project.name)));

  if (ranked.length) {
    const best = ranked[0];
    const second = ranked[1];
    const ambiguous = second && second.score >= best.score - 4;
    if (!ambiguous) {
      return { project: best.project, explicit: true, phrase: explicitPhrase || best.matchedAlias || String(question).trim(), candidates: ranked.slice(0, 5).map((item) => item.project), confidence: best.score >= 100 ? 'high' : 'medium' };
    }
    return { project: null, explicit: true, phrase: explicitPhrase || best.matchedAlias || String(question).trim(), candidates: ranked.filter((item) => item.score >= best.score - 4).slice(0, 5).map((item) => item.project), confidence: 'medium' };
  }

  if (explicitPhrase && !references.usesContextProject && !references.usesContextSprint) {
    return { project: null, explicit: true, phrase: explicitPhrase, candidates: [], confidence: 'low' };
  }

  const fallback = catalogue.find((entry) => String(entry.project.key) === String(fallbackKey))?.project ?? null;
  return { project: fallback, explicit: false, phrase: '', candidates: [], confidence: fallback ? 'high' : 'low' };
}
