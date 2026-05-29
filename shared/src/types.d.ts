export type Phase = 'LOBBY' | 'CLUE' | 'SUBMIT' | 'VOTE' | 'REVEAL' | 'GAME_OVER';
export interface PublicPlayer {
    id: string;
    name: string;
    score: number;
    isHost: boolean;
    connected: boolean;
    hasSubmitted?: boolean;
    hasVoted?: boolean;
}
export interface TableCard {
    cardId: string;
    ownerId?: string;
}
export interface RoundReveal {
    storytellerId: string;
    storytellerCardId: string;
    clue: string;
    cards: {
        cardId: string;
        ownerId: string;
        voterIds: string[];
    }[];
    deltas: Record<string, number>;
}
export interface PublicState {
    code: string;
    phase: Phase;
    maxPlayers: number;
    players: PublicPlayer[];
    storytellerId: string | null;
    clue: string | null;
    table: TableCard[];
    reveal: RoundReveal | null;
    winnerIds: string[];
    roundNumber: number;
    deckRemaining: number;
}
export interface PrivateState extends PublicState {
    you: {
        id: string;
        name: string;
        hand: string[];
        isHost: boolean;
        isStoryteller: boolean;
    };
}
export interface ClientToServer {
    createRoom: (p: {
        hostName: string;
        maxPlayers: number;
    }, cb: (res: Result<{
        code: string;
        token: string;
    }>) => void) => void;
    joinRoom: (p: {
        code: string;
        name: string;
    }, cb: (res: Result<{
        token: string;
    }>) => void) => void;
    rejoin: (p: {
        code: string;
        token: string;
    }, cb: (res: Result<{}>) => void) => void;
    leaveRoom: (p: {
        code: string;
    }) => void;
    startGame: (p: {
        code: string;
    }, cb: (res: Result<{}>) => void) => void;
    submitClue: (p: {
        code: string;
        cardId: string;
        clue: string;
    }, cb: (res: Result<{}>) => void) => void;
    submitCard: (p: {
        code: string;
        cardId: string;
    }, cb: (res: Result<{}>) => void) => void;
    submitVote: (p: {
        code: string;
        cardId: string;
    }, cb: (res: Result<{}>) => void) => void;
    nextRound: (p: {
        code: string;
    }, cb: (res: Result<{}>) => void) => void;
    newMatch: (p: {
        code: string;
    }, cb: (res: Result<{}>) => void) => void;
}
export interface ServerToClient {
    state: (state: PrivateState) => void;
    error: (msg: string) => void;
}
export type Result<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: string;
};
export declare const MIN_PLAYERS = 3;
export declare const MAX_PLAYERS = 6;
export declare const HAND_SIZE = 6;
export declare const WIN_SCORE = 30;
