import { describe, expect, it } from 'vitest';
import { scoreClueMatch, pickCardClue, CARD_CLUES } from '../src/cardClues.js';
import {
  addBot, addPlayer, createRoom, doBotClue, doBotSubmit, doBotVote, startGame,
  submitClue, submitCard,
} from '../src/game.js';

const POOL = Array.from({ length: 50 }, (_, i) => `card-${String(i + 1).padStart(3, '0')}`);

describe('cardClues scoring', () => {
  it('returns 0 when card has no curated clues', () => {
    expect(scoreClueMatch('a lonely lighthouse', 'card-does-not-exist')).toBe(0);
  });

  it('scores higher when clue tokens overlap curated clues', () => {
    // Stub the module-level map for deterministic test
    const original = { ...CARD_CLUES };
    try {
      (CARD_CLUES as any)['t-match'] = ['a lonely lighthouse', 'the keeper of the sea'];
      (CARD_CLUES as any)['t-miss']  = ['dancing rabbits', 'birthday surprise'];
      const sMatch = scoreClueMatch('the lighthouse stands alone', 't-match');
      const sMiss  = scoreClueMatch('the lighthouse stands alone', 't-miss');
      expect(sMatch).toBeGreaterThan(sMiss);
      expect(sMatch).toBeGreaterThan(0);
    } finally {
      for (const k of Object.keys(CARD_CLUES)) delete (CARD_CLUES as any)[k];
      Object.assign(CARD_CLUES, original);
    }
  });

  it('pickCardClue falls back to a generic clue when card missing', () => {
    const c = pickCardClue('definitely-not-a-card');
    expect(typeof c).toBe('string');
    expect(c.length).toBeGreaterThan(0);
  });

  it('pickCardClue returns one of the curated clues when available', () => {
    const original = { ...CARD_CLUES };
    try {
      (CARD_CLUES as any)['t-card'] = ['alpha', 'beta', 'gamma'];
      const out = new Set<string>();
      for (let i = 0; i < 30; i++) out.add(pickCardClue('t-card'));
      for (const v of Array.from(out)) expect(['alpha', 'beta', 'gamma']).toContain(v);
    } finally {
      for (const k of Object.keys(CARD_CLUES)) delete (CARD_CLUES as any)[k];
      Object.assign(CARD_CLUES, original);
    }
  });
});

describe('bot uses curated clues for matching', () => {
  function setClues(map: Record<string, string[]>) {
    const original = { ...CARD_CLUES };
    for (const k of Object.keys(CARD_CLUES)) delete (CARD_CLUES as any)[k];
    Object.assign(CARD_CLUES, map);
    return () => {
      for (const k of Object.keys(CARD_CLUES)) delete (CARD_CLUES as any)[k];
      Object.assign(CARD_CLUES, original);
    };
  }

  it('storyteller bot picks a card with curated clues and uses one of them', () => {
    const restore = setClues({ 'card-005': ['the lonely lighthouse', 'beacon at dusk'] });
    try {
      const { room } = createRoom('TEST', 'Host', 3, POOL);
      addPlayer(room, 'P1');
      const botId = addBot(room);
      for (const p of room.players) p.connected = true;
      startGame(room, POOL);
      // Force the bot to be storyteller with a known hand including the curated card.
      room.storytellerIdx = room.players.findIndex(p => p.id === botId);
      const bot = room.players[room.storytellerIdx];
      bot.hand = ['card-001', 'card-005', 'card-010', 'card-011', 'card-012', 'card-013'];
      doBotClue(room, botId);
      expect(room.phase).toBe('SUBMIT');
      expect(room.storytellerCardId).toBe('card-005');
      expect(['the lonely lighthouse', 'beacon at dusk']).toContain(room.clue);
    } finally { restore(); }
  });

  it('non-storyteller bot picks the hand card whose clues best match the clue', () => {
    const restore = setClues({
      'card-001': ['dancing rabbits', 'birthday surprise'],
      'card-007': ['the lonely lighthouse', 'beacon at dusk', 'keeper of the sea'],
      'card-009': ['a sleeping dragon'],
    });
    try {
      const { room } = createRoom('TEST', 'Host', 3, POOL);
      addPlayer(room, 'P1');
      const botId = addBot(room);
      for (const p of room.players) p.connected = true;
      startGame(room, POOL);
      // Make the human storyteller (idx 0). Give the bot a controlled hand.
      room.storytellerIdx = 0;
      const st = room.players[0];
      // storyteller submits clue with the lighthouse theme
      st.hand = ['card-020', ...st.hand].slice(0, 6);
      submitClue(room, st.id, st.hand[0], 'the lighthouse keeper watches the storm');
      const bot = room.players.find(p => p.id === botId)!;
      bot.hand = ['card-001', 'card-007', 'card-009'];
      doBotSubmit(room, botId);
      expect(room.submissions.get(botId)).toBe('card-007');
    } finally { restore(); }
  });

  it('non-storyteller bot votes for the table card best matching the clue (not its own)', () => {
    const restore = setClues({
      'card-030': ['the lonely lighthouse', 'beacon at dusk'],
      'card-031': ['birthday surprise'],
      'card-032': ['a sleeping dragon'],
    });
    try {
      const { room } = createRoom('TEST', 'Host', 3, POOL);
      addPlayer(room, 'P1');
      const botId = addBot(room);
      for (const p of room.players) p.connected = true;
      startGame(room, POOL);
      // human storyteller gives lighthouse clue
      room.storytellerIdx = 0;
      const st = room.players[0];
      const p1 = room.players[1];
      const bot = room.players.find(p => p.id === botId)!;
      st.hand = ['card-030', ...st.hand].slice(0, 6);
      p1.hand = ['card-031', ...p1.hand].slice(0, 6);
      bot.hand = ['card-032', ...bot.hand].slice(0, 6);
      submitClue(room, st.id, 'card-030', 'lonely lighthouse keeper');
      submitCard(room, p1.id, 'card-031');
      submitCard(room, bot.id, 'card-032');
      expect(room.phase).toBe('VOTE');
      doBotVote(room, botId);
      // Bot owns card-032 so cannot vote for it; should prefer card-030 (lighthouse)
      // over card-031 (birthday).
      expect(room.votes.get(botId)).toBe('card-030');
    } finally { restore(); }
  });
});









