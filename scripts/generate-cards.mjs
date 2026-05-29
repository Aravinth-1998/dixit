// Generates 80 dreamlike-illustration SVG cards into client/public/cards/.
// Cards 1-3 are kept (your hand-crafted samples). 4-80 are produced procedurally
// using 8 scene templates x 10 color palettes, in the same visual language.
// Run: node scripts/generate-cards.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '../client/public/cards');
mkdirSync(OUT, { recursive: true });

function rng32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each palette: [skyLight, skyMid, skyDark, silhouette, accent, glow]
const PALETTES = {
  twilight: ['#fde68a', '#c084fc', '#1e1b4b', '#312e81', '#fef3c7', '#a78bfa'],
  ember:    ['#fef3c7', '#f97316', '#7c2d12', '#1c1917', '#fde68a', '#fb923c'],
  ocean:    ['#bae6fd', '#0ea5e9', '#0c4a6e', '#082f49', '#e0f2fe', '#67e8f9'],
  forest:   ['#bbf7d0', '#22c55e', '#14532d', '#052e16', '#fef9c3', '#86efac'],
  rose:     ['#fce7f3', '#ec4899', '#831843', '#1e1b4b', '#fbcfe8', '#f9a8d4'],
  dawn:     ['#fef3c7', '#fdba74', '#9a3412', '#1e1b4b', '#fff7ed', '#fde68a'],
  winter:   ['#e0e7ff', '#a78bfa', '#1e293b', '#0f172a', '#f8fafc', '#bae6fd'],
  ruby:     ['#fee2e2', '#ef4444', '#7f1d1d', '#1c1917', '#fef2f2', '#fca5a5'],
  emerald:  ['#a7f3d0', '#10b981', '#064e3b', '#052e16', '#ecfdf5', '#6ee7b7'],
  amber:    ['#fef3c7', '#eab308', '#713f12', '#1c1917', '#fefce8', '#fde047'],
};
const PALETTE_NAMES = Object.keys(PALETTES);

function defs(seed, p) {
  const [skyL, skyM, skyD, , accent] = p;
  return `<defs>
    <radialGradient id="sky${seed}" cx="50%" cy="35%" r="80%">
      <stop offset="0%" stop-color="${skyL}"/>
      <stop offset="40%" stop-color="${skyM}"/>
      <stop offset="100%" stop-color="${skyD}"/>
    </radialGradient>
    <radialGradient id="glow${seed}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft${seed}"><feGaussianBlur stdDeviation="1.2"/></filter>
  </defs>`;
}

function stars(rng, count) {
  let out = '<g fill="#fef3c7">';
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rng() * 400);
    const y = Math.floor(rng() * 460);
    const r = (0.8 + rng() * 1.2).toFixed(2);
    out += `<circle cx="${x}" cy="${y}" r="${r}"/>`;
  }
  return out + '</g>';
}

// ============== SCENE TEMPLATES ==============

function whaleSky(rng, p, seed) {
  const [skyL, , , sil, accent, glow] = p;
  const moonX = 200 + Math.floor((rng() - 0.5) * 200);
  const moonY = 100 + Math.floor(rng() * 80);
  return `
    <circle cx="${moonX}" cy="${moonY}" r="${60 + Math.floor(rng() * 30)}" fill="url(#glow${seed})"/>
    <circle cx="${moonX}" cy="${moonY}" r="38" fill="${accent}" opacity="0.95"/>
    ${stars(rng, 14)}
    <ellipse cx="100" cy="280" rx="120" ry="22" fill="${skyL}" opacity="0.4" filter="url(#soft${seed})"/>
    <ellipse cx="320" cy="350" rx="110" ry="18" fill="${skyL}" opacity="0.3" filter="url(#soft${seed})"/>
    <ellipse cx="160" cy="400" rx="140" ry="20" fill="${skyL}" opacity="0.4" filter="url(#soft${seed})"/>
    <g transform="translate(80,420)">
      <path d="M 0,40 C 40,-10 200,-10 240,30 C 260,50 250,75 230,80 C 200,85 60,90 30,80 C 5,72 -10,55 0,40 Z" fill="${sil}"/>
      <path d="M 230,40 C 270,20 290,5 295,15 C 297,30 285,55 260,60 Z" fill="${sil}"/>
      <path d="M 240,55 C 275,55 295,72 290,82 C 280,80 255,75 240,65 Z" fill="${sil}"/>
      <path d="M 30,65 C 80,80 180,80 220,68 C 200,75 130,80 60,75 Z" fill="${glow}" opacity="0.4"/>
      <circle cx="40" cy="42" r="3" fill="${accent}"/>
    </g>
    <ellipse cx="200" cy="585" rx="280" ry="35" fill="${sil}" opacity="0.9"/>
  `;
}

function lighthouseMoon(rng, p, seed) {
  const [, , , sil, accent, glow] = p;
  const moonR = 130 + Math.floor(rng() * 50);
  return `
    <circle cx="200" cy="330" r="${moonR}" fill="url(#glow${seed})" opacity="0.9"/>
    <circle cx="200" cy="330" r="${Math.floor(moonR * 0.72)}" fill="${accent}" opacity="0.95"/>
    <circle cx="${190 + Math.floor(rng()*20)}" cy="${320 + Math.floor(rng()*20)}" r="6" fill="${glow}" opacity="0.5"/>
    ${stars(rng, 8)}
    <rect x="0" y="440" width="400" height="160" fill="${sil}"/>
    <path d="M 140,440 L 260,440 L 290,600 L 110,600 Z" fill="${accent}" opacity="0.15"/>
    <g stroke="${accent}" stroke-opacity="0.45" stroke-width="1.5" fill="none">
      <path d="M 130,465 Q 200,461 270,465"/>
      <path d="M 115,490 Q 200,485 285,490"/>
      <path d="M 100,520 Q 200,514 300,520"/>
      <path d="M 85,560 Q 200,553 315,560"/>
    </g>
    <ellipse cx="200" cy="455" rx="100" ry="14" fill="${sil}"/>
    <path d="M 125,455 C 150,425 250,425 275,455 Z" fill="${sil}"/>
    <g transform="translate(200,335)" fill="${sil}">
      <rect x="-14" y="80" width="28" height="40"/>
      <path d="M -10,80 L 10,80 L 6,10 L -6,10 Z"/>
      <rect x="-10" y="60" width="20" height="6" fill="${accent}" opacity="0.65"/>
      <rect x="-10" y="35" width="20" height="6" fill="${accent}" opacity="0.65"/>
      <rect x="-9" y="-6" width="18" height="16"/>
      <path d="M -12,-6 L 12,-6 L 0,-22 Z"/>
    </g>
    <circle cx="200" cy="337" r="5" fill="${accent}"/>
    <path d="M 200,337 L 80,275 L 80,295 Z" fill="${accent}" opacity="0.18" filter="url(#soft${seed})"/>
    <path d="M 200,337 L 320,283 L 320,303 Z" fill="${accent}" opacity="0.18" filter="url(#soft${seed})"/>
  `;
}

function enchantedForest(rng, p, seed) {
  const [, , , sil, accent, glow] = p;
  function tree(cx, base, scale) {
    return `
      <g transform="translate(${cx},${base}) scale(${scale})">
        <rect x="-9" y="0" width="18" height="220" fill="${sil}"/>
        <ellipse cx="0" cy="0" rx="65" ry="80" fill="${sil}"/>
        <ellipse cx="-28" cy="-35" rx="30" ry="34" fill="${sil}" opacity="0.85"/>
        <ellipse cx="30" cy="-12" rx="28" ry="32" fill="${sil}" opacity="0.85"/>
      </g>`;
  }
  let orns = '';
  for (let i = 0; i < 6; i++) {
    const cx = 60 + i * 56 + Math.floor(rng() * 10);
    const cy = 290 + Math.floor(rng() * 30);
    const s = (0.85 + rng() * 0.5).toFixed(2);
    orns += `
      <g transform="translate(${cx},${cy}) scale(${s})">
        <line x1="0" y1="-60" x2="0" y2="-10" stroke="${accent}" stroke-width="0.7" opacity="0.7"/>
        <circle cx="0" cy="0" r="12" fill="url(#glow${seed})"/>
        <circle cx="0" cy="0" r="6" fill="${accent}"/>
        <circle cx="-2" cy="-2" r="2" fill="${glow}"/>
      </g>`;
  }
  return `
    <circle cx="200" cy="80" r="60" fill="url(#glow${seed})"/>
    <circle cx="200" cy="80" r="30" fill="${accent}" opacity="0.95"/>
    ${stars(rng, 8)}
    <ellipse cx="200" cy="430" rx="220" ry="28" fill="${glow}" opacity="0.35" filter="url(#soft${seed})"/>
    <ellipse cx="200" cy="475" rx="200" ry="20" fill="${glow}" opacity="0.45" filter="url(#soft${seed})"/>
    ${tree(80, 305, 0.85)}
    ${tree(200, 265, 1.0)}
    ${tree(320, 315, 0.85)}
    ${orns}
    <ellipse cx="200" cy="590" rx="280" ry="30" fill="${sil}"/>
    <g transform="translate(200,530)" fill="${sil}">
      <ellipse cx="0" cy="20" rx="28" ry="6" opacity="0.6"/>
      <path d="M -10,0 L 10,0 L 14,20 L -14,20 Z"/>
      <circle cx="0" cy="-12" r="9"/>
    </g>
  `;
}

function balloon(rng, p, seed) {
  const [skyL, , , sil, accent, glow] = p;
  const bx = 200 + Math.floor((rng() - 0.5) * 100);
  const sx = 100 + Math.floor(rng() * 200);
  const sy = 100 + Math.floor(rng() * 80);
  return `
    <circle cx="${sx}" cy="${sy}" r="55" fill="url(#glow${seed})"/>
    <circle cx="${sx}" cy="${sy}" r="22" fill="${accent}" opacity="0.85"/>
    ${stars(rng, 10)}
    <ellipse cx="80"  cy="320" rx="90"  ry="14" fill="${skyL}" opacity="0.4" filter="url(#soft${seed})"/>
    <ellipse cx="330" cy="380" rx="100" ry="16" fill="${skyL}" opacity="0.4" filter="url(#soft${seed})"/>
    <g transform="translate(${bx},250)">
      <ellipse cx="0" cy="0" rx="70" ry="85" fill="${sil}"/>
      <path d="M -70,0 C -65,-30 -50,-60 0,-85 C 50,-60 65,-30 70,0 Z" fill="${accent}" opacity="0.4"/>
      <path d="M -25,-80 C -25,-50 -25,-20 -25,30 M 0,-85 C 0,-50 0,-20 0,30 M 25,-80 C 25,-50 25,-20 25,30"
            stroke="${glow}" stroke-width="2" fill="none" opacity="0.6"/>
      <path d="M -60,40 L -25,90 M 60,40 L 25,90" stroke="${sil}" stroke-width="1.5" fill="none"/>
      <rect x="-22" y="88" width="44" height="30" rx="4" fill="${sil}"/>
      <rect x="-18" y="92" width="36" height="6" fill="${accent}" opacity="0.6"/>
    </g>
    <ellipse cx="200" cy="590" rx="280" ry="35" fill="${sil}" opacity="0.85"/>
  `;
}

function mountainPeaks(rng, p, seed) {
  const [, , , sil, accent, glow] = p;
  return `
    <circle cx="200" cy="220" r="${100 + Math.floor(rng()*40)}" fill="url(#glow${seed})"/>
    <circle cx="200" cy="220" r="60" fill="${accent}" opacity="0.95"/>
    ${stars(rng, 9)}
    <ellipse cx="200" cy="350" rx="240" ry="22" fill="${glow}" opacity="0.3" filter="url(#soft${seed})"/>
    <path d="M -20,420 L 80,300 L 180,400 L 280,290 L 400,400 L 420,500 L -20,500 Z" fill="${sil}" opacity="0.6"/>
    <path d="M -20,460 L 60,360 L 160,440 L 260,350 L 380,460 L 420,540 L -20,540 Z" fill="${sil}" opacity="0.8"/>
    <path d="M -20,520 L 100,410 L 200,510 L 320,400 L 420,520 L 420,600 L -20,600 Z" fill="${sil}"/>
    <path d="M 90,420 L 100,410 L 110,420 L 102,425 Z" fill="${accent}" opacity="0.85"/>
    <path d="M 310,410 L 320,400 L 330,410 L 322,415 Z" fill="${accent}" opacity="0.85"/>
    <g transform="translate(200,503)" fill="${accent}">
      <circle cx="0" cy="-6" r="2.5"/>
      <path d="M -2.5,-4 L 2.5,-4 L 3.5,4 L -3.5,4 Z"/>
    </g>
  `;
}

function lonelyDoor(rng, p, seed) {
  const [, , , sil, accent, glow] = p;
  const bx = 250 + Math.floor(rng()*40);
  const by = 200 + Math.floor(rng()*40);
  return `
    <circle cx="200" cy="240" r="160" fill="url(#glow${seed})"/>
    ${stars(rng, 10)}
    <ellipse cx="200" cy="510" rx="280" ry="30" fill="${sil}" opacity="0.6"/>
    <ellipse cx="200" cy="540" rx="300" ry="40" fill="${sil}" opacity="0.85"/>
    <ellipse cx="200" cy="585" rx="320" ry="40" fill="${sil}"/>
    <rect x="150" y="498" width="100" height="6" fill="${sil}"/>
    <rect x="145" y="510" width="110" height="6" fill="${sil}"/>
    <rect x="140" y="522" width="120" height="6" fill="${sil}"/>
    <rect x="160" y="320" width="80" height="180" fill="${sil}"/>
    <rect x="166" y="326" width="68" height="168" fill="${accent}" opacity="0.85"/>
    <rect x="170" y="330" width="60" height="160" fill="${glow}" opacity="0.8"/>
    <path d="M 170,490 L 30,580 L 30,600 L 370,600 L 370,580 L 230,490 Z" fill="${glow}" opacity="0.18"/>
    <circle cx="225" cy="410" r="3.5" fill="${sil}"/>
    <g transform="translate(${bx},${by})" fill="${accent}">
      <path d="M -8,0 Q -4,-6 0,0 Q 4,-6 8,0 Z"/>
    </g>
  `;
}

function giantFlower(rng, p, seed) {
  const [, , , sil, accent, glow] = p;
  return `
    <circle cx="200" cy="120" r="80" fill="url(#glow${seed})"/>
    ${stars(rng, 8)}
    <ellipse cx="200" cy="540" rx="300" ry="40" fill="${sil}"/>
    <ellipse cx="200" cy="590" rx="320" ry="35" fill="${sil}"/>
    <rect x="195" y="280" width="10" height="280" fill="${sil}"/>
    <path d="M 200,400 C 150,395 130,430 175,440 C 195,435 200,420 200,400 Z" fill="${sil}"/>
    <path d="M 200,340 C 250,335 280,375 230,385 C 210,380 200,360 200,340 Z" fill="${sil}"/>
    <g transform="translate(200,270)">
      <ellipse cx="0" cy="-55" rx="22" ry="40" fill="${accent}"/>
      <ellipse cx="48" cy="-28" rx="22" ry="40" fill="${accent}" transform="rotate(60 48 -28)"/>
      <ellipse cx="48" cy="28" rx="22" ry="40" fill="${accent}" transform="rotate(120 48 28)"/>
      <ellipse cx="0" cy="55" rx="22" ry="40" fill="${accent}"/>
      <ellipse cx="-48" cy="28" rx="22" ry="40" fill="${accent}" transform="rotate(60 -48 28)"/>
      <ellipse cx="-48" cy="-28" rx="22" ry="40" fill="${accent}" transform="rotate(120 -48 -28)"/>
      <circle cx="0" cy="0" r="26" fill="${glow}"/>
      <circle cx="0" cy="0" r="14" fill="${sil}"/>
      <circle cx="-3" cy="-3" r="3" fill="${accent}"/>
    </g>
    <g transform="translate(120,520)" fill="${sil}">
      <ellipse cx="0" cy="14" rx="20" ry="4" opacity="0.6"/>
      <path d="M -7,0 L 7,0 L 10,14 L -10,14 Z"/>
      <circle cx="0" cy="-9" r="7"/>
    </g>
  `;
}

function loneBoat(rng, p, seed) {
  const [, , , sil, accent, glow] = p;
  const moonX = 200 + Math.floor((rng() - 0.5) * 120);
  return `
    <circle cx="${moonX}" cy="180" r="${70 + Math.floor(rng()*30)}" fill="url(#glow${seed})"/>
    <circle cx="${moonX}" cy="180" r="42" fill="${accent}" opacity="0.95"/>
    ${stars(rng, 14)}
    <rect x="0" y="380" width="400" height="220" fill="${sil}"/>
    <path d="M ${moonX-60},380 L ${moonX+60},380 L ${moonX+100},600 L ${moonX-100},600 Z" fill="${accent}" opacity="0.18"/>
    <g stroke="${accent}" stroke-opacity="0.45" stroke-width="1.5" fill="none">
      <path d="M 50,410 Q 200,405 350,410"/>
      <path d="M 40,440 Q 200,433 360,440"/>
      <path d="M 30,475 Q 200,467 370,475"/>
      <path d="M 20,515 Q 200,506 380,515"/>
      <path d="M 10,560 Q 200,550 390,560"/>
    </g>
    <g transform="translate(200,440)">
      <path d="M -50,0 Q -40,18 40,18 Q 50,18 55,0 Z" fill="${sil}"/>
      <path d="M -40,4 Q -32,14 32,14 Q 40,14 45,4 Z" fill="${accent}" opacity="0.4"/>
      <rect x="-1" y="-55" width="2" height="55" fill="${sil}"/>
      <path d="M 0,-52 L 28,-5 L 0,-5 Z" fill="${accent}" opacity="0.85"/>
      <circle cx="-20" cy="-4" r="3" fill="${accent}"/>
    </g>
    <ellipse cx="200" cy="470" rx="55" ry="4" fill="${sil}" opacity="0.5"/>
  `;
}

const SCENES = [
  whaleSky, lighthouseMoon, enchantedForest, balloon,
  mountainPeaks, lonelyDoor, giantFlower, loneBoat,
];
const SCENE_NAMES = [
  'whaleSky', 'lighthouseMoon', 'enchantedForest', 'balloon',
  'mountainPeaks', 'lonelyDoor', 'giantFlower', 'loneBoat',
];

function renderCard(seed, sceneIdx, paletteName) {
  const palette = PALETTES[paletteName];
  const rng = rng32(seed * 9973 + 7);
  const body = SCENES[sceneIdx](rng, palette, seed);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 600" width="400" height="600">
${defs(seed, palette)}
<rect width="400" height="600" fill="url(#sky${seed})"/>
${body}
</svg>
`;
}

// 8 scenes x 10 palettes = 80 unique combos; we use 77 (cards 4..80).
function buildAssignments() {
  const combos = [];
  for (let s = 0; s < SCENES.length; s++) {
    for (let p = 0; p < PALETTE_NAMES.length; p++) {
      combos.push({ sceneIdx: s, paletteName: PALETTE_NAMES[p] });
    }
  }
  const rng = rng32(42);
  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }
  return combos;
}

const TOTAL = 80;
const RESERVED = 3; // card-001..003 are hand-crafted, leave alone
const combos = buildAssignments();

let wrote = 0;
for (let n = RESERVED + 1; n <= TOTAL; n++) {
  const id = `card-${String(n).padStart(3, '0')}`;
  const { sceneIdx, paletteName } = combos[n - 1];
  const svg = renderCard(n, sceneIdx, paletteName);
  writeFileSync(join(OUT, `${id}.svg`), svg);
  wrote++;
  if (n % 10 === 0) {
    console.log(`  generated up to ${id}  (${SCENE_NAMES[sceneIdx]} / ${paletteName})`);
  }
}

const ids = [];
for (let n = 1; n <= TOTAL; n++) ids.push(`card-${String(n).padStart(3, '0')}`);
writeFileSync(
  join(OUT, 'manifest.json'),
  JSON.stringify({ cards: ids, ext: 'svg' }, null, 2)
);

console.log(`\nDone — wrote ${wrote} new cards (4..${TOTAL}); manifest lists all ${TOTAL}.`);
console.log(`Output: ${OUT}`);
