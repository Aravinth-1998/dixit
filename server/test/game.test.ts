/**
 * Comprehensive unit tests for the Dixit game engine (game.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  addBot,
  addPlayer,
  createRoom,
  createDeck,
  doBotClue,
  doBotSubmit,
  doBotVote,
  expireClue,
  expireSubmit,
  expireVote,
  isBanned,
  kickPlayer,
  newMatch,
  nextRound,
  privateState,
  promoteHostIfNeeded,
  publicState,
  Room,
  setTimers,
  startGame,
  submitCard,
  submitClue,
  submitVote,
} from '../src/game.js';
import {
  DEFAULT_WIN_SCORE,
  HAND_SIZE,
  MAX_PHASE_SEC,
  MIN_PLAYERS,
  MIN_WIN_SCORE,
} from '../../shared/src/types.js';

const CARD_POOL = Array.from({ length: 200 }, (_, i) => `card-${String(i + 1).padStart(3, '0')}`);

function mkRoom(numPlayers = 4, winScore = 10): { room: Room; tokens: string[] } {
  const { room, hostToken } = createRoom('TEST', 'Host', numPlayers, CARD_POOL, winScore);
  const tokens = [hostToken];
  for (let i = 1; i < numPlayers; i++) tokens.push(addPlayer(room, `P${i}`));
  for (const p of room.players) p.connected = true;
  return { room, tokens };
}
function startedRoom(numPlayers = 4, winScore = 10) {
  const r = mkRoom(numPlayers, winScore);
  startGame(r.room, CARD_POOL);
  return r;
}

function playRound(room: Room, opts: { correctVoters?: number[] } = {}) {
  const stIdx = room.storytellerIdx;
  const st = room.players[stIdx];
  submitClue(room, st.id, st.hand[0], 'a clue');
  for (let i = 0; i < room.players.length; i++) {
    if (i === stIdx) continue;
    const p = room.players[i];
    submitCard(room, p.id, p.hand[0]);
  }
  expect(room.phase).toBe('VOTE');
  const stCard = room.storytellerCardId!;
  for (let i = 0; i < room.players.length; i++) {
    if (i === stIdx) continue;
    const p = room.players[i];
    const myCard = room.submissions.get(p.id)!;
    const correct = opts.correctVoters?.includes(i) ?? false;
    const vote = correct
      ? stCard
      : (room.tableOrder.find(c => c !== stCard && c !== myCard) ?? room.tableOrder.find(c => c !== myCard)!);
    submitVote(room, p.id, vote);
  }
  expect(room.phase).toBe('REVEAL');
}

describe('createRoom', () => {
  it('rejects too few players', () => {
    expect(() => createRoom('A', 'h', MIN_PLAYERS - 1, CARD_POOL)).toThrow();
  });
  it('rejects bad win score', () => {
    expect(() => createRoom('A', 'h', 3, CARD_POOL, 0)).toThrow();
    expect(() => createRoom('A', 'h', 3, CARD_POOL, 9999)).toThrow();
    expect(() => createRoom('A', 'h', 3, CARD_POOL, NaN)).toThrow();
  });
  it('creates a valid lobby with the host', () => {
    const { room, hostToken } = createRoom('A', 'Aravinth', 4, CARD_POOL);
    expect(room.code).toBe('A');
    expect(room.phase).toBe('LOBBY');
    expect(room.players).toHaveLength(1);
    expect(room.players[0].isHost).toBe(true);
    expect(room.players[0].id).toBe(hostToken);
    expect(room.winScore).toBe(DEFAULT_WIN_SCORE);
    expect(room.bannedTokens).toEqual([]);
    expect(room.history).toEqual([]);
  });
  it('applies initial timers if provided', () => {
    const { room } = createRoom('A', 'h', 3, CARD_POOL, 10, { clueSec: 30, submitSec: 60, voteSec: 45 });
    expect(room.timers).toEqual({ clueSec: 30, submitSec: 60, voteSec: 45 });
  });
});

describe('addPlayer', () => {
  it('rejects duplicate names case-insensitively', () => {
    const { room } = createRoom('A', 'Aravinth', 4, CARD_POOL);
    expect(() => addPlayer(room, 'ARAVINTH')).toThrow(/already taken/);
  });
  it('rejects empty names', () => {
    const { room } = createRoom('A', 'h', 4, CARD_POOL);
    expect(() => addPlayer(room, '   ')).toThrow(/required/);
  });
  it('rejects beyond maxPlayers', () => {
    const { room } = createRoom('A', 'h', 3, CARD_POOL);
    addPlayer(room, 'b');
    addPlayer(room, 'c');
    expect(() => addPlayer(room, 'd')).toThrow(/full/);
  });
  it('rejects after game has started', () => {
    const { room } = startedRoom(3);
    expect(() => addPlayer(room, 'late')).toThrow(/already started/);
  });
});

describe('setTimers', () => {
  it('clamps negative and excessive values', () => {
    const { room } = mkRoom();
    setTimers(room, { clueSec: -5, submitSec: 99999, voteSec: 45 });
    expect(room.timers.clueSec).toBe(0);
    expect(room.timers.submitSec).toBe(MAX_PHASE_SEC);
    expect(room.timers.voteSec).toBe(45);
  });
  it('rejects changes outside lobby', () => {
    const { room } = startedRoom(3);
    expect(() => setTimers(room, { clueSec: 10 })).toThrow();
  });
});

describe('startGame', () => {
  it('deals 6 cards to each player and enters CLUE', () => {
    const { room } = startedRoom(4);
    expect(room.phase).toBe('CLUE');
    expect(room.roundNumber).toBe(1);
    for (const p of room.players) expect(p.hand).toHaveLength(HAND_SIZE);
  });
  it('refuses to start unless full', () => {
    const { room } = mkRoom(4);
    room.players.pop();
    expect(() => startGame(room, CARD_POOL)).toThrow(/Waiting for all players/);
  });
  it('refuses to start with anyone disconnected', () => {
    const { room } = mkRoom(3);
    room.players[1].connected = false;
    expect(() => startGame(room, CARD_POOL)).toThrow(/reconnect/);
  });
});

describe('submitClue', () => {
  it('rejects non-storyteller', () => {
    const { room } = startedRoom(3);
    const nonSt = (room.storytellerIdx + 1) % 3;
    const p = room.players[nonSt];
    expect(() => submitClue(room, p.id, p.hand[0], 'x')).toThrow(/storyteller/);
  });
  it('rejects card not in hand', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    expect(() => submitClue(room, st.id, 'card-999', 'x')).toThrow(/not in hand/);
  });
  it('rejects empty clue', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    expect(() => submitClue(room, st.id, st.hand[0], '   ')).toThrow(/required/);
  });
  it('advances to SUBMIT', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'mysterious');
    expect(room.phase).toBe('SUBMIT');
    expect(room.clue).toBe('mysterious');
  });
  it('is idempotent on duplicate of same card', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    const card = st.hand[0];
    submitClue(room, st.id, card, 'x');
    expect(() => submitClue(room, st.id, card, 'x')).not.toThrow();
  });
});

describe('submitCard', () => {
  it('rejects storyteller resubmit', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    expect(() => submitCard(room, st.id, st.hand[0])).toThrow(/already submitted/);
  });
  it('is idempotent on same card', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const other = room.players.find((_, i) => i !== room.storytellerIdx)!;
    const card = other.hand[0];
    submitCard(room, other.id, card);
    expect(() => submitCard(room, other.id, card)).not.toThrow();
  });
  it('rejects different card after first submission', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const other = room.players.find((_, i) => i !== room.storytellerIdx)!;
    const firstCard = other.hand[0];
    const secondCard = other.hand[1];
    submitCard(room, other.id, firstCard);
    expect(() => submitCard(room, other.id, secondCard)).toThrow(/Already submitted/);
  });
  it('transitions to VOTE when last player submits', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    for (let i = 0; i < room.players.length; i++) {
      if (i === room.storytellerIdx) continue;
      const p = room.players[i];
      submitCard(room, p.id, p.hand[0]);
    }
    expect(room.phase).toBe('VOTE');
    expect(room.tableOrder).toHaveLength(3);
  });
});

describe('submitVote', () => {
  it('rejects voting for own card', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const others = room.players.filter((_, i) => i !== room.storytellerIdx);
    for (const o of others) submitCard(room, o.id, o.hand[0]);
    const p = others[0];
    const myCard = room.submissions.get(p.id)!;
    expect(() => submitVote(room, p.id, myCard)).toThrow(/own card/);
  });
  it('rejects storyteller voting', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const others = room.players.filter((_, i) => i !== room.storytellerIdx);
    for (const o of others) submitCard(room, o.id, o.hand[0]);
    expect(() => submitVote(room, st.id, room.tableOrder[0])).toThrow(/cannot vote/);
  });
  it('is idempotent on same vote', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const others = room.players.filter((_, i) => i !== room.storytellerIdx);
    for (const o of others) submitCard(room, o.id, o.hand[0]);
    const p = others[0];
    const myCard = room.submissions.get(p.id)!;
    const vote = room.tableOrder.find(c => c !== myCard)!;
    submitVote(room, p.id, vote);
    expect(() => submitVote(room, p.id, vote)).not.toThrow();
  });
});

describe('Scoring (official Dixit rules)', () => {
  it('all correct → storyteller 0, others +2', () => {
    const { room } = startedRoom(4);
    const stIdx = room.storytellerIdx;
    const nonSt = [0, 1, 2, 3].filter(i => i !== stIdx);
    playRound(room, { correctVoters: nonSt });
    expect(room.players[stIdx].score).toBe(0);
    for (const i of nonSt) expect(room.players[i].score).toBe(2);
  });
  it('none correct → storyteller 0, others +2 (+ decoy bonus)', () => {
    const { room } = startedRoom(4);
    const stIdx = room.storytellerIdx;
    playRound(room, { correctVoters: [] });
    expect(room.players[stIdx].score).toBe(0);
    let totalBonus = 0;
    for (let i = 0; i < 4; i++) {
      if (i === stIdx) continue;
      const p = room.players[i];
      expect(p.score).toBeGreaterThanOrEqual(2);
      totalBonus += p.score - 2;
    }
    expect(totalBonus).toBe(3);
  });
  it('some correct → storyteller +3 and correct guessers +3', () => {
    const { room } = startedRoom(4);
    const stIdx = room.storytellerIdx;
    const others = [0, 1, 2, 3].filter(i => i !== stIdx);
    playRound(room, { correctVoters: [others[0]] });
    expect(room.players[stIdx].score).toBe(3);
    expect(room.players[others[0]].score).toBeGreaterThanOrEqual(3);
  });
  it('decoy bonus: +1 per vote on your decoy', () => {
    const { room } = startedRoom(3);
    const stIdx = room.storytellerIdx;
    const st = room.players[stIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const others = room.players.filter((_, i) => i !== stIdx);
    for (const o of others) submitCard(room, o.id, o.hand[0]);
    const [a, b] = others;
    const aDecoy = room.submissions.get(a.id)!;
    const bDecoy = room.submissions.get(b.id)!;
    submitVote(room, a.id, bDecoy);
    submitVote(room, b.id, aDecoy);
    expect(room.phase).toBe('REVEAL');
    expect(st.score).toBe(0);
    expect(a.score).toBe(3);
    expect(b.score).toBe(3);
  });
});

describe('nextRound', () => {
  it('rotates storyteller and increments round', () => {
    const { room } = startedRoom(3);
    const first = room.storytellerIdx;
    playRound(room, { correctVoters: [] });
    nextRound(room);
    expect(room.phase).toBe('CLUE');
    expect(room.storytellerIdx).toBe((first + 1) % 3);
    expect(room.roundNumber).toBe(2);
  });
  it('refills hands back to HAND_SIZE', () => {
    const { room } = startedRoom(3);
    playRound(room, { correctVoters: [] });
    nextRound(room);
    for (const p of room.players) expect(p.hand).toHaveLength(HAND_SIZE);
  });
  it('ends match when someone reaches winScore', () => {
    const { room } = startedRoom(3, 2);
    playRound(room, { correctVoters: [] });
    nextRound(room);
    expect(room.phase).toBe('GAME_OVER');
    expect(room.winnerIds.length).toBeGreaterThan(0);
  });
  it('records each completed round in history', () => {
    const { room } = startedRoom(3);
    playRound(room, { correctVoters: [] });
    expect(room.history).toHaveLength(1);
    expect(room.history[0].clue).toBe('a clue');
    expect(room.history[0].roundNumber).toBe(1);
  });
});

describe('newMatch', () => {
  it('resets scores/hands/history, same roster, starts immediately', () => {
    const { room } = startedRoom(3, 2);
    playRound(room, { correctVoters: [] });
    nextRound(room);
    expect(room.phase).toBe('GAME_OVER');
    const n = room.players.length;
    newMatch(room, CARD_POOL);
    expect(room.phase).toBe('CLUE');
    expect(room.players).toHaveLength(n);
    expect(room.history).toEqual([]);
    expect(room.players.every(p => p.score === 0)).toBe(true);
    expect(room.players.every(p => p.hand.length === HAND_SIZE)).toBe(true);
  });
});

describe('Ban / rejoin', () => {
  it('isBanned reflects bannedTokens', () => {
    const { room, tokens } = mkRoom(3);
    expect(isBanned(room, tokens[1])).toBe(false);
    room.bannedTokens.push(tokens[1]);
    expect(isBanned(room, tokens[1])).toBe(true);
  });
});

describe('promoteHostIfNeeded', () => {
  it('promotes next connected player if host is disconnected', () => {
    const { room } = mkRoom(3);
    room.players[0].connected = false;
    room.players[0].isHost = false;
    const changed = promoteHostIfNeeded(room);
    expect(changed).toBe(true);
    expect(room.players[1].isHost).toBe(true);
  });
  it('no-op if current host is still connected', () => {
    const { room } = mkRoom(3);
    expect(promoteHostIfNeeded(room)).toBe(false);
    expect(room.players[0].isHost).toBe(true);
  });
});

describe('kickPlayer', () => {
  it('removes player and bans token in LOBBY', () => {
    const { room, tokens } = mkRoom(4);
    kickPlayer(room, tokens[2]);
    expect(room.players).toHaveLength(3);
    expect(isBanned(room, tokens[2])).toBe(true);
  });
  it('refuses to kick the host', () => {
    const { room, tokens } = mkRoom(3);
    expect(() => kickPlayer(room, tokens[0])).toThrow();
  });
  it('ends the match if mid-game kick drops below MIN_PLAYERS', () => {
    const { room, tokens } = startedRoom(3);
    const ix = (room.storytellerIdx + 1) % 3;
    const result = kickPlayer(room, tokens[ix]);
    expect(result).toBe('matchOver');
    expect(room.phase).toBe('GAME_OVER');
  });
  it('restarts the round if storyteller is kicked mid-CLUE', () => {
    // Make host = players[1] so we can kick players[0] (the storyteller).
    const { room, tokens } = startedRoom(4);
    room.players[0].isHost = false;
    room.players[1].isHost = true;
    const stIdx = room.storytellerIdx;
    expect(stIdx).toBe(0); // sanity
    const result = kickPlayer(room, tokens[stIdx]);
    expect(result).toBe('roundReset');
    expect(room.phase).toBe('CLUE');
    expect(room.players).toHaveLength(3);
  });

  it('returns submitted cards to non-storytellers when storyteller is kicked mid-SUBMIT', () => {
    // Reproduces a bug where cards already played in the abandoned round
    // were silently discarded instead of being returned to the player's hand.
    const { room, tokens } = startedRoom(4);
    room.players[0].isHost = false;
    room.players[1].isHost = true;
    const stIdx = room.storytellerIdx;
    const st = room.players[stIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    // Two non-storytellers submit cards (the third doesn't).
    const others = room.players.filter((_, i) => i !== stIdx);
    const o0Card = others[0].hand[0];
    const o1Card = others[1].hand[0];
    submitCard(room, others[0].id, o0Card);
    submitCard(room, others[1].id, o1Card);
    expect(others[0].hand).not.toContain(o0Card);
    expect(others[1].hand).not.toContain(o1Card);

    kickPlayer(room, tokens[stIdx]);

    // After kick → round restarts. Their submitted cards must be back.
    expect(others[0].hand).toContain(o0Card);
    expect(others[1].hand).toContain(o1Card);
    expect(others[0].hand).toHaveLength(6);
    expect(others[1].hand).toHaveLength(6);
  });

  it('does not corrupt REVEAL when the storyteller is kicked after the round resolves', () => {
    // Play one full round to enter REVEAL with score deltas already applied.
    const { room, tokens } = startedRoom(4);
    room.players[0].isHost = false;
    room.players[1].isHost = true;
    const stIdx = room.storytellerIdx;
    playRound(room, { correctVoters: [] });
    expect(room.phase).toBe('REVEAL');
    const scoresBefore = room.players.map(p => ({ id: p.id, score: p.score }));
    const historyLenBefore = room.history.length;

    kickPlayer(room, tokens[stIdx]);

    // History and scores of *remaining* players must be preserved.
    expect(room.history).toHaveLength(historyLenBefore);
    for (const p of room.players) {
      const before = scoresBefore.find(s => s.id === p.id)!;
      expect(p.score).toBe(before.score);
    }
    // The next phase should be a fresh CLUE for the next storyteller,
    // not stuck somewhere weird.
    expect(['CLUE', 'REVEAL']).toContain(room.phase);
  });
  it('re-checks SUBMIT completion when the missing player is the kicked one', () => {
    const { room } = startedRoom(4);
    const stIdx = room.storytellerIdx;
    const st = room.players[stIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const others = room.players.filter((_, i) => i !== stIdx);
    submitCard(room, others[0].id, others[0].hand[0]);
    submitCard(room, others[1].id, others[1].hand[0]);
    expect(room.phase).toBe('SUBMIT');
    kickPlayer(room, others[2].id);
    expect(room.phase).toBe('VOTE');
  });
});

describe('Auto-expire (phase timer fires)', () => {
  it('expireClue auto-picks a random storyteller card', () => {
    const { room } = startedRoom(3);
    expireClue(room);
    expect(room.phase).toBe('SUBMIT');
    // Clue is now picked from the card's curated clues (or a generic
    // fallback if the card has no entry yet); just verify it's non-empty.
    expect(typeof room.clue).toBe('string');
    expect((room.clue ?? '').length).toBeGreaterThan(0);
    expect(room.storytellerCardId).toBeTruthy();
  });
  it('expireSubmit auto-submits remaining players', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    expireSubmit(room);
    expect(room.phase).toBe('VOTE');
    expect(room.submissions.size).toBe(3);
  });
  it('expireVote never votes for own card', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const others = room.players.filter((_, i) => i !== room.storytellerIdx);
    for (const o of others) submitCard(room, o.id, o.hand[0]);
    expireVote(room);
    expect(room.phase).toBe('REVEAL');
    for (const o of others) {
      expect(room.votes.get(o.id)).not.toBe(room.submissions.get(o.id));
    }
  });
});

describe('View projections', () => {
  it('publicState hides ownerId in VOTE and reveals in REVEAL', () => {
    const { room } = startedRoom(3);
    const st = room.players[room.storytellerIdx];
    submitClue(room, st.id, st.hand[0], 'x');
    const others = room.players.filter((_, i) => i !== room.storytellerIdx);
    for (const o of others) submitCard(room, o.id, o.hand[0]);
    let pub = publicState(room);
    expect(pub.phase).toBe('VOTE');
    for (const tc of pub.table) expect((tc as any).ownerId).toBeUndefined();
    for (const o of others) {
      const myCard = room.submissions.get(o.id)!;
      const vote = room.tableOrder.find(c => c !== myCard)!;
      submitVote(room, o.id, vote);
    }
    pub = publicState(room);
    expect(pub.phase).toBe('REVEAL');
    for (const tc of pub.table) expect((tc as any).ownerId).toBeTruthy();
  });
  it('privateState exposes only "you.hand"', () => {
    const { room } = startedRoom(3);
    const me = room.players[1];
    const view = privateState(room, me.id);
    expect(view.you.id).toBe(me.id);
    expect(view.you.hand).toEqual(me.hand);
    expect((view.players[0] as any).hand).toBeUndefined();
  });
});

describe('createDeck', () => {
  it('returns subset sized to numPlayers * 18', () => {
    const d = createDeck(CARD_POOL, 4);
    expect(d).toHaveLength(72);
    expect(new Set(d).size).toBe(d.length);
  });
  it('returns the full pool when numPlayers omitted', () => {
    expect(createDeck(CARD_POOL)).toHaveLength(CARD_POOL.length);
  });
});

describe('Win-score floor', () => {
  it('MIN_WIN_SCORE accepted', () => {
    const { room } = createRoom('A', 'h', 3, CARD_POOL, MIN_WIN_SCORE);
    expect(room.winScore).toBe(MIN_WIN_SCORE);
  });
});

describe('Ties at game end', () => {
  it('multiple players hitting winScore simultaneously all win', () => {
    const { room } = startedRoom(3, 2);
    // "all correct" gives every non-storyteller +2 → both hit 2.
    const stIdx = room.storytellerIdx;
    const others = [0, 1, 2].filter(i => i !== stIdx);
    playRound(room, { correctVoters: others });
    nextRound(room);
    expect(room.phase).toBe('GAME_OVER');
    expect(room.winnerIds.length).toBe(2);
  });
});

describe('Deck exhaustion', () => {
  it('ends match once someone is fully out of cards (engine plays down to 0)', () => {
    // Small pool: 3 players × 6 starting hand = 18 → deck=0 after deal.
    const tinyPool = Array.from({ length: 18 }, (_, i) => `c-${i}`);
    const { room } = createRoom('X', 'h', 3, tinyPool, 30);
    addPlayer(room, 'b');
    addPlayer(room, 'c');
    for (const p of room.players) p.connected = true;
    startGame(room, tinyPool);
    expect(room.deck.length).toBe(0);
    // Play rounds until GAME_OVER (or fail safety cap).
    for (let i = 0; i < 12 && room.phase !== 'GAME_OVER'; i++) {
      playRound(room, { correctVoters: [] });
      nextRound(room);
    }
    expect(room.phase).toBe('GAME_OVER');
  });
});

describe('Bots', () => {
  it('addBot adds a connected bot player in lobby', () => {
    // 4-seat lobby, fill 3 humans then add a bot in the 4th seat.
    const { room } = createRoom('B', 'h', 4, CARD_POOL);
    addPlayer(room, 'p2');
    addPlayer(room, 'p3');
    const botId = addBot(room);
    const bot = room.players.find(p => p.id === botId)!;
    expect(bot.isBot).toBe(true);
    expect(bot.connected).toBe(true);
    expect(bot.socketId).toBeNull();
    expect(bot.name.length).toBeGreaterThan(0);
  });
  it('addBot refuses to exceed maxPlayers', () => {
    const { room } = mkRoom(3); // already full
    expect(() => addBot(room)).toThrow(/full/);
  });
  it('addBot refuses outside lobby', () => {
    const { room } = startedRoom(3);
    expect(() => addBot(room)).toThrow(/lobby/);
  });

  it('promoteHostIfNeeded prefers humans over bots', () => {
    // 3 players: [host (human), bot, human]. Host disconnects → expect the
    // human (index 2) to be promoted, not the bot (index 1).
    const { room } = mkRoom(3);
    room.players[1].isBot = true;
    room.players[0].connected = false;
    room.players[0].isHost = false;
    const changed = promoteHostIfNeeded(room);
    expect(changed).toBe(true);
    expect(room.players[2].isHost).toBe(true);
    expect(room.players[1].isHost).toBe(false);
  });

  it('doBotClue advances to SUBMIT with a non-empty clue', () => {
    const { room } = mkRoom(3);
    room.players[1].isBot = true;
    startGame(room, CARD_POOL);
    // Force the bot (index 1) to be the storyteller.
    room.storytellerIdx = 1;
    const bot = room.players[1];
    doBotClue(room, bot.id);
    expect(room.phase).toBe('SUBMIT');
    expect(room.clue).toBeTruthy();
    expect(room.storytellerCardId).toBeTruthy();
  });

  it('doBotVote never votes for own card', () => {
    const { room } = mkRoom(3);
    room.players[1].isBot = true;
    startGame(room, CARD_POOL);
    // Storyteller defaults to index 0 (the human host). Bot at 1, human at 2.
    const st = room.players[0];
    submitClue(room, st.id, st.hand[0], 'x');
    const bot = room.players[1];
    const human2 = room.players[2];
    doBotSubmit(room, bot.id);
    submitCard(room, human2.id, human2.hand[0]);
    expect(room.phase).toBe('VOTE');
    doBotVote(room, bot.id);
    const myCard = room.submissions.get(bot.id);
    expect(room.votes.get(bot.id)).not.toBe(myCard);
  });

  it('full bot-driven round completes and assigns sane scores', () => {
    const { room } = mkRoom(3);
    room.players[1].isBot = true;
    room.players[2].isBot = true;
    startGame(room, CARD_POOL);
    const human = room.players[0];
    submitClue(room, human.id, human.hand[0], 'a clue');
    for (const p of room.players) if (p.isBot) doBotSubmit(room, p.id);
    expect(room.phase).toBe('VOTE');
    for (const p of room.players) if (p.isBot) doBotVote(room, p.id);
    expect(room.phase).toBe('REVEAL');
    expect(room.history).toHaveLength(1);
    const totalDelta = Object.values(room.history[0].deltas).reduce((a, b) => a + b, 0);
    expect(totalDelta).toBeGreaterThanOrEqual(0);
  });

  it('bot kicked like any other player', () => {
    const { room } = createRoom('B', 'h', 4, CARD_POOL);
    addPlayer(room, 'p2');
    addPlayer(room, 'p3');
    const botId = addBot(room);
    const result = kickPlayer(room, botId);
    expect(result).toBe('removed');
    expect(room.players.find(p => p.id === botId)).toBeUndefined();
    expect(isBanned(room, botId)).toBe(true);
  });
});







