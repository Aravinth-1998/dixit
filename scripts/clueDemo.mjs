// Quick sanity check: ranks all 108 cards by CLIP image-text similarity
// against a few sample clues. Run with:
//   node scripts/clueDemo.mjs man
//   node scripts/clueDemo.mjs "the lonely lighthouse"
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AutoTokenizer, CLIPTextModelWithProjection } from '@xenova/transformers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const data = JSON.parse(readFileSync(join(ROOT, 'server', 'data', 'cardEmbeddings.json'), 'utf-8'));
const clues = process.argv.slice(2);
if (clues.length === 0) {
  console.error('Usage: node scripts/clueDemo.mjs "<clue>" ["<clue2>" ...]');
  process.exit(1);
}

function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(v) { let s = 0; for (const x of v) s += x*x; const n = Math.sqrt(s) || 1; return v.map(x => x/n); }

const MODEL = data._model || 'Xenova/clip-vit-base-patch32';
console.log('Loading CLIP text encoder…');
const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL, { quantized: true });

for (const clue of clues) {
  const inputs = tokenizer(clue, { padding: true, truncation: true });
  const { text_embeds } = await textModel(inputs);
  const tv = norm(Array.from(text_embeds.data));
  const ranked = Object.entries(data.cards)
    .map(([id, v]) => ({ id, score: cosine(tv, v) }))
    .sort((a, b) => b.score - a.score);
  console.log(`\n=== Clue: "${clue}" ===`);
  console.log('Top 10:');
  for (const r of ranked.slice(0, 10)) console.log(`  ${r.id}  ${r.score.toFixed(4)}`);
  console.log('Bottom 3:');
  for (const r of ranked.slice(-3)) console.log(`  ${r.id}  ${r.score.toFixed(4)}`);
}


