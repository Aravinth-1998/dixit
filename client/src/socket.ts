import { io, Socket } from 'socket.io-client';
import type {
  ClientToServer,
  ServerToClient,
} from '../../shared/src/types.ts';

export const socket: Socket<ServerToClient, ClientToServer> = io({
  autoConnect: true,
  transports: ['websocket', 'polling'],
});

export function emit<E extends keyof ClientToServer>(
  event: E,
  ...args: Parameters<ClientToServer[E]>
) {
  (socket.emit as any)(event, ...args);
}

