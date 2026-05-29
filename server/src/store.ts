import { Room } from './game.js';

const rooms = new Map<string, Room>();

const IDLE_MS = 12 * 60 * 60 * 1000; // 12h

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

export function putRoom(room: Room) {
  rooms.set(room.code, room);
}

export function deleteRoom(code: string) {
  rooms.delete(code.toUpperCase());
}

export function touch(room: Room) {
  room.lastActivity = Date.now();
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

// Periodic sweep
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > IDLE_MS) rooms.delete(code);
  }
}, 60 * 60 * 1000).unref();

