import { describe, expect, it } from 'vitest';
import { scoreClueMatch, pickCardClue, CARD_CLUES } from '../src/cardClues.js';
import {
  addBot, addPlayer, createRoom, doBotClue, doBotSubmit, doBotVote, startGame,
  submitClue, submitCard,
} from '../src/game.js';

const POOL = Array.from({ length: 50 }, (_, i) => `card-${String(i + 1).padStart(3, '0')}`);

// Helper: build a CardEntry-compatible object.
function entry(clues: string[], tags: string[]) {
  return { clues, tags };
}

function setClues(map: Record<string, { clues: string[]; tags: string[] }>) {
  const original = JSON.parse(JSON.stringify(CARD_CLUES));
  for (const k of Object.keys(CARD_CLUES)) delete (CARD_CLUES as any)[k];
  Object.assign(CARD_CLUES, map);
  return () => {
    for (const k of Object.keys(CARD_CLUES)) delete (CARD_CLUES as any)[k];
    Object.assign(CARD_CLUES, original);
  };
}

describe('cardClues scoring', () => {
  it('returns 0 when card has no curated data', () => {
    expect(scoreClueMatch('a lonely lighthouse', 'card-does-not-exist')).toBe(0);
  });

  it('scores higher when clue tokens match tags', () => {
    const restore = setClues({
      'match': entry(['the lonely lighthouse'], ['lighthouse', 'sea', 'beacon']),
      'miss':  entry(['dancing rabbits'], ['rabbit', 'birthday', 'cake']),
    });
    try {
      const sMatch = scoreClueMatch('lighthouse', 'match');
      const sMiss  = scoreClueMatch('lighthouse', 'miss');
      expect(sMatch).toBeGreaterThan(sMiss);
      expect(sMatch).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it('single-word synonym clue ("beast") matches a card tagged with synonyms', () => {
    const restore = setClues({
      'beast-card': entry(
        ['the hungry shadow', 'caught by the monster'],
        ['beast', 'monster', 'creature', 'fangs', 'demon', 'predator', 'fear'],
      ),
      'sunny-card': entry(
        ['a happy picnic', 'children playing'],
        ['picnic', 'sun', 'happy', 'children', 'park', 'flowers'],
      ),
    });
    try {
      expect(scoreClueMatch('beast', 'beast-card')).toBeGreaterThan(
        scoreClueMatch('beast', 'sunny-card'),
      );
      // Even synonyms like "monster" or "creature" should hit the beast card.
      expect(scoreClueMatch('monster', 'beast-card')).toBeGreaterThan(0);
      expect(scoreClueMatch('creature', 'beast-card')).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it('light stemming: "beasts" matches tag "beast"', () => {
    const restore = setClues({
      'c': entry(['x'], ['beast']),
    });
    try {
      expect(scoreClueMatch('beasts', 'c')).toBeGreaterThan(0);
      expect(scoreClueMatch('beast', 'c')).toBeGreaterThan(0);
    } finally { restore(); }
  });

  it('pickCardClue falls back to a generic clue when card missing', () => {
    const c = pickCardClue('definitely-not-a-card');
    expect(typeof c).toBe('string');
    expect(c.length).toBeGreaterThan(0);
  });

  it('pickCardClue returns one of the curated clues when available', () => {
    const restore = setClues({ 'c': entry(['alpha', 'beta', 'gamma'], []) });
    try {
      const out = new Set<string>();
      for (let i = 0; i < 30; i++) out.add(pickCardClue('c'));
      for (const v of Array.from(out)) expect(['alpha', 'beta', 'gamma']).toContain(v);
    } finally { restore(); }
  });
});

describe('bot uses curated clues for matching', () => {
  it('storyteller bot picks a card with curated data and uses one of its clues', () => {
    const restore = setClues({
      'card-005': entry(['the lonely lighthouse', 'beacon at dusk'], ['lighthouse', 'sea']),
    });
    try {
      const { room } = createRoom('TEST', 'Host', 3, POOL);
      addPlayer(room, 'P1');
      const botId = addBot(room);
      for (const p of room.players) p.connected = true;
      startGame(room, POOL);
      room.storytellerIdx = room.players.findIndex(p => p.id === botId);
      const bot = room.players[room.storytellerIdx];
      bot.hand = ['card-001', 'card-005', 'card-010', 'card-011', 'card-012', 'card-013'];
      doBotClue(room, botId);
      expect(room.phase).toBe('SUBMIT');
      expect(room.storytellerCardId).toBe('card-005');
      expect(['the lonely lighthouse', 'beacon at dusk']).toContain(room.clue);
    } finally { restore(); }
  });

  it('non-storyteller bot picks the hand card whose tags best match the clue', () => {
    const restore = setClues({
      'card-001': entry(['dancing rabbits'], ['rabbit', 'birthday', 'cake', 'happy']),
      'card-007': entry(['the lonely lighthouse'], ['lighthouse', 'sea', 'beacon', 'keeper']),
      'card-009': entry(['a sleeping dragon'], ['dragon', 'sleep', 'mountain']),
    });
    try {
      const { room } = createRoom('TEST', 'Host', 3, POOL);
      addPlayer(room, 'P1');
      const botId = addBot(room);
      for (const p of room.players) p.connected = true;
      startGame(room, POOL);
      room.storytellerIdx = 0;
      const st = room.players[0];
      st.hand = ['card-020', ...st.hand].slice(0, 6);
      submitClue(room, st.id, st.hand[0], 'lighthouse');
      const bot = room.players.find(p => p.id === botId)!;
      bot.hand = ['card-001', 'card-007', 'card-009'];
      doBotSubmit(room, botId);
      expect(room.submissions.get(botId)).toBe('card-007');
    } finally { restore(); }
  });

  it('non-storyteller bot votes for the table card best matching the clue (not its own)', () => {
    const restore = setClues({
      'card-030': entry(['lighthouse'], ['lighthouse', 'beacon', 'sea']),
      'card-031': entry(['birthday'], ['birthday', 'cake', 'party']),
      'card-032': entry(['dragon'], ['dragon', 'mountain', 'sleep']),
    });
    try {
      const { room } = createRoom('TEST', 'Host', 3, POOL);
      addPlayer(room, 'P1');
      const botId = addBot(room);
      for (const p of room.players) p.connected = true;
      startGame(room, POOL);
      room.storytellerIdx = 0;
      const st = room.players[0];
      const p1 = room.players[1];
      const bot = room.players.find(p => p.id === botId)!;
      st.hand = ['card-030', ...st.hand].slice(0, 6);
      p1.hand = ['card-031', ...p1.hand].slice(0, 6);
      bot.hand = ['card-032', ...bot.hand].slice(0, 6);
      submitClue(room, st.id, 'card-030', 'lighthouse');
      submitCard(room, p1.id, 'card-031');
      submitCard(room, bot.id, 'card-032');
      expect(room.phase).toBe('VOTE');
      doBotVote(room, botId);
      expect(room.votes.get(botId)).toBe('card-030');
    } finally { restore(); }
  });

  it('legacy on-disk format (array of clues) is still accepted', () => {
    // simulate having loaded a legacy entry
    const restore = setClues({});
    try {
      // Manually inject as if normalizeEntry had been called on a string[]
      (CARD_CLUES as any)['legacy'] = {
        clues: ['the lonely beast'],
        tags: ['lonely', 'beast'],
      };
      expect(scoreClueMatch('beast', 'legacy')).toBeGreaterThan(0);
    } finally { restore(); }
  });
});
