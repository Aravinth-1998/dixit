import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import {
  ClientToServer,
  ServerToClient,
  MAX_PLAYERS,
  MIN_PLAYERS,
  MIN_WIN_SCORE,
  MAX_WIN_SCORE,
  DEFAULT_WIN_SCORE,
  ALLOWED_REACTIONS,
} from '../../shared/src/types.js';
import {
  addBot,
  addPlayer,
  createRoom,
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
  Room,
  setTimers,
  startGame,
  submitCard,
  submitClue,
  submitVote,
} from './game.js';
import { deleteRoom, generateCode, getRoom, putRoom, touch } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Load card manifest ----------
function loadCardIds(): string[] {
  // Look for manifest in several places (dev/prod, varying nesting depth).
  const candidates = [
    join(__dirname, '../../client/public/cards/manifest.json'),
    join(__dirname, '../../client/dist/cards/manifest.json'),
    join(__dirname, '../public/cards/manifest.json'),
    join(__dirname, '../../../client/public/cards/manifest.json'),
    join(__dirname, '../../../client/dist/cards/manifest.json'),
    join(__dirname, '../../../../client/public/cards/manifest.json'),
    join(__dirname, '../../../../client/dist/cards/manifest.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf-8')) as { cards: string[] };
      return data.cards;
    }
  }
  console.warn('No card manifest found; using empty deck.');
  return [];
}

const CARD_IDS = loadCardIds();
console.log(`Loaded ${CARD_IDS.length} cards.`);

// ---------- Express + Socket.IO ----------
const app = express();
const httpServer = createServer(app);
const io = new Server<ClientToServer, ServerToClient>(httpServer, {
  cors: { origin: '*' },
});

// Serve built client (in prod)
const clientDistCandidates = [
  join(__dirname, '../../client/dist'),
  join(__dirname, '../../../client/dist'),
  join(__dirname, '../../../../client/dist'),
];
const clientDist = clientDistCandidates.find(p => existsSync(p)) ?? clientDistCandidates[0];
app.get('/health', (_req, res) => res.send('ok'));
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

// ---------- Helpers ----------
const phaseTimers = new Map<string, NodeJS.Timeout>();

// Grace window for lobby disconnects. A page refresh closes the socket and
// immediately reconnects; we don't want that to look like the player left.
const LOBBY_REJOIN_GRACE_MS = 20_000;
// key: `${roomCode}:${playerToken}` -> pending eviction timer
const lobbyEvictionTimers = new Map<string, NodeJS.Timeout>();

function evictionKey(code: string, token: string) {
  return `${code}:${token}`;
}

function clearLobbyEviction(code: string, token: string) {
  const k = evictionKey(code, token);
  const t = lobbyEvictionTimers.get(k);
  if (t) {
    clearTimeout(t);
    lobbyEvictionTimers.delete(k);
  }
}

function scheduleLobbyEviction(code: string, token: string) {
  clearLobbyEviction(code, token);
  const timer = setTimeout(() => {
    lobbyEvictionTimers.delete(evictionKey(code, token));
    const room = getRoom(code);
    if (!room || room.phase !== 'LOBBY') return;
    const player = room.players.find(p => p.id === token);
    if (!player || player.connected) return; // they came back — leave them alone
    const wasHost = player.isHost;
    room.players = room.players.filter(p => p.id !== token);
    if (room.players.length === 0) {
      clearPhaseTimer(code);
      cancelBotActions(code);
      deleteRoom(code);
      return;
    }
    if (wasHost) room.players[0].isHost = true;
    broadcast(room);
  }, LOBBY_REJOIN_GRACE_MS);
  timer.unref?.();
  lobbyEvictionTimers.set(evictionKey(code, token), timer);
}

/** Cancel any pending auto-expire for this room. */
function clearPhaseTimer(code: string) {
  const t = phaseTimers.get(code);
  if (t) {
    clearTimeout(t);
    phaseTimers.delete(code);
  }
}

/**
 * Look at the room's current phase + configured timers. If the phase
 * supports an auto-expire and one is configured, set room.phaseDeadline and
 * schedule a timeout that fires the appropriate expire helper and rebroadcasts.
 * Idempotent: clears any existing scheduled timer first.
 */
function scheduleAutoExpire(room: Room) {
  clearPhaseTimer(room.code);
  let sec = 0;
  if (room.phase === 'CLUE') sec = room.timers.clueSec;
  else if (room.phase === 'SUBMIT') sec = room.timers.submitSec;
  else if (room.phase === 'VOTE') sec = room.timers.voteSec;
  if (!sec || sec <= 0) {
    room.phaseDeadline = null;
    return;
  }
  room.phaseDeadline = Date.now() + sec * 1000;
  const timer = setTimeout(() => {
    phaseTimers.delete(room.code);
    try {
      if (room.phase === 'CLUE') expireClue(room);
      else if (room.phase === 'SUBMIT') expireSubmit(room);
      else if (room.phase === 'VOTE') expireVote(room);
    } catch (e) {
      console.warn('Auto-expire failed', e);
    }
    broadcast(room);
  }, sec * 1000);
  timer.unref?.();
  phaseTimers.set(room.code, timer);
}

function broadcast(room: Room) {
  touch(room);
  // (Re)evaluate the auto-expire timer based on the room's current phase.
  // We do this here so every code path that mutates state + broadcasts
  // automatically keeps the schedule in sync.
  scheduleAutoExpire(room);
  // Drive any bot players that need to act in the current phase.
  scheduleBotActions(room);
  for (const p of room.players) {
    if (!p.socketId) continue;
    io.to(p.socketId).emit('state', privateState(room, p.id));
  }
}

// ---------- Bot driver ----------
//
// Each room has a set of scheduled bot actions. Whenever the room broadcasts
// (i.e. state changed), we cancel any previously-pending bot timers and
// schedule fresh ones based on whose turn it now is. Bots act with a small
// randomized delay so the game feels alive instead of instant.

const botActionTimers = new Map<string, NodeJS.Timeout[]>();

function cancelBotActions(code: string) {
  const ts = botActionTimers.get(code);
  if (ts) for (const t of ts) clearTimeout(t);
  botActionTimers.set(code, []);
}

function scheduleBotActions(room: Room) {
  cancelBotActions(room.code);
  const timers: NodeJS.Timeout[] = [];
  const jitter = (base: number) => base + Math.floor(Math.random() * 800);
  const schedule = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      // Skip if the room has moved on while we waited.
      const current = getRoom(room.code);
      if (current !== room) return;
      try {
        fn();
        broadcast(room);
      } catch {
        /* swallow — broadcast won't run, but other timers may still fire */
      }
    }, ms);
    t.unref?.();
    timers.push(t);
  };

  if (room.phase === 'CLUE') {
    const st = room.players[room.storytellerIdx];
    if (st?.isBot) schedule(jitter(1500), () => doBotClue(room, st.id));
  } else if (room.phase === 'SUBMIT') {
    for (const p of room.players) {
      if (!p.isBot) continue;
      if (room.players[room.storytellerIdx]?.id === p.id) continue;
      if (room.submissions.has(p.id)) continue;
      schedule(jitter(1200), () => doBotSubmit(room, p.id));
    }
  } else if (room.phase === 'VOTE') {
    for (const p of room.players) {
      if (!p.isBot) continue;
      if (room.players[room.storytellerIdx]?.id === p.id) continue;
      if (room.votes.has(p.id)) continue;
      schedule(jitter(1400), () => doBotVote(room, p.id));
    }
  }

  botActionTimers.set(room.code, timers);
}

function ok<T>(data: T) {
  return { ok: true as const, data };
}
function err(error: string) {
  return { ok: false as const, error };
}

// Track socket -> { code, token } so we can mark disconnect
const socketIndex = new Map<string, { code: string; token: string }>();

function attach(socketId: string, code: string, token: string) {
  socketIndex.set(socketId, { code, token });
}

io.on('connection', socket => {
  socket.on('createRoom', ({ hostName, maxPlayers, winScore, timers }, cb) => {
    try {
      if (typeof hostName !== 'string' || !hostName.trim())
        return cb(err('Name is required'));
      if (
        typeof maxPlayers !== 'number' ||
        maxPlayers < MIN_PLAYERS ||
        maxPlayers > MAX_PLAYERS
      )
        return cb(err(`Players must be ${MIN_PLAYERS}-${MAX_PLAYERS}`));
      const ws = winScore ?? DEFAULT_WIN_SCORE;
      if (
        typeof ws !== 'number' ||
        !Number.isFinite(ws) ||
        ws < MIN_WIN_SCORE ||
        ws > MAX_WIN_SCORE
      )
        return cb(err(`Points to win must be ${MIN_WIN_SCORE}-${MAX_WIN_SCORE}`));
      if (CARD_IDS.length < maxPlayers * 6 + 10)
        return cb(err('Not enough cards on server'));
      const code = generateCode();
      const { room, hostToken } = createRoom(
        code, hostName, maxPlayers, CARD_IDS, ws, timers,
      );
      room.players[0].socketId = socket.id;
      putRoom(room);
      socket.join(code);
      attach(socket.id, code, hostToken);
      cb(ok({ code, token: hostToken }));
      broadcast(room);
    } catch (e: any) {
      cb(err(e.message ?? 'Failed to create room'));
    }
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    try {
      const room = getRoom(code);
      if (!room) return cb(err('Room not found'));
      const token = addPlayer(room, name);
      const p = room.players.find(pp => pp.id === token)!;
      p.socketId = socket.id;
      socket.join(room.code);
      attach(socket.id, room.code, token);
      cb(ok({ token }));
      broadcast(room);
    } catch (e: any) {
      cb(err(e.message ?? 'Failed to join'));
    }
  });

  socket.on('rejoin', ({ code, token }, cb) => {
    try {
      const room = getRoom(code);
      if (!room) return cb(err('Room not found'));
      if (isBanned(room, token)) return cb(err('You were removed from this room'));
      const player = room.players.find(p => p.id === token);
      if (!player) return cb(err('Player not in room'));
      // They beat the grace window — cancel any pending lobby eviction.
      clearLobbyEviction(room.code, token);
      player.socketId = socket.id;
      player.connected = true;
      socket.join(room.code);
      attach(socket.id, room.code, token);
      cb(ok({}));
      broadcast(room);
    } catch (e: any) {
      cb(err(e.message ?? 'Failed to rejoin'));
    }
  });

  socket.on('leaveRoom', ({ code }) => {
    const room = getRoom(code);
    if (!room) return;
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx === -1) return;
    if (room.phase === 'LOBBY') {
      const [removed] = room.players.splice(idx, 1);
      clearLobbyEviction(room.code, removed.id);
      // If host left, promote next; if empty, delete room.
      if (room.players.length === 0) {
        clearPhaseTimer(room.code);
        cancelBotActions(room.code);
        deleteRoom(room.code);
        return;
      }
      if (removed.isHost) room.players[0].isHost = true;
    } else {
      // mid-game: just mark disconnected; promote a new host if needed
      room.players[idx].connected = false;
      room.players[idx].socketId = null;
      if (room.players[idx].isHost) {
        room.players[idx].isHost = false;
        promoteHostIfNeeded(room);
      }
    }
    socketIndex.delete(socket.id);
    broadcast(room);
  });

  function withRoom(
    code: string,
    cb: (res: any) => void,
    fn: (room: Room, playerId: string) => void
  ) {
    try {
      const room = getRoom(code);
      if (!room) return cb(err('Room not found'));
      const idx = socketIndex.get(socket.id);
      if (!idx || idx.code !== room.code) return cb(err('Not in room'));
      fn(room, idx.token);
      cb(ok({}));
      broadcast(room);
    } catch (e: any) {
      cb(err(e.message ?? 'Action failed'));
    }
  }

  socket.on('startGame', ({ code }, cb) =>
    withRoom(code, cb, (room, pid) => {
      const player = room.players.find(p => p.id === pid);
      if (!player?.isHost) throw new Error('Only host can start');
      startGame(room, CARD_IDS);
    })
  );

  socket.on('submitClue', ({ code, cardId, clue }, cb) =>
    withRoom(code, cb, (room, pid) => submitClue(room, pid, cardId, clue))
  );

  socket.on('submitCard', ({ code, cardId }, cb) =>
    withRoom(code, cb, (room, pid) => submitCard(room, pid, cardId))
  );

  socket.on('submitVote', ({ code, cardId }, cb) =>
    withRoom(code, cb, (room, pid) => submitVote(room, pid, cardId))
  );

  socket.on('nextRound', ({ code }, cb) =>
    withRoom(code, cb, (room, pid) => {
      const player = room.players.find(p => p.id === pid);
      if (!player?.isHost) throw new Error('Only host advances the round');
      nextRound(room);
    })
  );

  socket.on('newMatch', ({ code }, cb) =>
    withRoom(code, cb, (room, pid) => {
      const player = room.players.find(p => p.id === pid);
      if (!player?.isHost) throw new Error('Only host can start a new match');
      newMatch(room, CARD_IDS);
    })
  );

  socket.on('setTimers', ({ code, timers }, cb) =>
    withRoom(code, cb, (room, pid) => {
      const player = room.players.find(p => p.id === pid);
      if (!player?.isHost) throw new Error('Only host can set timers');
      setTimers(room, timers || {});
    })
  );

  socket.on('kickPlayer', ({ code, playerId }, cb) =>
    withRoom(code, cb, (room, pid) => {
      const player = room.players.find(p => p.id === pid);
      if (!player?.isHost) throw new Error('Only host can kick');
      if (playerId === pid) throw new Error('Host cannot kick themselves');
      // Disconnect their socket if any
      const target = room.players.find(p => p.id === playerId);
      const targetSocketId = target?.socketId ?? null;
      kickPlayer(room, playerId);
      if (targetSocketId) {
        socketIndex.delete(targetSocketId);
        const sock = io.sockets.sockets.get(targetSocketId);
        if (sock) {
          sock.emit('error', 'You were removed from the room by the host');
          sock.leave(room.code);
        }
      }
    })
  );

  socket.on('addBot', ({ code }, cb) => {
    try {
      const idx = socketIndex.get(socket.id);
      if (!idx || idx.code !== code.toUpperCase()) return cb(err('Not in room'));
      const room = getRoom(code);
      if (!room) return cb(err('Room not found'));
      const player = room.players.find(p => p.id === idx.token);
      if (!player?.isHost) return cb(err('Only host can add bots'));
      const botId = addBot(room);
      cb(ok({ playerId: botId }));
      broadcast(room);
    } catch (e: any) {
      cb(err(e.message ?? 'Failed to add bot'));
    }
  });

  // Lightweight broadcast — does not mutate room state, no rebroadcast needed.
  socket.on('react', ({ code, emoji }, cb) => {
    try {
      const idx = socketIndex.get(socket.id);
      if (!idx || idx.code !== code.toUpperCase())
        return cb(err('Not in room'));
      if (!ALLOWED_REACTIONS.includes(emoji as any))
        return cb(err('Unknown reaction'));
      const room = getRoom(code);
      if (!room) return cb(err('Room not found'));
      io.to(room.code).emit('reaction', {
        playerId: idx.token,
        emoji,
        ts: Date.now(),
      });
      cb(ok({}));
    } catch (e: any) {
      cb(err(e.message ?? 'Failed to react'));
    }
  });

  socket.on('disconnect', () => {
    const idx = socketIndex.get(socket.id);
    if (!idx) return;
    socketIndex.delete(socket.id);
    const room = getRoom(idx.code);
    if (!room) return;
    const player = room.players.find(p => p.id === idx.token);
    if (!player) return;
    if (room.phase === 'LOBBY') {
      // Don't kick lobby players on disconnect — they might just be
      // refreshing the page. Mark them disconnected and give them a short
      // grace window to come back. If they don't, drop them.
      player.connected = false;
      player.socketId = null;
      scheduleLobbyEviction(room.code, player.id);
    } else {
      player.connected = false;
      player.socketId = null;
      // If the host just dropped mid-game, promote the next connected
      // player so the game can keep advancing.
      if (player.isHost) {
        player.isHost = false;
        promoteHostIfNeeded(room);
      }
    }
    broadcast(room);
  });
});

const PORT = Number(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`Dixit server listening on :${PORT}`);
});

