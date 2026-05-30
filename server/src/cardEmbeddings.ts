import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODEL_ID = 'Xenova/clip-vit-large-patch14';

interface EmbeddingsFile {
  _model?: string;
  _dim?: number;
  cards: Record<string, number[]>;
}

function loadEmbeddings(): EmbeddingsFile | null {
  const candidates = [
    join(__dirname, '../data/cardEmbeddings.json'),
    join(__dirname, '../../data/cardEmbeddings.json'),
    join(__dirname, '../../../data/cardEmbeddings.json'),
    join(__dirname, '../../../server/data/cardEmbeddings.json'),
    join(__dirname, '../../../../server/data/cardEmbeddings.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8')) as EmbeddingsFile;
      if (raw && raw.cards && typeof raw.cards === 'object') {
        const count = Object.keys(raw.cards).length;
        // eslint-disable-next-line no-console
        console.log(`[cardEmbeddings] Loaded ${count} card embeddings from ${p}`);
        return raw;
      }
    } catch (e) {
      console.warn('[cardEmbeddings] Failed to parse', p, e);
    }
  }
  console.warn('[cardEmbeddings] No cardEmbeddings.json found. Bots will fall back to tag-based matching. Run `node scripts/generateEmbeddings.mjs` to enable visual AI.');
  return null;
}

const EMBEDDINGS = loadEmbeddings();

// Test/operational kill-switch. When false, `isEmbeddingsAvailable()` reports
// false even if the embeddings file is loaded. Used by unit tests that pin
// behaviour to the curated tag-based scorer.
let runtimeEnabled = true;
export function setEmbeddingsEnabled(enabled: boolean): void {
  runtimeEnabled = enabled;
}

/** True if visual AI is available (embeddings file loaded). */
export function isEmbeddingsAvailable(): boolean {
  return runtimeEnabled && EMBEDDINGS !== null && Object.keys(EMBEDDINGS.cards).length > 0;
}

export function hasCardEmbedding(cardId: string): boolean {
  return !!(EMBEDDINGS && EMBEDDINGS.cards[cardId]);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  // Both vectors are pre-normalized so we only need the dot product.
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ---------- Lazy text encoder ----------

interface TextEncoder {
  encode(text: string): Promise<number[] | null>;
}
let textPipelinePromise: Promise<TextEncoder | null> | null = null;
let textPipelineFailed = false;

async function getTextEncoder(): Promise<TextEncoder | null> {
  if (textPipelineFailed) return null;
  if (textPipelinePromise) return textPipelinePromise;
  textPipelinePromise = (async () => {
    try {
      // Dynamic import so the (large) module is only loaded when actually needed.
      const t: any = await import('@xenova/transformers');
      const { AutoTokenizer, CLIPTextModelWithProjection } = t;
      console.log('[cardEmbeddings] Loading CLIP text encoder (first call may take a moment)…');
      const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
      const model = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });
      console.log('[cardEmbeddings] CLIP text encoder ready.');
      return {
        async encode(text: string): Promise<number[] | null> {
          try {
            const inputs = tokenizer(text, { padding: true, truncation: true });
            const out = await model(inputs);
            const data = out.text_embeds?.data;
            if (!data) return null;
            return Array.from(data as Float32Array);
          } catch (e) {
            console.warn('[cardEmbeddings] text encode failed:', e);
            return null;
          }
        },
      };
    } catch (e) {
      console.warn('[cardEmbeddings] Failed to load CLIP text encoder; visual AI disabled.', e);
      textPipelineFailed = true;
      return null;
    }
  })();
  return textPipelinePromise;
}

// Cache of clue text -> normalized embedding vector. Bounded LRU-ish.
const clueCache = new Map<string, number[]>();
const CLUE_CACHE_MAX = 256;

function normalize(vec: number[]): number[] {
  let s = 0;
  for (const v of vec) s += v * v;
  const n = Math.sqrt(s) || 1;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

/**
 * CLIP prompt-ensemble templates. Single bare words ("game", "fire", "hope")
 * often miss obvious matches because CLIP was trained on captions like
 * "a photo of …" — embedding several rephrasings and averaging the
 * resulting vectors gives a noticeably more robust query, especially for
 * abstract or single-word clues. Standard technique from the CLIP paper.
 */
const PROMPT_TEMPLATES = [
  '{c}',
  'a picture of {c}',
  'an image of {c}',
  'a painting of {c}',
  'a scene showing {c}',
  'this is {c}',
  'the theme is {c}',
  'something about {c}',
];

/** Encode a clue string with CLIP text encoder. Returns null if unavailable. */
export async function embedClue(clue: string): Promise<number[] | null> {
  const key = clue.trim().toLowerCase();
  if (!key) return null;
  const cached = clueCache.get(key);
  if (cached) return cached;
  const enc = await getTextEncoder();
  if (!enc) return null;

  // Prompt-ensemble: embed several rephrasings, average, renormalize.
  // We always ensemble (cheap, cached per clue) — for longer phrases the
  // gain is small but never hurts; for single words the gain is large.
  const variants = PROMPT_TEMPLATES.map(t => t.replace('{c}', key));
  const vectors: number[][] = [];
  for (const v of variants) {
    const raw = await enc.encode(v);
    if (raw) vectors.push(normalize(raw));
  }
  if (vectors.length === 0) return null;
  const dim = vectors[0].length;
  const avg = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) avg[i] += v[i];
  for (let i = 0; i < dim; i++) avg[i] /= vectors.length;
  const vec = normalize(avg);

  if (clueCache.size >= CLUE_CACHE_MAX) {
    const firstKey = clueCache.keys().next().value;
    if (firstKey !== undefined) clueCache.delete(firstKey);
  }
  clueCache.set(key, vec);
  return vec;
}

/**
 * Score a clue against a single card using image/text cosine similarity.
 * Returns a value in roughly [0, 1] (CLIP similarities are usually 0.15-0.35).
 * Returns 0 if no embedding for the card or the clue couldn't be encoded.
 */
export async function scoreClueByImage(clue: string, cardId: string): Promise<number> {
  if (!EMBEDDINGS) return 0;
  const cardVec = EMBEDDINGS.cards[cardId];
  if (!cardVec) return 0;
  const clueVec = await embedClue(clue);
  if (!clueVec) return 0;
  return cosine(clueVec, cardVec);
}

/**
 * Score a clue against many cards efficiently — encodes the clue once.
 * Returns a Map<cardId, similarity>. Cards without embeddings are omitted.
 */
export async function scoreClueAgainstCards(
  clue: string,
  cardIds: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (!EMBEDDINGS) return result;
  const clueVec = await embedClue(clue);
  if (!clueVec) return result;
  for (const id of cardIds) {
    const v = EMBEDDINGS.cards[id];
    if (!v) continue;
    result.set(id, cosine(clueVec, v));
  }
  return result;
}

/**
 * Pick the best storyteller card+clue from a candidate set using image
 * similarity. For each card we score a small bank of candidate clues and
 * return the (card, clue) pair with the strongest match. Returns null if
 * embeddings aren't available.
 */
export async function pickBestStorytellerMove(
  candidates: { cardId: string; clues: string[] }[],
): Promise<{ cardId: string; clue: string; score: number } | null> {
  const ranked = await rankStorytellerMoves(candidates);
  return ranked.length ? ranked[0] : null;
}

/**
 * Like `pickBestStorytellerMove` but returns ALL (card, clue) pairs scored
 * and sorted by descending similarity. Useful for personality-based
 * sampling (the game layer can softmax over this list).
 */
export async function rankStorytellerMoves(
  candidates: { cardId: string; clues: string[] }[],
): Promise<{ cardId: string; clue: string; score: number }[]> {
  if (!EMBEDDINGS) return [];
  const allClues = Array.from(new Set(
    candidates.flatMap(c => c.clues.map(s => s.trim()).filter(Boolean)),
  ));
  if (allClues.length === 0) return [];
  const clueVecs = new Map<string, number[]>();
  for (const c of allClues) {
    const v = await embedClue(c);
    if (v) clueVecs.set(c.toLowerCase(), v);
  }
  const out: { cardId: string; clue: string; score: number }[] = [];
  for (const cand of candidates) {
    const cardVec = EMBEDDINGS.cards[cand.cardId];
    if (!cardVec) continue;
    for (const clue of cand.clues) {
      const cv = clueVecs.get(clue.trim().toLowerCase());
      if (!cv) continue;
      out.push({ cardId: cand.cardId, clue, score: cosine(cv, cardVec) });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}




