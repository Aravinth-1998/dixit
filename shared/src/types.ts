// Shared types between client and server.

export type Phase = 'LOBBY' | 'CLUE' | 'SUBMIT' | 'VOTE' | 'REVEAL' | 'GAME_OVER';

export interface PublicPlayer {
  id: string;            // playerToken (stable across reconnects)
  name: string;
  score: number;
  isHost: boolean;
  connected: boolean;
  // round-state flags (visible to all):
  hasSubmitted?: boolean;
  hasVoted?: boolean;
  /** AI bot filler — never has a real socket. */
  isBot?: boolean;
}

export interface TableCard {
  cardId: string;        // image id from manifest
  // ownerId is hidden until REVEAL
  ownerId?: string;
}

export interface RoundReveal {
  storytellerId: string;
  storytellerCardId: string;
  clue: string;
  // For each placed card, who placed it and who voted for it
  cards: {
    cardId: string;
    ownerId: string;
    voterIds: string[];
  }[];
  // Score delta this round, by playerId
  deltas: Record<string, number>;
  /** 1-based round number this reveal corresponds to. */
  roundNumber?: number;
}

/** Per-phase auto-expire timers (seconds). 0 disables that phase's timer. */
export interface TimerConfig {
  clueSec: number;
  submitSec: number;
  voteSec: number;
}

export const DEFAULT_TIMERS: TimerConfig = {
  clueSec: 0,
  submitSec: 0,
  voteSec: 0,
};
export const MAX_PHASE_SEC = 300; // 5 min cap per phase

export interface PublicState {
  code: string;
  phase: Phase;
  maxPlayers: number;
  winScore: number;
  players: PublicPlayer[];
  storytellerId: string | null;
  clue: string | null;
  // cards on the table during VOTE/REVEAL (shuffled)
  table: TableCard[];
  reveal: RoundReveal | null;
  winnerIds: string[];      // populated in GAME_OVER
  roundNumber: number;
  deckRemaining: number;
  /** Per-phase timer config (host-controlled). */
  timers: TimerConfig;
  /** When the current phase auto-advances (epoch ms). null = no timer. */
  phaseDeadline: number | null;
  /** Completed rounds, oldest first. */
  history: RoundReveal[];
}

// Private per-player view (adds your hand + your token info)
export interface PrivateState extends PublicState {
  you: {
    id: string;            // playerToken
    name: string;
    hand: string[];        // cardIds
    isHost: boolean;
    isStoryteller: boolean;
  };
}

// ---------- Socket events ----------

export interface ClientToServer {
  createRoom: (
    p: { hostName: string; maxPlayers: number; winScore?: number; timers?: TimerConfig },
    cb: (res: Result<{ code: string; token: string }>) => void
  ) => void;
  joinRoom: (
    p: { code: string; name: string },
    cb: (res: Result<{ token: string }>) => void
  ) => void;
  rejoin: (
    p: { code: string; token: string },
    cb: (res: Result<{}>) => void
  ) => void;
  leaveRoom: (p: { code: string }) => void;
  startGame: (p: { code: string }, cb: (res: Result<{}>) => void) => void;
  submitClue: (
    p: { code: string; cardId: string; clue: string },
    cb: (res: Result<{}>) => void
  ) => void;
  submitCard: (
    p: { code: string; cardId: string },
    cb: (res: Result<{}>) => void
  ) => void;
  submitVote: (
    p: { code: string; cardId: string },
    cb: (res: Result<{}>) => void
  ) => void;
  nextRound: (p: { code: string }, cb: (res: Result<{}>) => void) => void;
  newMatch: (p: { code: string }, cb: (res: Result<{}>) => void) => void;
  /** Host-only: configure per-phase auto-expire timers (lobby only). */
  setTimers: (
    p: { code: string; timers: TimerConfig },
    cb: (res: Result<{}>) => void
  ) => void;
  /** Host-only: kick a player. They cannot rejoin this room. */
  kickPlayer: (
    p: { code: string; playerId: string },
    cb: (res: Result<{}>) => void
  ) => void;
  /** Host-only: add an AI bot to fill an empty seat (lobby only). */
  addBot: (
    p: { code: string },
    cb: (res: Result<{ playerId: string }>) => void
  ) => void;
  /** Broadcast an emoji reaction to everyone in the room. */
  react: (
    p: { code: string; emoji: string },
    cb: (res: Result<{}>) => void
  ) => void;
}

export interface ServerToClient {
  state: (state: PrivateState) => void;
  error: (msg: string) => void;
  /** Pushed when any player reacts; clients render a short-lived float. */
  reaction: (p: { playerId: string; emoji: string; ts: number }) => void;
}

export const ALLOWED_REACTIONS = ['👍', '😂', '😢', '👎'] as const;
export type Reaction = typeof ALLOWED_REACTIONS[number];

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 6;
export const HAND_SIZE = 6;
export const MIN_WIN_SCORE = 1;
export const MAX_WIN_SCORE = 30;
export const DEFAULT_WIN_SCORE = 30;
/** Backward-compat alias; per-room value lives on PublicState.winScore. */
export const WIN_SCORE = MAX_WIN_SCORE;
