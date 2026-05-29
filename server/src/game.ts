import { randomUUID } from 'node:crypto';
import {
  HAND_SIZE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MIN_WIN_SCORE,
  MAX_WIN_SCORE,
  DEFAULT_WIN_SCORE,
  DEFAULT_TIMERS,
  MAX_PHASE_SEC,
  Phase,
  PrivateState,
  PublicPlayer,
  PublicState,
  RoundReveal,
  TimerConfig,
} from '../../shared/src/types.js';

export interface Player {
  id: string;            // playerToken
  socketId: string | null;
  name: string;
  hand: string[];
  score: number;
  isHost: boolean;
  connected: boolean;
  hasSubmitted: boolean;
  hasVoted: boolean;
}

export interface Room {
  code: string;
  maxPlayers: number;
  winScore: number;
  players: Player[];
  phase: Phase;
  deck: string[];
  storytellerIdx: number;
  clue: string | null;
  storytellerCardId: string | null;
  // submissions: by playerId -> cardId (includes storyteller's own card)
  submissions: Map<string, string>;
  // votes: voter playerId -> cardId voted for
  votes: Map<string, string>;
  // shuffled cards on the table during VOTE/REVEAL
  tableOrder: string[];
  reveal: RoundReveal | null;
  winnerIds: string[];
  roundNumber: number;
  lastActivity: number;
  /** Host-configured timers (seconds, 0 = off). */
  timers: TimerConfig;
  /** Epoch ms at which the current phase auto-advances; null = no timer. */
  phaseDeadline: number | null;
  /** Tokens (player.id) of kicked players — cannot rejoin. */
  bannedTokens: string[];
  /** Past reveals, oldest first. */
  history: RoundReveal[];
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// How many cards to actually use per match, per player. Hand of 6 + room to
// refill for several rounds. The match's deck is a *random subset* of the
// total card pool so different matches feel different even with the same
// physical cards on disk.
const DECK_PER_PLAYER = 18;

export function createDeck(allCardIds: string[], numPlayers?: number): string[] {
  const shuffled = shuffle(allCardIds);
  if (numPlayers && numPlayers > 0) {
    const size = Math.min(shuffled.length, numPlayers * DECK_PER_PLAYER);
    return shuffled.slice(0, size);
  }
  return shuffled;
}

export function createRoom(
  code: string,
  hostName: string,
  maxPlayers: number,
  allCardIds: string[],
  winScore: number = DEFAULT_WIN_SCORE,
  timers?: Partial<TimerConfig>,
): { room: Room; hostToken: string } {
  if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS) {
    throw new Error(`Player count must be ${MIN_PLAYERS}-${MAX_PLAYERS}`);
  }
  if (
    typeof winScore !== 'number' ||
    !Number.isFinite(winScore) ||
    winScore < MIN_WIN_SCORE ||
    winScore > MAX_WIN_SCORE
  ) {
    throw new Error(`Points to win must be ${MIN_WIN_SCORE}-${MAX_WIN_SCORE}`);
  }
  const hostToken = randomUUID();
  const room: Room = {
    code,
    maxPlayers,
    winScore: Math.floor(winScore),
    players: [
      {
        id: hostToken,
        socketId: null,
        name: hostName.trim().slice(0, 24),
        hand: [],
        score: 0,
        isHost: true,
        connected: true,
        hasSubmitted: false,
        hasVoted: false,
      },
    ],
    phase: 'LOBBY',
    deck: createDeck(allCardIds),
    storytellerIdx: 0,
    clue: null,
    storytellerCardId: null,
    submissions: new Map(),
    votes: new Map(),
    tableOrder: [],
    reveal: null,
    winnerIds: [],
    roundNumber: 0,
    lastActivity: Date.now(),
    timers: { ...DEFAULT_TIMERS },
    phaseDeadline: null,
    bannedTokens: [],
    history: [],
  };
  if (timers) setTimers(room, timers);
  return { room, hostToken };
}

export function addPlayer(room: Room, name: string): string {
  if (room.phase !== 'LOBBY') throw new Error('Game already started');
  if (room.players.length >= room.maxPlayers) throw new Error('Room is full');
  const cleanName = name.trim().slice(0, 24);
  if (!cleanName) throw new Error('Name is required');
  if (room.players.some(p => p.name.toLowerCase() === cleanName.toLowerCase()))
    throw new Error('Name already taken');
  const token = randomUUID();
  room.players.push({
    id: token,
    socketId: null,
    name: cleanName,
    hand: [],
    score: 0,
    isHost: false,
    connected: true,
    hasSubmitted: false,
    hasVoted: false,
  });
  return token;
}

export function isBanned(room: Room, token: string): boolean {
  return room.bannedTokens.includes(token);
}

function clampSec(n: any): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  const i = Math.floor(n);
  if (i <= 0) return 0;
  if (i > MAX_PHASE_SEC) return MAX_PHASE_SEC;
  return i;
}

export function setTimers(room: Room, t: Partial<TimerConfig>) {
  if (room.phase !== 'LOBBY') throw new Error('Timers can only change in lobby');
  room.timers = {
    clueSec: clampSec(t.clueSec ?? room.timers.clueSec),
    submitSec: clampSec(t.submitSec ?? room.timers.submitSec),
    voteSec: clampSec(t.voteSec ?? room.timers.voteSec),
  };
}

/**
 * Promote the first still-present, connected player to host if the current
 * host is missing or disconnected. Returns true if the host changed.
 */
export function promoteHostIfNeeded(room: Room): boolean {
  if (room.players.length === 0) return false;
  const currentHost = room.players.find(p => p.isHost);
  if (currentHost && currentHost.connected) return false;
  // Prefer first connected player; otherwise just the first player.
  const next =
    room.players.find(p => p.connected) ?? room.players[0];
  if (!next) return false;
  if (currentHost === next) return false;
  for (const p of room.players) p.isHost = false;
  next.isHost = true;
  return true;
}

/**
 * Remove a player from the room and ban their token from rejoining.
 * Handles all phases: in LOBBY just remove; mid-game also fixes up
 * storyteller / submissions / votes and may end the round or match.
 *
 * Returns one of: 'removed' | 'roundReset' | 'matchOver'
 */
export function kickPlayer(
  room: Room,
  playerId: string
): 'removed' | 'roundReset' | 'matchOver' {
  const idx = room.players.findIndex(p => p.id === playerId);
  if (idx === -1) throw new Error('Player not in room');
  const target = room.players[idx];
  if (target.isHost) throw new Error('Host cannot kick themselves');
  const wasStoryteller =
    room.phase !== 'LOBBY' &&
    room.phase !== 'GAME_OVER' &&
    room.players[room.storytellerIdx]?.id === playerId;

  // Remove from roster + ban token
  room.players.splice(idx, 1);
  if (!room.bannedTokens.includes(playerId)) room.bannedTokens.push(playerId);
  // Drop any state references to them
  room.submissions.delete(playerId);
  room.votes.delete(playerId);

  // LOBBY / GAME_OVER: nothing else to do
  if (room.phase === 'LOBBY' || room.phase === 'GAME_OVER') {
    promoteHostIfNeeded(room);
    return 'removed';
  }

  // Mid-game: if we no longer have enough players, end the match.
  if (room.players.length < MIN_PLAYERS) {
    const max = Math.max(0, ...room.players.map(p => p.score));
    room.winnerIds = room.players
      .filter(p => p.score === max && max > 0)
      .map(p => p.id);
    room.phase = 'GAME_OVER';
    room.phaseDeadline = null;
    promoteHostIfNeeded(room);
    return 'matchOver';
  }

  // Keep storytellerIdx pointing at a valid player
  if (wasStoryteller) {
    // Round can't continue without the storyteller — restart this round
    // with the next player as storyteller.
    if (room.storytellerIdx >= room.players.length) room.storytellerIdx = 0;
    // The deck/hands are kept; just begin a new clue phase.
    beginClue(room);
    promoteHostIfNeeded(room);
    return 'roundReset';
  } else {
    // If we removed someone before storytellerIdx, the index slid up by one.
    if (idx < room.storytellerIdx) room.storytellerIdx -= 1;
    if (room.storytellerIdx >= room.players.length) room.storytellerIdx = 0;
  }

  // If we were waiting on the kicked player to submit/vote, the phase may now
  // be complete. Re-check the transitions.
  if (room.phase === 'SUBMIT') {
    if (room.submissions.size === room.players.length) {
      room.tableOrder = shuffle([...room.submissions.values()]);
      room.phase = 'VOTE';
    }
  } else if (room.phase === 'VOTE') {
    const nonStorytellers = room.players.length - 1;
    if (room.votes.size === nonStorytellers) {
      computeReveal(room);
    }
  }

  promoteHostIfNeeded(room);
  return 'removed';
}

// ---------- Timer-expiry auto-actions ----------

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** CLUE expired: storyteller didn't act — pick a random card + filler clue. */
export function expireClue(room: Room): boolean {
  if (room.phase !== 'CLUE') return false;
  const st = room.players[room.storytellerIdx];
  if (!st || st.hand.length === 0) return false;
  const cardId = pickRandom(st.hand);
  submitClue(room, st.id, cardId, '…');
  return true;
}

/** SUBMIT expired: any non-submitter gets a random card from their hand. */
export function expireSubmit(room: Room): boolean {
  if (room.phase !== 'SUBMIT') return false;
  for (const p of room.players) {
    if (room.submissions.has(p.id)) continue;
    if (p.hand.length === 0) continue;
    try {
      submitCard(room, p.id, pickRandom(p.hand));
    } catch {
      /* ignore */
    }
  }
  return true;
}

/** VOTE expired: any non-voter votes for a random card that isn't theirs. */
export function expireVote(room: Room): boolean {
  if (room.phase !== 'VOTE') return false;
  const storyteller = room.players[room.storytellerIdx];
  for (const p of room.players) {
    if (p.id === storyteller?.id) continue;
    if (room.votes.has(p.id)) continue;
    const myCard = room.submissions.get(p.id);
    const choices = room.tableOrder.filter(c => c !== myCard);
    if (choices.length === 0) continue;
    try {
      submitVote(room, p.id, pickRandom(choices));
    } catch {
      /* ignore */
    }
  }
  return true;
}

export function startGame(room: Room, allCardIds: string[]) {
  if (room.phase !== 'LOBBY') throw new Error('Game already started');
  if (room.players.length !== room.maxPlayers)
    throw new Error('Waiting for all players to join');
  // Pick a fresh random subset of the full card pool for THIS match.
  room.deck = createDeck(allCardIds, room.players.length);
  for (const p of room.players) {
    p.hand = room.deck.splice(0, HAND_SIZE);
    p.score = 0;
  }
  room.storytellerIdx = 0;
  room.roundNumber = 1;
  room.winnerIds = [];
  beginClue(room);
}

function beginClue(room: Room) {
  room.phase = 'CLUE';
  room.clue = null;
  room.storytellerCardId = null;
  room.submissions.clear();
  room.votes.clear();
  room.tableOrder = [];
  room.reveal = null;
  room.phaseDeadline = null;
  for (const p of room.players) {
    p.hasSubmitted = false;
    p.hasVoted = false;
  }
}

export function submitClue(
  room: Room,
  playerId: string,
  cardId: string,
  clue: string
) {
  if (room.phase !== 'CLUE') throw new Error('Not clue phase');
  const storyteller = room.players[room.storytellerIdx];
  if (storyteller.id !== playerId) throw new Error('Only storyteller can give a clue');
  if (!storyteller.hand.includes(cardId)) throw new Error('Card not in hand');
  const cleanClue = clue.trim().slice(0, 120);
  if (!cleanClue) throw new Error('Clue is required');
  room.clue = cleanClue;
  room.storytellerCardId = cardId;
  room.submissions.set(storyteller.id, cardId);
  storyteller.hand = storyteller.hand.filter(c => c !== cardId);
  storyteller.hasSubmitted = true;
  room.phase = 'SUBMIT';
}

export function submitCard(room: Room, playerId: string, cardId: string) {
  if (room.phase !== 'SUBMIT') throw new Error('Not submit phase');
  const player = room.players.find(p => p.id === playerId);
  if (!player) throw new Error('Unknown player');
  const storyteller = room.players[room.storytellerIdx];
  if (player.id === storyteller.id) throw new Error('Storyteller already submitted');
  if (room.submissions.has(player.id)) throw new Error('Already submitted');
  if (!player.hand.includes(cardId)) throw new Error('Card not in hand');
  room.submissions.set(player.id, cardId);
  player.hand = player.hand.filter(c => c !== cardId);
  player.hasSubmitted = true;
  if (room.submissions.size === room.players.length) {
    // Move to VOTE: shuffle the cards on the table
    room.tableOrder = shuffle([...room.submissions.values()]);
    room.phase = 'VOTE';
  }
}

export function submitVote(room: Room, playerId: string, cardId: string) {
  if (room.phase !== 'VOTE') throw new Error('Not vote phase');
  const player = room.players.find(p => p.id === playerId);
  if (!player) throw new Error('Unknown player');
  const storyteller = room.players[room.storytellerIdx];
  if (player.id === storyteller.id) throw new Error('Storyteller cannot vote');
  if (room.votes.has(player.id)) throw new Error('Already voted');
  if (!room.tableOrder.includes(cardId)) throw new Error('Card not on table');
  // Can't vote for your own card
  if (room.submissions.get(player.id) === cardId)
    throw new Error('Cannot vote for your own card');
  room.votes.set(player.id, cardId);
  player.hasVoted = true;
  const nonStorytellers = room.players.length - 1;
  if (room.votes.size === nonStorytellers) {
    computeReveal(room);
  }
}

function computeReveal(room: Room) {
  const storyteller = room.players[room.storytellerIdx];
  const storytellerCardId = room.storytellerCardId!;
  const nonStorytellers = room.players.filter(p => p.id !== storyteller.id);

  // owner of each card on the table
  const ownerByCard = new Map<string, string>();
  for (const [pid, cid] of room.submissions.entries()) ownerByCard.set(cid, pid);

  // voters of each card
  const votersByCard = new Map<string, string[]>();
  for (const cid of room.tableOrder) votersByCard.set(cid, []);
  for (const [voter, cid] of room.votes.entries()) {
    votersByCard.get(cid)!.push(voter);
  }

  const correctVoters = votersByCard.get(storytellerCardId) ?? [];
  const allCorrect = correctVoters.length === nonStorytellers.length;
  const noneCorrect = correctVoters.length === 0;

  const deltas: Record<string, number> = {};
  for (const p of room.players) deltas[p.id] = 0;

  if (allCorrect || noneCorrect) {
    // storyteller scores 0; everyone else +2
    for (const p of nonStorytellers) deltas[p.id] += 2;
  } else {
    deltas[storyteller.id] += 3;
    for (const v of correctVoters) deltas[v] += 3;
  }
  // bonus: each non-storyteller earns +1 per vote on their card
  for (const p of nonStorytellers) {
    const myCard = room.submissions.get(p.id)!;
    const votes = votersByCard.get(myCard)?.length ?? 0;
    deltas[p.id] += votes;
  }

  for (const p of room.players) p.score += deltas[p.id];

  room.reveal = {
    storytellerId: storyteller.id,
    storytellerCardId,
    clue: room.clue!,
    cards: room.tableOrder.map(cid => ({
      cardId: cid,
      ownerId: ownerByCard.get(cid)!,
      voterIds: votersByCard.get(cid) ?? [],
    })),
    deltas,
    roundNumber: room.roundNumber,
  };
  room.history.push(room.reveal);
  room.phase = 'REVEAL';
  room.phaseDeadline = null;
}

export function nextRound(room: Room) {
  if (room.phase !== 'REVEAL') throw new Error('Not reveal phase');
  // check win
  const max = Math.max(...room.players.map(p => p.score));
  if (max >= room.winScore) {
    room.winnerIds = room.players.filter(p => p.score === max).map(p => p.id);
    room.phase = 'GAME_OVER';
    return;
  }
  // refill hands (1 card each, storyteller too — they already played one)
  for (const p of room.players) {
    while (p.hand.length < HAND_SIZE && room.deck.length > 0) {
      p.hand.push(room.deck.shift()!);
    }
  }
  // if deck is empty and someone has < HAND_SIZE, end game with current leader
  const tooFewCards = room.players.some(p => p.hand.length === 0);
  if (tooFewCards) {
    room.winnerIds = room.players
      .filter(p => p.score === max)
      .map(p => p.id);
    room.phase = 'GAME_OVER';
    return;
  }
  room.storytellerIdx = (room.storytellerIdx + 1) % room.players.length;
  room.roundNumber += 1;
  beginClue(room);
}

export function newMatch(room: Room, allCardIds: string[]) {
  if (room.phase !== 'GAME_OVER') throw new Error('Match is not over');
  room.phase = 'LOBBY';
  room.deck = [];
  room.storytellerIdx = 0;
  room.clue = null;
  room.storytellerCardId = null;
  room.submissions.clear();
  room.votes.clear();
  room.tableOrder = [];
  room.reveal = null;
  room.winnerIds = [];
  room.roundNumber = 0;
  room.phaseDeadline = null;
  room.history = [];
  for (const p of room.players) {
    p.hand = [];
    p.score = 0;
    p.hasSubmitted = false;
    p.hasVoted = false;
  }
  // immediately start since same roster
  startGame(room, allCardIds);
}

// ---------- View projections ----------

function publicPlayer(p: Player): PublicPlayer {
  return {
    id: p.id,
    name: p.name,
    score: p.score,
    isHost: p.isHost,
    connected: p.connected,
    hasSubmitted: p.hasSubmitted,
    hasVoted: p.hasVoted,
  };
}

export function publicState(room: Room): PublicState {
  const storyteller = room.players[room.storytellerIdx];
  return {
    code: room.code,
    phase: room.phase,
    maxPlayers: room.maxPlayers,
    winScore: room.winScore,
    players: room.players.map(publicPlayer),
    storytellerId:
      room.phase === 'LOBBY' || room.phase === 'GAME_OVER'
        ? null
        : storyteller?.id ?? null,
    clue: room.phase === 'CLUE' ? null : room.clue,
    table:
      room.phase === 'VOTE'
        ? room.tableOrder.map(cid => ({ cardId: cid }))
        : room.phase === 'REVEAL'
        ? room.tableOrder.map(cid => ({
            cardId: cid,
            ownerId: [...room.submissions.entries()].find(
              ([, c]) => c === cid
            )?.[0],
          }))
        : [],
    reveal: room.phase === 'REVEAL' ? room.reveal : null,
    winnerIds: room.winnerIds,
    roundNumber: room.roundNumber,
    deckRemaining: room.deck.length,
    timers: room.timers,
    phaseDeadline: room.phaseDeadline,
    history: room.history,
  };
}

export function privateState(room: Room, playerId: string): PrivateState {
  const me = room.players.find(p => p.id === playerId);
  if (!me) throw new Error('Player not in room');
  const storyteller = room.players[room.storytellerIdx];
  return {
    ...publicState(room),
    you: {
      id: me.id,
      name: me.name,
      hand: me.hand,
      isHost: me.isHost,
      isStoryteller: storyteller?.id === me.id,
    },
  };
}
