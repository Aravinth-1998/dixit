// End-to-end smoke test: 3 players play a full round through the live server.
import { io } from 'socket.io-client';

const URL = 'http://127.0.0.1:3001';
const names = ['Alice', 'Bob', 'Charlie'];

function rpc(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event} timed out`)), 5000);
    socket.emit(event, payload, res => {
      clearTimeout(t);
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error || 'rpc failed'));
    });
  });
}

function waitForState(socket, predicate) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('state predicate timed out')), 5000);
    const handler = state => {
      if (predicate(state)) {
        clearTimeout(t);
        socket.off('state', handler);
        resolve(state);
      }
    };
    socket.on('state', handler);
  });
}

const sockets = names.map(() => io(URL, { transports: ['websocket'] }));
const lastState = new Array(names.length).fill(null);
sockets.forEach((s, i) => s.on('state', st => (lastState[i] = st)));

await Promise.all(sockets.map(s => new Promise(r => s.on('connect', r))));
console.log('all connected');

const { code } = await rpc(sockets[0], 'createRoom', { hostName: names[0], maxPlayers: 3 });
console.log('room:', code);

await rpc(sockets[1], 'joinRoom', { code, name: names[1] });
await rpc(sockets[2], 'joinRoom', { code, name: names[2] });
console.log('joined');

await rpc(sockets[0], 'startGame', { code });
await waitForState(sockets[0], s => s.phase === 'CLUE');
console.log('game started');

// Storyteller is sockets[0] (host, idx 0)
const stState = lastState[0];
if (!stState.you.isStoryteller) throw new Error('expected host to be storyteller');
const stCard = stState.you.hand[0];
await rpc(sockets[0], 'submitClue', { code, cardId: stCard, clue: 'dreamscape' });
await waitForState(sockets[1], s => s.phase === 'SUBMIT');
console.log('clue given');

// Other players submit a card each
await rpc(sockets[1], 'submitCard', { code, cardId: lastState[1].you.hand[0] });
await rpc(sockets[2], 'submitCard', { code, cardId: lastState[2].you.hand[0] });
await waitForState(sockets[1], s => s.phase === 'VOTE');
console.log('all cards submitted; voting phase');

// Non-storytellers vote. Pick any card that isn't theirs (server enforces).
const tableCards = lastState[1].table.map(c => c.cardId);
// p1 votes the first card that isn't their submission; same for p2.
// Since we don't know which is theirs, just pick the first that the server accepts.
async function voteAny(idx) {
  for (const cid of tableCards) {
    try {
      await rpc(sockets[idx], 'submitVote', { code, cardId: cid });
      return cid;
    } catch (e) {
      if (!String(e.message).includes('own card')) throw e;
    }
  }
  throw new Error('no votable card');
}
await voteAny(1);
await voteAny(2);
await waitForState(sockets[0], s => s.phase === 'REVEAL');
console.log('reveal phase reached');

const reveal = lastState[0].reveal;
console.log('clue was:', reveal.clue);
console.log('storyteller card:', reveal.storytellerCardId, '(by', reveal.storytellerId.slice(0, 6), ')');
console.log('cards on table:');
for (const c of reveal.cards) {
  const owner = lastState[0].players.find(p => p.id === c.ownerId)?.name;
  const voters = c.voterIds
    .map(v => lastState[0].players.find(p => p.id === v)?.name)
    .join(', ');
  console.log(`  ${c.cardId} by ${owner} (voters: ${voters || 'none'})`);
}
console.log('score deltas:', Object.fromEntries(
  Object.entries(reveal.deltas).map(([k, v]) => [
    lastState[0].players.find(p => p.id === k)?.name, v,
  ])
));
console.log('totals:', Object.fromEntries(
  lastState[0].players.map(p => [p.name, p.score])
));

// Host advances to next round to prove rotation works
await rpc(sockets[0], 'nextRound', { code });
await waitForState(sockets[0], s => s.phase === 'CLUE');
const newSt = lastState[0].players[1].id;
if (lastState[0].storytellerId !== newSt) throw new Error('storyteller did not rotate');
console.log('round 2 started; storyteller rotated to', lastState[0].players[1].name);

sockets.forEach(s => s.disconnect());
console.log('OK — e2e passed');
process.exit(0);

