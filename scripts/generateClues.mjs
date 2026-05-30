#!/usr/bin/env node
/**
 * Generate per-card Dixit-style clues by sending each card image to a
 * multimodal LLM. Writes to server/data/cardClues.json.
 *
 * Usage:
 *   # Free option (recommended): https://aistudio.google.com/apikey
 *   $env:GEMINI_API_KEY = "..."; node scripts/generateClues.mjs
 *
 *   # OpenAI option:
 *   $env:OPENAI_API_KEY = "..."; node scripts/generateClues.mjs
 *
 *   # Optional flags:
 *   node scripts/generateClues.mjs --only=card-001,card-002   # subset
 *   node scripts/generateClues.mjs --force                     # overwrite existing
 *   node scripts/generateClues.mjs --concurrency=4
 *   node scripts/generateClues.mjs --model=gemini-2.0-flash    # override model
 *
 * Resumable: existing entries in cardClues.json are kept unless --force.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CARDS_DIR = join(ROOT, 'client', 'public', 'cards');
const MANIFEST = join(CARDS_DIR, 'manifest.json');
const OUT_DIR = join(ROOT, 'server', 'data');
const OUT_FILE = join(OUT_DIR, 'cardClues.json');

// ---- args ----
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const FORCE = args.force === 'true';
const ONLY = args.only ? new Set(args.only.split(',').map(s => s.trim())) : null;
const CONCURRENCY = Math.max(1, parseInt(args.concurrency ?? '3', 10));

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const PROVIDER = GEMINI_KEY ? 'gemini' : OPENAI_KEY ? 'openai' : null;
if (!PROVIDER) {
  console.error('No API key found. Set GEMINI_API_KEY (free, recommended) or OPENAI_API_KEY.');
  process.exit(1);
}
const MODEL =
  args.model ||
  (PROVIDER === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini');

console.log(`Provider: ${PROVIDER}  Model: ${MODEL}  Concurrency: ${CONCURRENCY}  Force: ${FORCE}`);

// ---- load manifest + existing output ----
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
const ext = manifest.ext || 'png';
let cards = manifest.cards;
if (ONLY) cards = cards.filter(c => ONLY.has(c));

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
let existing = {};
if (existsSync(OUT_FILE)) {
  try { existing = JSON.parse(readFileSync(OUT_FILE, 'utf-8')); } catch { existing = {}; }
}

const todo = cards.filter(c => FORCE || !Array.isArray(existing[c]) || existing[c].length < 5);
console.log(`Cards total: ${cards.length}. To process: ${todo.length}. Already done: ${cards.length - todo.length}.`);

// ---- prompt ----
const PROMPT = `You are helping seed clues for the board game Dixit.
Look at this dreamlike illustration card and produce EXACTLY 5 short clues a
storyteller might say to evoke this image. Each clue should be 1-5 words,
poetic and evocative (Dixit style), and clearly tied to something visible or
strongly implied in the image (objects, mood, action, setting, metaphor).
Avoid generic words like "card" or "image" or "Dixit". Avoid quotes.
Return ONLY a JSON array of 5 strings, nothing else. Example:
["the lonely lighthouse","guarded by the sea","a beacon at dusk","watching the storm","keeper of secrets"]`;

// ---- API callers ----
async function callGemini(b64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: `image/${ext === 'jpg' ? 'jpeg' : ext}`, data: b64 } },
      ],
    }],
    generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return txt;
}

async function callOpenAI(b64) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: MODEL,
    temperature: 0.8,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROMPT + '\nReturn JSON like {"clues":[...5 strings...]}.' },
        { type: 'image_url', image_url: { url: `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b64}` } },
      ],
    }],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

function parseClues(txt) {
  if (!txt) return null;
  // Strip code fences if any.
  let t = txt.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(t); }
  catch {
    // Try to extract first JSON array
    const m = /\[[\s\S]*\]/.exec(t);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
  }
  let arr = Array.isArray(parsed) ? parsed : parsed?.clues;
  if (!Array.isArray(arr)) return null;
  arr = arr.map(s => String(s).trim()).filter(Boolean).slice(0, 5);
  return arr.length >= 3 ? arr : null;
}

async function processCard(cardId) {
  const file = join(CARDS_DIR, `${cardId}.${ext}`);
  if (!existsSync(file)) throw new Error(`Missing image: ${file}`);
  const b64 = readFileSync(file).toString('base64');
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const txt = PROVIDER === 'gemini' ? await callGemini(b64) : await callOpenAI(b64);
      const clues = parseClues(txt);
      if (clues) return clues;
      lastErr = new Error('Could not parse clues from: ' + txt.slice(0, 200));
    } catch (e) {
      lastErr = e;
      // Backoff on rate limits
      const wait = 1500 * attempt;
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// ---- save helper ----
let dirty = false;
let saving = false;
function saveSoon() {
  dirty = true;
  if (saving) return;
  saving = true;
  setTimeout(() => {
    saving = false;
    if (!dirty) return;
    dirty = false;
    const ordered = {
      _comment: 'Generated by scripts/generateClues.mjs. Edit by hand if you wish.',
      ...Object.fromEntries(
        Object.keys(existing).filter(k => !k.startsWith('_')).sort().map(k => [k, existing[k]]),
      ),
    };
    writeFileSync(OUT_FILE, JSON.stringify(ordered, null, 2));
  }, 500);
}

// ---- worker pool ----
let cursor = 0;
let done = 0;
let failed = 0;
async function worker(id) {
  while (cursor < todo.length) {
    const card = todo[cursor++];
    try {
      const clues = await processCard(card);
      existing[card] = clues;
      done++;
      saveSoon();
      console.log(`[${done + failed}/${todo.length}] ${card}: ${clues.join(' | ')}`);
    } catch (e) {
      failed++;
      console.warn(`[${done + failed}/${todo.length}] ${card} FAILED: ${e.message}`);
    }
  }
}

const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
await Promise.all(workers);

// Final save (flush)
dirty = true;
saving = false;
const ordered = {
  _comment: 'Generated by scripts/generateClues.mjs. Edit by hand if you wish.',
  ...Object.fromEntries(
    Object.keys(existing).filter(k => !k.startsWith('_')).sort().map(k => [k, existing[k]]),
  ),
};
writeFileSync(OUT_FILE, JSON.stringify(ordered, null, 2));
console.log(`\nDone. ${done} succeeded, ${failed} failed. Wrote ${OUT_FILE}`);

