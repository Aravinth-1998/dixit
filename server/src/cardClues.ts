import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CardEntry {
  clues: string[];   // storyteller lines (used when this card is selected)
  tags: string[];    // concept/synonym words used for matching
}

export type CardCluesMap = Record<string, CardEntry>;

/**
 * Per-card data populated by `scripts/generateClues.mjs` (vision API) into
 * `server/data/cardClues.json`. We resolve that file at runtime so it can be
 * regenerated without rebuilding.
 *
 * Supported on-disk formats:
 *   { "card-001": ["clue1","clue2",...] }                       // legacy
 *   { "card-001": { "clues": [...], "tags": [...] } }            // current
 */
function load(): CardCluesMap {
  const candidates = [
    join(__dirname, '../data/cardClues.json'),
    join(__dirname, '../../data/cardClues.json'),
    join(__dirname, '../../../data/cardClues.json'),
    join(__dirname, '../../../server/data/cardClues.json'),
    join(__dirname, '../../../../server/data/cardClues.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
      const out: CardCluesMap = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_')) continue;
        const entry = normalizeEntry(v);
        if (entry) out[k] = entry;
      }
      return out;
    } catch (e) {
      console.warn('Failed to parse cardClues.json at', p, e);
    }
  }
  return {};
}

function normalizeEntry(v: unknown): CardEntry | null {
  if (Array.isArray(v)) {
    const clues = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    if (clues.length === 0) return null;
    // Legacy: derive tags from the clue text itself.
    const tags = Array.from(new Set(clues.flatMap(c => tokenize(c))));
    return { clues, tags };
  }
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const clues = Array.isArray(obj.clues)
      ? obj.clues.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      : [];
    const tagSrc = Array.isArray(obj.tags) ? obj.tags : [];
    const tags = Array.from(new Set(
      (tagSrc as unknown[])
        .filter((x): x is string => typeof x === 'string')
        .flatMap(t => tokenize(t)),
    ));
    if (clues.length === 0 && tags.length === 0) return null;
    return { clues, tags };
  }
  return null;
}

export const CARD_CLUES: CardCluesMap = load();

/** Generic fallbacks used only when a card has no curated clues. */
export const GENERIC_CLUES = [
  'mystery', 'a dream', 'silence', 'a journey', 'lost', 'discovery',
  'whispers', 'freedom', 'home', 'forgotten', 'the dance', 'flight',
  'wonder', 'echoes', 'beneath the surface', 'a memory', 'something brave',
  'longing', 'quiet', 'curious', 'a secret', 'awakening', 'shadows',
];

const STOP_WORDS = new Set([
  'a','an','the','and','or','but','of','to','in','on','at','for','with','from',
  'is','are','was','were','be','been','being','it','its','this','that','these',
  'those','my','your','his','her','their','our','as','by','into','over','under',
  'about','between','through','than','then','so','too','very','just','also',
  'i','you','we','they','he','she','me','us','them',
]);

/** Light stemming: collapse common English suffixes so "beasts" -> "beast". */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed'))  return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('es'))  return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s'))   return w.slice(0, -1);
  return w;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t))
    .map(stem);
}

/**
 * Score how well a free-form clue matches a card. Heavily weights matches
 * against the card's tag list (which contains synonyms/concepts), with a
 * smaller bonus for tokens appearing in the curated clue lines.
 */
export function scoreClueMatch(clue: string, cardId: string): number {
  const entry = CARD_CLUES[cardId];
  if (!entry) return 0;
  const clueTokens = tokenize(clue);
  if (clueTokens.length === 0) return 0;
  const tagSet = new Set(entry.tags);
  const clueText = entry.clues.map(c => tokenize(c));

  let score = 0;
  for (const t of clueTokens) {
    if (tagSet.has(t)) {
      score += 3; // direct concept hit (e.g. clue "beast" matches tag "beast")
      continue;
    }
    // Fuzzy: prefix/suffix overlap with any tag (catches simple variants
    // stemming missed, like "lighthouse" vs "lighthouses").
    let fuzzy = false;
    for (const tag of tagSet) {
      if (tag.length >= 4 && t.length >= 4 && (tag.startsWith(t) || t.startsWith(tag))) {
        score += 1.5;
        fuzzy = true;
        break;
      }
    }
    if (fuzzy) continue;
    // Count appearances inside curated clue lines (lower weight).
    for (const line of clueText) {
      if (line.includes(t)) { score += 1; break; }
    }
  }
  return score;
}

/** Pick a curated clue for a card, or a generic fallback. */
export function pickCardClue(cardId: string): string {
  const entry = CARD_CLUES[cardId];
  if (entry && entry.clues.length) {
    return entry.clues[Math.floor(Math.random() * entry.clues.length)];
  }
  return GENERIC_CLUES[Math.floor(Math.random() * GENERIC_CLUES.length)];
}

/** Does this card have curated data? (used by bot to prefer cards it knows) */
export function hasCardData(cardId: string): boolean {
  const e = CARD_CLUES[cardId];
  return !!e && e.clues.length > 0;
}


