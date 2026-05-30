import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type CardCluesMap = Record<string, string[]>;

/**
 * Hand-curated clues per card image. Populated by
 * `scripts/generateClues.mjs` (vision API) into
 * `server/data/cardClues.json`. We resolve that file at runtime so it can be
 * regenerated without rebuilding.
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
        if (Array.isArray(v)) {
          const clues = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
          if (clues.length) out[k] = clues;
        }
      }
      return out;
    } catch (e) {
      console.warn('Failed to parse cardClues.json at', p, e);
    }
  }
  return {};
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
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/** Higher = better match between this clue and the card's curated clues. */
export function scoreClueMatch(clue: string, cardId: string): number {
  const cardClues = CARD_CLUES[cardId];
  if (!cardClues || cardClues.length === 0) return 0;
  const clueTokens = new Set(tokenize(clue));
  if (clueTokens.size === 0) return 0;
  let score = 0;
  for (const c of cardClues) {
    const cardTokens = tokenize(c);
    let local = 0;
    for (const t of cardTokens) {
      if (clueTokens.has(t)) local += 1;
      else {
        // partial: substring match for short clues (e.g. "dream" vs "dreams")
        for (const ct of clueTokens) {
          if (ct.length >= 4 && (t.startsWith(ct) || ct.startsWith(t))) {
            local += 0.5;
            break;
          }
        }
      }
    }
    score += local;
  }
  return score;
}

/** Pick a curated clue for a card, or a generic fallback. */
export function pickCardClue(cardId: string): string {
  const list = CARD_CLUES[cardId];
  if (list && list.length) return list[Math.floor(Math.random() * list.length)];
  return GENERIC_CLUES[Math.floor(Math.random() * GENERIC_CLUES.length)];
}

