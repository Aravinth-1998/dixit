import { randomUUID } from 'node:crypto';
import {
  HAND_SIZE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MIN_WIN_SCORE,
  MAX_WIN_SCORE,
  DEFAULT_WIN_SCORE,
  Phase,
  PrivateState,
  PublicPlayer,
  PublicState,
  RoundReveal,
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
  winScore: number = DEFAULT_WIN_SCORE
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
  };
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
  };
  room.phase = 'REVEAL';
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
