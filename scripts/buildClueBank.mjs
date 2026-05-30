/**
 * Builds `server/data/cardClues.json` automatically from card image
 * embeddings + a curated pool of Dixit-flavored clue phrases and tag words.
 *
 * For each card we:
 *   1. Embed every phrase / tag word with CLIP text encoder.
 *   2. Score it against the card's pre-computed image vector (cosine).
 *   3. Keep the top-K phrases as `clues` and top-K words as `tags`.
 *
 * This gives every card 8 tonally-appropriate storyteller clues and a
 * useful tag set without any external API. Quality is bounded by CLIP-Large
 * but is dramatically better than the empty `cardClues.json` we had before.
 *
 * Run with:
 *   node scripts/buildClueBank.mjs
 *
 * Output is loaded at runtime by `server/src/cardClues.ts`.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoTokenizer, CLIPTextModelWithProjection } from '@xenova/transformers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EMBED_FILE = join(ROOT, 'server', 'data', 'cardEmbeddings.json');
const OUT_FILE   = join(ROOT, 'server', 'data', 'cardClues.json');
const CLUES_PER_CARD = 8;
const TAGS_PER_CARD = 15;

// ---------- Curated phrase pool ----------
// Short, evocative storyteller clues spanning the typical Dixit register:
// emotions, journeys, fairytale archetypes, single-word abstractions, and
// gently surreal images. The CLIP scorer will pick the ones most aligned
// with each card's actual imagery.
const CLUE_POOL = [
  // Emotions / abstractions
  'loneliness', 'hope', 'fear', 'joy', 'longing', 'regret', 'wonder', 'awakening',
  'freedom', 'silence', 'mystery', 'curiosity', 'serenity', 'melancholy', 'rage',
  'desire', 'envy', 'pride', 'shame', 'tenderness', 'innocence', 'nostalgia',
  'belonging', 'isolation', 'forgiveness', 'patience', 'restlessness',
  // Single-word images
  'shadows', 'whispers', 'flight', 'home', 'memory', 'dream', 'echoes', 'roots',
  'thresholds', 'mirrors', 'masks', 'crowns', 'gifts', 'wounds', 'chains',
  // Short phrases — Dixit hallmark
  'a journey begins', 'the last guest', 'the lighthouse keeper', 'a paper boat',
  'beneath the surface', 'the price of a wish', 'what we leave behind',
  'a quiet rebellion', 'the road not taken', 'the first snow', 'after the storm',
  'between two worlds', 'a stolen moment', 'the unexpected guest', 'an honest mistake',
  'the weight of a promise', 'a small kindness', 'the long way home',
  'caught in the act', 'the morning after', 'a familiar stranger', 'lost and found',
  'the inner child', 'an open door', 'the closed window', 'the empty chair',
  'a path through the woods', 'the keeper of secrets', 'the moment before',
  'the moment after', 'when the music stopped', 'breaking the spell',
  'crossing the threshold', 'the wild hunt', 'a quiet rebellion',
  // Fairytale / archetypal
  'the wolf at the door', 'a sleeping beauty', 'the runaway', 'the wanderer',
  'the dreamer', 'the jester', 'the hermit', 'the trickster', 'the orphan',
  'the chosen one', 'the witch in the woods', 'the prince in disguise',
  'the kingdom by the sea', 'the dragon and the egg', 'the golden cage',
  // Nature / atmosphere
  'twilight', 'dawn breaks', 'the eye of the storm', 'beneath the waves',
  'between the trees', 'midnight garden', 'the burning forest', 'a frozen lake',
  'the desert speaks', 'mountain echoes', 'meadow of dreams', 'underground river',
  'the falling sky', 'first light', 'the long night',
  // Surreal / metaphorical
  'time stands still', 'the world turned upside down', 'a memory unraveling',
  'inside the mirror', 'the shape of silence', 'a city of glass',
  'where shadows live', 'the weight of light', 'breathing colours',
  'walking on water', 'a tower of birds', 'the secret museum',
  'the cartographer of dreams', 'a clock with no hands', 'the room that grew',
  // Conflict / drama
  'the betrayal', 'the duel', 'the escape', 'the rescue', 'the confession',
  'the revelation', 'the homecoming', 'the goodbye', 'the reunion',
  // Whimsical / playful
  'a tea party', 'the great chase', 'mischief making', 'a small triumph',
  'the lucky one', 'the eavesdropper', 'a hidden talent', 'the parade',
  'the magic trick', 'a found family', 'the storyteller', 'first kiss',
  // Concrete-but-poetic
  'the cathedral of trees', 'a candle in the dark', 'the abandoned house',
  'the empty crib', 'the broken crown', 'the silver thread', 'the red door',
  'a single feather', 'the last leaf', 'the open book', 'a folded letter',
  'the closed eye', 'the listening ear', 'the offered hand',
  // Dark / shadow side
  'the monster inside', 'a quiet madness', 'the long shadow', 'what hunts us',
  'the price of power', 'the cost of love', 'a slow undoing', 'the descent',
  // Light / triumph
  'the answer', 'a clear sky', 'breaking free', 'the breakthrough',
  'finding the key', 'the path opens', 'the bird takes flight', 'rising',
];

// ---------- Curated tag pool ----------
// Single words used by the legacy `scoreClueMatch` tag-overlap scorer.
const TAG_POOL = [
  // Beings
  'man', 'woman', 'child', 'baby', 'boy', 'girl', 'king', 'queen', 'witch', 'wizard',
  'knight', 'prince', 'princess', 'angel', 'demon', 'monster', 'beast', 'dragon',
  'fairy', 'mermaid', 'ghost', 'giant', 'dwarf', 'jester', 'hermit', 'pirate',
  'soldier', 'sailor', 'farmer', 'priest', 'thief', 'hunter', 'dancer', 'musician',
  'family', 'crowd', 'lover', 'stranger', 'friend', 'enemy',
  // Animals
  'cat', 'dog', 'horse', 'wolf', 'fox', 'bear', 'lion', 'tiger', 'elephant',
  'rabbit', 'mouse', 'bird', 'owl', 'eagle', 'crow', 'dove', 'butterfly',
  'fish', 'whale', 'snake', 'spider', 'frog', 'sheep', 'goat', 'deer',
  // Nature
  'tree', 'forest', 'flower', 'leaf', 'mountain', 'river', 'lake', 'sea', 'ocean',
  'cloud', 'sky', 'sun', 'moon', 'star', 'rainbow', 'storm', 'rain', 'snow',
  'fire', 'water', 'earth', 'wind', 'fog', 'ice', 'lightning', 'desert', 'meadow',
  'island', 'cave', 'volcano', 'waterfall', 'beach', 'garden',
  // Objects
  'book', 'key', 'door', 'window', 'mirror', 'crown', 'sword', 'shield', 'arrow',
  'lantern', 'candle', 'clock', 'compass', 'map', 'letter', 'ring', 'necklace',
  'mask', 'hat', 'shoe', 'umbrella', 'balloon', 'kite', 'boat', 'ship', 'train',
  'car', 'wheel', 'ladder', 'rope', 'chain', 'cage', 'basket', 'cup', 'bottle',
  'feather', 'shell', 'stone', 'gem', 'coin', 'gold', 'silver',
  // Places
  'castle', 'tower', 'bridge', 'house', 'cottage', 'church', 'temple', 'palace',
  'cave', 'tunnel', 'road', 'path', 'stairs', 'rooftop', 'attic', 'cellar',
  'kitchen', 'bedroom', 'library', 'graveyard', 'circus', 'market', 'farm', 'city',
  // Actions / states
  'running', 'flying', 'falling', 'sleeping', 'dancing', 'singing', 'crying',
  'laughing', 'kissing', 'fighting', 'hiding', 'hunting', 'reading', 'writing',
  'climbing', 'swimming', 'dreaming', 'waiting', 'searching', 'escaping',
  // Emotions
  'love', 'hate', 'joy', 'sadness', 'fear', 'anger', 'hope', 'despair',
  'peace', 'chaos', 'lonely', 'happy', 'angry', 'afraid', 'curious', 'brave',
  // Concepts
  'death', 'birth', 'magic', 'dream', 'memory', 'time', 'journey', 'wedding',
  'party', 'birthday', 'secret', 'gift', 'treasure', 'mystery', 'silence',
  'darkness', 'light', 'shadow', 'reflection', 'illusion',
  // Colors / qualities
  'red', 'blue', 'green', 'yellow', 'black', 'white', 'gold', 'silver', 'dark',
  'bright', 'old', 'young', 'small', 'huge', 'beautiful', 'broken',
];

// ---------- Helpers ----------
function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function normalize(v) {
  let s = 0; for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1; return v.map(x => x / n);
}

async function embedAll(strings, tokenizer, model, batchSize = 16) {
  const vectors = new Map();
  for (let i = 0; i < strings.length; i += batchSize) {
    const batch = strings.slice(i, i + batchSize);
    const inputs = tokenizer(batch, { padding: true, truncation: true });
    const { text_embeds } = await model(inputs);
    const data = text_embeds.data;
    const dim = text_embeds.dims[1];
    for (let j = 0; j < batch.length; j++) {
      const slice = Array.from(data.slice(j * dim, (j + 1) * dim));
      vectors.set(batch[j], normalize(slice));
    }
    process.stdout.write(`\r  encoded ${Math.min(i + batchSize, strings.length)}/${strings.length}`);
  }
  process.stdout.write('\n');
  return vectors;
}

// ---------- Main ----------
async function main() {
  const embedFile = JSON.parse(readFileSync(EMBED_FILE, 'utf-8'));
  const cards = embedFile.cards;
  const cardIds = Object.keys(cards).sort();
  const MODEL = embedFile._model || 'Xenova/clip-vit-large-patch14';
  console.log(`Loading text encoder for ${MODEL}…`);
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  const model = await CLIPTextModelWithProjection.from_pretrained(MODEL, { quantized: true });

  // Dedup pools (some entries appear in both — that's fine).
  const cluePool = Array.from(new Set(CLUE_POOL.map(s => s.trim()))).filter(Boolean);
  const tagPool  = Array.from(new Set(TAG_POOL.map(s => s.trim().toLowerCase()))).filter(Boolean);

  console.log(`Encoding ${cluePool.length} clue phrases…`);
  const clueVecs = await embedAll(cluePool, tokenizer, model);
  console.log(`Encoding ${tagPool.length} tag words…`);
  const tagVecs  = await embedAll(tagPool, tokenizer, model);

  console.log(`\nScoring ${cardIds.length} cards…`);
  const out = {
    _comment: 'Auto-generated by scripts/buildClueBank.mjs from CLIP image-text similarity. Re-run any time the card images change.',
    _model: MODEL,
    _generatedAt: new Date().toISOString(),
  };

  for (const id of cardIds) {
    const cardVec = cards[id];
    const ranked = (vecs) => {
      const scored = [];
      for (const [text, v] of vecs.entries()) scored.push({ text, score: cosine(v, cardVec) });
      scored.sort((a, b) => b.score - a.score);
      return scored;
    };
    const topClues = ranked(clueVecs).slice(0, CLUES_PER_CARD).map(x => x.text);
    const topTags  = ranked(tagVecs).slice(0, TAGS_PER_CARD).map(x => x.text);
    out[id] = { clues: topClues, tags: topTags };
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Wrote ${cardIds.length} entries → ${OUT_FILE}`);

  // Quick spot-check.
  for (const id of cardIds.slice(0, 3)) {
    console.log(`\n${id}:`);
    console.log('  clues:', out[id].clues);
    console.log('  tags :', out[id].tags.slice(0, 8).join(', '));
  }
}

main().catch(e => { console.error(e); process.exit(1); });

