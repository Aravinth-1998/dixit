import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { addBot, addPlayer, createRoom, doBotVote, doBotSubmit, startGame, submitClue, submitCard, BOT_PERSONALITIES } from '../src/game.js';
import { isEmbeddingsAvailable, setEmbeddingsEnabled } from '../src/cardEmbeddings.js';

// These tests rely on the visual-AI path being active so personality
// temperature actually drives choices. If the embeddings file isn't
// present (e.g. on a fresh clone before running `embeddings:generate`),
// we skip — there's nothing meaningful to assert.
const POOL = Array.from({ length: 50 }, (_, i) => `card-${String(i + 1).padStart(3, '0')}`);

beforeAll(() => setEmbeddingsEnabled(true));
afterAll(() => setEmbeddingsEnabled(true));

const maybe = isEmbeddingsAvailable() ? describe : describe.skip;

maybe('Bot personalities (softmax sampling)', () => {
  it('BOT_PERSONALITIES has multiple distinct presets', () => {
    expect(BOT_PERSONALITIES.length).toBeGreaterThanOrEqual(3);
    const labels = new Set(BOT_PERSONALITIES.map(p => p.label));
    expect(labels.size).toBe(BOT_PERSONALITIES.length);
  });

  it('every added bot is given a personality', () => {
    const { room } = createRoom('PERS', 'Host', 4, POOL);
    addPlayer(room, 'P1');
    const b1 = addBot(room);
    const b2 = addBot(room);
    const bot1 = room.players.find(p => p.id === b1)!;
    const bot2 = room.players.find(p => p.id === b2)!;
    expect(bot1.personality).toBeDefined();
    expect(bot2.personality).toBeDefined();
    expect(bot1.personality!.submitTemp).toBeGreaterThan(0);
  });

  it('a chaotic-temp bot picks the argmax LESS often than a careful-temp bot on the same hand', async () => {
    // We construct an identical scoring scenario for two bots with very
    // different temperatures and verify the chaotic one diverges more.
    const careful = BOT_PERSONALITIES.find(p => p.label === 'careful')!;
    const chaotic = BOT_PERSONALITIES.find(p => p.label === 'chaotic')!;

    function countTopPicks(temp: number, trials: number): number {
      // We don't actually need the room/game machinery here — we exercise
      // the same softmax used internally. A spread of CLIP-like scores:
      const items = [
        { id: 'top',  score: 0.260 },
        { id: 'mid1', score: 0.240 },
        { id: 'mid2', score: 0.235 },
        { id: 'low1', score: 0.215 },
        { id: 'low2', score: 0.200 },
      ];
      let topHits = 0;
      // Inline duplicate of softmax sampler so we can call it 1000x without
      // touching the async game pipeline.
      const max = Math.max(...items.map(i => i.score));
      const weights = items.map(i => Math.exp((i.score - max) / Math.max(temp, 1e-6)));
      const sum = weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < trials; i++) {
        let r = Math.random() * sum;
        for (let j = 0; j < items.length; j++) {
          r -= weights[j];
          if (r <= 0) { if (items[j].id === 'top') topHits++; break; }
        }
      }
      return topHits;
    }

    const TRIALS = 2000;
    const carefulTop = countTopPicks(careful.submitTemp, TRIALS);
    const chaoticTop = countTopPicks(chaotic.submitTemp, TRIALS);
    // Careful is near-argmax → should hit 'top' overwhelmingly.
    expect(carefulTop / TRIALS).toBeGreaterThan(0.95);
    // Chaotic should be noticeably more spread out.
    expect(chaoticTop / TRIALS).toBeLessThan(carefulTop / TRIALS - 0.1);
  });

  it('two bots with the same clue often disagree on which card to submit', async () => {
    const { room } = createRoom('DIFF', 'Host', 4, POOL);
    addPlayer(room, 'P1');
    const b1 = addBot(room);
    const b2 = addBot(room);
    for (const p of room.players) p.connected = true;
    startGame(room, POOL);
    // Force human host as storyteller, give a vague clue, hand both bots
    // the same set of cards, and check that across many trials they pick
    // different cards at least sometimes.
    room.storytellerIdx = 0;
    const st = room.players[0];
    submitClue(room, st.id, st.hand[0], 'mystery');

    const bot1 = room.players.find(p => p.id === b1)!;
    const bot2 = room.players.find(p => p.id === b2)!;
    // Force same playful temp on both to isolate randomness as the driver.
    const playful = BOT_PERSONALITIES.find(p => p.label === 'playful')!;
    bot1.personality = playful;
    bot2.personality = playful;
    const sharedHand = ['card-001', 'card-002', 'card-003', 'card-004', 'card-005', 'card-006'];

    let disagreements = 0;
    const trials = 12;
    for (let i = 0; i < trials; i++) {
      bot1.hand = [...sharedHand];
      bot2.hand = [...sharedHand];
      room.submissions.delete(b1);
      room.submissions.delete(b2);
      bot1.hasSubmitted = false;
      bot2.hasSubmitted = false;
      // submitCard mutates phase when all submitted — reset back.
      room.phase = 'SUBMIT';
      await doBotSubmit(room, b1);
      await doBotSubmit(room, b2);
      if (room.submissions.get(b1) !== room.submissions.get(b2)) disagreements++;
    }
    // With a 'playful' temp (0.025) and 6 candidates we expect at least
    // some disagreement. This is statistical: allow a low bar to avoid
    // flakiness — pre-personality code disagreed 0% of the time.
    expect(disagreements).toBeGreaterThan(0);
  }, 20000);
});

