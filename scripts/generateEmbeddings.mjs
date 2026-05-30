/**
 * Pre-computes a CLIP image embedding for every card under
 * `client/public/cards/*.png` and writes them to
 * `server/data/cardEmbeddings.json`.
 *
 * Embedding model: Xenova/clip-vit-base-patch32 (512-dim, normalized).
 *
 * Run with:
 *   node scripts/generateEmbeddings.mjs
 *
 * Re-run any time the card images change. The output file is loaded at
 * runtime by `server/src/cardEmbeddings.ts`.
 */
import { readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env } from '@xenova/transformers';

// Allow remote model download; cache to local dir so subsequent runs are fast.
env.allowLocalModels = true;
env.allowRemoteModels = true;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CARDS_DIR = join(ROOT, 'client', 'public', 'cards');
const OUT_FILE = join(ROOT, 'server', 'data', 'cardEmbeddings.json');
// Larger CLIP model — much stronger at abstract/relational concepts than
// the base/patch32 variant. Quantized weights keep the download manageable
// (~250 MB) and similarity scores fit on a normal Render free-tier box.
const MODEL_ID = 'Xenova/clip-vit-large-patch14';

function round6(x) {
  // Smaller JSON, embeddings are normalized so 1e-6 precision is plenty.
  return Math.round(x * 1e6) / 1e6;
}

async function main() {
  if (!statSync(CARDS_DIR, { throwIfNoEntry: false })) {
    console.error('Cards directory not found:', CARDS_DIR);
    process.exit(1);
  }

  const files = readdirSync(CARDS_DIR)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort();

  if (files.length === 0) {
    console.error('No PNG cards found in', CARDS_DIR);
    process.exit(1);
  }

  console.log(`Found ${files.length} cards. Loading CLIP model "${MODEL_ID}"…`);
  const processor = await AutoProcessor.from_pretrained(MODEL_ID);
  const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
    quantized: true, // smaller / faster, perfectly fine for similarity
  });

  const out = {
    _model: MODEL_ID,
    _dim: null,
    _generatedAt: new Date().toISOString(),
    cards: {},
  };

  let i = 0;
  for (const file of files) {
    i += 1;
    const id = file.replace(/\.png$/i, '');
    const path = join(CARDS_DIR, file);
    try {
      const image = await RawImage.read(path);
      const inputs = await processor(image);
      const { image_embeds } = await model(inputs);
      // image_embeds: Tensor [1, dim] — already projected, normalize for cosine.
      const vec = Array.from(image_embeds.data);
      const norm = Math.hypot(...vec) || 1;
      const normalized = vec.map(v => round6(v / norm));
      out.cards[id] = normalized;
      if (out._dim === null) out._dim = normalized.length;
      if (i === 1 || i % 10 === 0 || i === files.length) {
        console.log(`  [${i}/${files.length}] ${id}  (dim=${normalized.length})`);
      }
    } catch (e) {
      console.warn(`  ! Failed to embed ${id}:`, e?.message ?? e);
    }
  }

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out));
  const kb = Math.round(statSync(OUT_FILE).size / 1024);
  console.log(`\nWrote ${Object.keys(out.cards).length} embeddings → ${OUT_FILE} (${kb} KB)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

