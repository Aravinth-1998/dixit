// Tiny WebAudio chimes + vibration helpers.
// No audio files — synthesized on the fly so the bundle stays small and
// works offline. Browsers require a user gesture before audio plays, so
// the first tap on the page calls `unlockAudio()` (wired in App.tsx).

let ctx: AudioContext | null = null;
let unlocked = false;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      ctx = null;
    }
  }
  return ctx;
}

export function unlockAudio() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  // Resume if the context was created in suspended state (Safari/iOS).
  c.resume?.().catch(() => {});
  // Schedule a near-silent blip so iOS marks the context as "user-started".
  try {
    const o = c.createOscillator();
    const g = c.createGain();
    g.gain.value = 0.0001;
    o.connect(g);
    g.connect(c.destination);
    o.start();
    o.stop(c.currentTime + 0.01);
  } catch {
    /* ignore */
  }
  unlocked = true;
}

function tone(
  freq: number,
  dur: number,
  delay = 0,
  type: OscillatorType = 'sine',
  peak = 0.16,
) {
  const c = getCtx();
  if (!c) return;
  try {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g);
    g.connect(c.destination);
    const t = c.currentTime + delay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.start(t);
    o.stop(t + dur + 0.04);
  } catch {
    /* ignore */
  }
}

export const sounds = {
  // Bright rising arpeggio — "you're the storyteller"
  yourTurn() {
    tone(523, 0.18, 0, 'triangle');         // C5
    tone(659, 0.22, 0.12, 'triangle');      // E5
    tone(784, 0.32, 0.26, 'triangle');      // G5
  },
  // Soft single note — phase advanced, something for you to do
  phaseAdvance() {
    tone(523, 0.18, 0, 'sine', 0.13);       // C5
    tone(784, 0.22, 0.1, 'sine', 0.1);      // G5
  },
  // Descending chime — votes are in, results revealed
  reveal() {
    tone(880, 0.18, 0, 'triangle');         // A5
    tone(659, 0.18, 0.14, 'triangle');      // E5
    tone(523, 0.34, 0.28, 'triangle');      // C5
  },
  // Fanfare — game over (you won)
  victory() {
    tone(523, 0.14, 0, 'triangle');
    tone(659, 0.14, 0.12, 'triangle');
    tone(784, 0.14, 0.24, 'triangle');
    tone(1047, 0.5, 0.36, 'triangle', 0.18);
  },
  // Low thud — game over (you didn't win)
  gameOverSoft() {
    tone(330, 0.4, 0, 'sine', 0.12);
    tone(247, 0.5, 0.18, 'sine', 0.1);
  },
};

/** Best-effort vibration. iOS Safari ignores it; that's fine. */
export function buzz(pattern: number | number[]) {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    /* ignore */
  }
}

