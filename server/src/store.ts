import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Room } from './game.js';

const rooms = new Map<string, Room>();

const IDLE_MS = 12 * 60 * 60 * 1000; // 12h

// Where to persist rooms across server restarts. Override with
// DIXIT_DATA_DIR (e.g. a mounted disk on Render Starter plan).
const DATA_DIR = process.env.DIXIT_DATA_DIR || join(process.cwd(), 'data');
const DATA_FILE = join(DATA_DIR, 'rooms.json');

// ---------- (De)serialization for Maps + ephemeral socket fields ----------

function serializeRoom(r: Room) {
  return {
    ...r,
    submissions: Array.from(r.submissions.entries()),
    votes: Array.from(r.votes.entries()),
    // strip ephemeral runtime fields — sockets are gone after restart
    players: r.players.map(p => ({
      ...p,
      socketId: null,
      connected: false,
    })),
  };
}

function deserializeRoom(o: any): Room {
  return {
    ...o,
    submissions: new Map(o.submissions ?? []),
    votes: new Map(o.votes ?? []),
    players: (o.players ?? []).map((p: any) => ({
      ...p,
      socketId: null,
      connected: false,
    })),
  } as Room;
}

// ---------- Load on startup ----------

(function loadFromDisk() {
  try {
    if (!existsSync(DATA_FILE)) return;
    const raw = readFileSync(DATA_FILE, 'utf-8');
    if (!raw.trim()) return;
    const arr = JSON.parse(raw) as any[];
    for (const o of arr) {
      const room = deserializeRoom(o);
      rooms.set(room.code, room);
    }
    if (rooms.size > 0) {
      console.log(`[store] Restored ${rooms.size} room(s) from ${DATA_FILE}`);
    }
  } catch (e) {
    console.warn('[store] Failed to load rooms from disk:', e);
  }
})();

// ---------- Debounced flush ----------

let flushTimer: NodeJS.Timeout | null = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const payload = Array.from(rooms.values()).map(serializeRoom);
      writeFileSync(DATA_FILE, JSON.stringify(payload));
    } catch (e) {
      console.warn('[store] Failed to persist rooms:', e);
    }
  }, 400);
  flushTimer.unref?.();
}

// Best-effort flush on shutdown so a quick deploy doesn't lose live state.
for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit'] as const) {
  process.on(sig as any, () => {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const payload = Array.from(rooms.values()).map(serializeRoom);
      writeFileSync(DATA_FILE, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  });
}

// ---------- Public API ----------

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

export function putRoom(room: Room) {
  rooms.set(room.code, room);
  scheduleFlush();
}

export function deleteRoom(code: string) {
  rooms.delete(code.toUpperCase());
  scheduleFlush();
}

export function touch(room: Room) {
  room.lastActivity = Date.now();
  scheduleFlush();
}

export function generateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++)
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (rooms.has(code));
  return code;
}

// Periodic sweep for idle rooms
setInterval(() => {
  const now = Date.now();
  let removed = 0;
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > IDLE_MS) {
      rooms.delete(code);
      removed++;
    }
  }
  if (removed > 0) scheduleFlush();
}, 60 * 60 * 1000).unref();

