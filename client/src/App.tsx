import { useEffect, useState } from 'react';
import { socket, emit } from './socket';
import type { PrivateState } from '../../shared/src/types.ts';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  MIN_WIN_SCORE,
  MAX_WIN_SCORE,
  DEFAULT_WIN_SCORE,
} from '../../shared/src/types.ts';

type Saved = { code: string; token: string };
const SAVE_KEY = 'dixit.session';

function loadSaved(): Saved | null {
  try {
    const s = localStorage.getItem(SAVE_KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function saveSession(s: Saved | null) {
  if (s) localStorage.setItem(SAVE_KEY, JSON.stringify(s));
  else localStorage.removeItem(SAVE_KEY);
}

function callEmit<T = {}>(event: any, payload: any): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.emit(event, payload, (res: any) => {
      if (res?.ok) resolve(res.data);
      else reject(new Error(res?.error || 'Error'));
    });
  });
}

function cardUrl(id: string) {
  const ext = (window as any).__DIXIT_CARD_EXT__ || 'svg';
  return `/cards/${id}.${ext}`;
}

export default function App() {
  const [state, setState] = useState<PrivateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    socket.on('connect', () => {
      setConnected(true);
      const saved = loadSaved();
      if (saved) {
        socket.emit('rejoin', saved, (res: any) => {
          if (!res?.ok) {
            saveSession(null);
            setState(null);
          }
        });
      }
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('state', s => setState(s));
    socket.on('error', m => setError(m));
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('state');
      socket.off('error');
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3500);
    return () => clearTimeout(t);
  }, [error]);

  const onLeave = () => {
    if (state) emit('leaveRoom', { code: state.code });
    saveSession(null);
    setState(null);
  };

  return (
    <div className="app">
      <header className="row" style={{ padding: '12px 0' }}>
        <h1 style={{ fontSize: 26 }}>🎨 Dixit</h1>
        <span className="spacer" />
        {state && (
          <button className="btn ghost" onClick={onLeave}>
            Leave
          </button>
        )}
        {!connected && <span className="pill" style={{ color: 'var(--warn)' }}>Offline</span>}
      </header>

      {!state && <Home onJoined={s => saveSession(s)} setError={setError} />}
      {state && <Game state={state} setError={setError} />}

      {error && <div className="toast">{error}</div>}
    </div>
  );
}

// ---------- Home ----------
function Home({
  onJoined,
  setError,
}: {
  onJoined: (s: Saved) => void;
  setError: (m: string) => void;
}) {
  const [mode, setMode] = useState<'idle' | 'create' | 'join'>('idle');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(4);
  const [winScore, setWinScore] = useState<number>(DEFAULT_WIN_SCORE);
  const [busy, setBusy] = useState(false);

  // pre-fill code from URL ?room=XXXX
  useEffect(() => {
    const u = new URL(location.href);
    const r = u.searchParams.get('room');
    if (r) {
      setCode(r.toUpperCase());
      setMode('join');
    }
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      const r = await callEmit<{ code: string; token: string }>('createRoom', {
        hostName: name,
        maxPlayers,
        winScore,
      });
      onJoined({ code: r.code, token: r.token });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    setBusy(true);
    try {
      const r = await callEmit<{ token: string }>('joinRoom', {
        code: code.toUpperCase().trim(),
        name,
      });
      onJoined({ code: code.toUpperCase().trim(), token: r.token });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'idle') {
    return (
      <div className="panel">
        <p className="muted">
          A storytelling party game. Pick a card, give a clue, and try to read your friends' minds.
        </p>
        <div className="row">
          <button className="btn" onClick={() => setMode('create')}>Create room</button>
          <button className="btn secondary" onClick={() => setMode('join')}>Join room</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>{mode === 'create' ? 'Create room' : 'Join room'}</h2>
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="field">
          <span className="field-label">Your name</span>
          <input
            type="text"
            value={name}
            maxLength={25}
            size={25}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Aravinth"
            style={{ width: 'auto', maxWidth: '100%' }}
          />
        </div>

        {mode === 'create' ? (
          <>
            <div className="field">
              <span className="field-label">
                Players: <b>{maxPlayers}</b>
              </span>
              <input
                className="slider"
                type="range"
                min={MIN_PLAYERS}
                max={MAX_PLAYERS}
                step={1}
                value={maxPlayers}
                onChange={e => setMaxPlayers(Number(e.target.value))}
              />
              <span className="muted field-hint">({MIN_PLAYERS}–{MAX_PLAYERS})</span>
            </div>

            <div className="field">
              <span className="field-label">
                Points to win: <b>{winScore}</b>
              </span>
              <input
                className="slider"
                type="range"
                min={MIN_WIN_SCORE}
                max={MAX_WIN_SCORE}
                step={1}
                value={winScore}
                onChange={e => setWinScore(Number(e.target.value))}
              />
              <span className="muted field-hint">({MIN_WIN_SCORE}–{MAX_WIN_SCORE})</span>
            </div>
          </>
        ) : (
          <div className="field">
            <span className="field-label">Room code</span>
            <input
              type="text"
              value={code}
              maxLength={6}
              size={6}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD"
              style={{
                width: 'auto',
                maxWidth: '100%',
                textTransform: 'uppercase',
                letterSpacing: 6,
                fontSize: 24,
                fontWeight: 700,
              }}
            />
          </div>
        )}

        <div className="row">
          <button className="btn ghost" onClick={() => setMode('idle')}>Back</button>
          <span className="spacer" />
          <button
            className="btn"
            disabled={busy || !name.trim() || (mode === 'join' && code.trim().length < 3)}
            onClick={mode === 'create' ? create : join}
          >
            {mode === 'create' ? 'Create' : 'Join'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Game container ----------
function Game({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  return (
    <>
      <RoomBar state={state} />
      <PlayersBar state={state} />
      {state.phase === 'LOBBY' && <Lobby state={state} setError={setError} />}
      {state.phase === 'CLUE' && <CluePhase state={state} setError={setError} />}
      {state.phase === 'SUBMIT' && <SubmitPhase state={state} setError={setError} />}
      {state.phase === 'VOTE' && <VotePhase state={state} setError={setError} />}
      {state.phase === 'REVEAL' && <RevealPhase state={state} setError={setError} />}
      {state.phase === 'GAME_OVER' && <GameOver state={state} setError={setError} />}
    </>
  );
}

function RoomBar({ state }: { state: PrivateState }) {
  const link = `${location.origin}/?room=${state.code}`;
  const copy = () => navigator.clipboard?.writeText(link);
  // Hide the room code / invite link once the match is in progress —
  // it's only useful for joining (LOBBY) or for the next match (GAME_OVER).
  const showCode = state.phase === 'LOBBY' || state.phase === 'GAME_OVER';
  if (!showCode) {
    return (
      <div className="panel row">
        <span className="pill">Round {state.roundNumber}</span>
      </div>
    );
  }
  return (
    <div className="panel row">
      <div>
        <div className="muted" style={{ fontSize: 12 }}>Room code</div>
        <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 6 }}>{state.code}</div>
      </div>
      <span className="spacer" />
      <button className="btn ghost" onClick={copy}>Copy invite link</button>
    </div>
  );
}

function PlayersBar({ state }: { state: PrivateState }) {
  const showStoryteller =
    state.phase !== 'LOBBY' && state.phase !== 'GAME_OVER';
  const winScore = state.winScore || MAX_WIN_SCORE;
  return (
    <div className="players-grid">
      {state.players.map(p => {
        const isYou = p.id === state.you.id;
        const isStoryteller = showStoryteller && p.id === state.storytellerId;
        const isDone =
          (state.phase === 'SUBMIT' && p.hasSubmitted) ||
          (state.phase === 'VOTE' && (p.hasVoted || p.id === state.storytellerId));
        const cls = ['pcard'];
        if (isYou) cls.push('you');
        if (isStoryteller) cls.push('storyteller');
        if (!p.connected) cls.push('disconnected');
        if (isDone) cls.push('done');
        const pct = Math.max(0, Math.min(100, (p.score / winScore) * 100));
        return (
          <div key={p.id} className={cls.join(' ')}>
            <div className="pcard-row">
              {p.isHost && <span className="pcard-role" title="Host">👑</span>}
              {isStoryteller && <span className="pcard-role" title="Storyteller">🎙️</span>}
              <span className="pcard-name" title={p.name}>{p.name}</span>
              {isDone && <span className="pcard-done" title="Ready">✓</span>}
              <span className="pcard-score">
                <b>{p.score}</b>
                <span className="pcard-score-target">/{winScore}</span>
              </span>
            </div>
            <div className="pcard-bar">
              <div className="pcard-bar-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Lobby ----------
function Lobby({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const full = state.players.length === state.maxPlayers;
  const start = async () => {
    try {
      await callEmit('startGame', { code: state.code });
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="panel">
      <h2>Lobby</h2>
      <p className="muted">
        Joined <b>{state.players.length}</b> / {state.maxPlayers} players ·
        first to <b>{state.winScore}</b> points wins.
        Share the room code or invite link.
      </p>
      {state.you.isHost ? (
        <button className="btn" disabled={!full} onClick={start}>
          {full ? 'Start game' : 'Waiting for players…'}
        </button>
      ) : (
        <p className="muted">Waiting for host to start…</p>
      )}
    </div>
  );
}

// ---------- CLUE phase ----------
function CluePhase({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [clue, setClue] = useState('');
  const storyteller = state.players.find(p => p.id === state.storytellerId);

  if (!state.you.isStoryteller) {
    return (
      <div className="panel">
        <h3>🎙️ {storyteller?.name} is the storyteller</h3>
        <p className="muted">Waiting for a clue…</p>
        <Hand cards={state.you.hand} />
      </div>
    );
  }

  const submit = async () => {
    if (!picked || !clue.trim()) return;
    try {
      await callEmit('submitClue', { code: state.code, cardId: picked, clue });
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="panel">
      <h3>You are the storyteller 🎙️</h3>
      <p className="muted">Pick a card, then give a clue (a word, phrase, or song).</p>
      <Hand cards={state.you.hand} selected={picked} onPick={setPicked} />
      <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
        <input
          type="text"
          value={clue}
          maxLength={120}
          placeholder="Your clue…"
          onChange={e => setClue(e.target.value)}
        />
        <button className="btn" disabled={!picked || !clue.trim()} onClick={submit}>
          Give clue
        </button>
      </div>
    </div>
  );
}

// ---------- SUBMIT phase ----------
function SubmitPhase({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const me = state.players.find(p => p.id === state.you.id)!;

  const submit = async () => {
    if (!picked) return;
    try {
      await callEmit('submitCard', { code: state.code, cardId: picked });
      setPicked(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="panel">
      <div className="clue">"{state.clue}"</div>
      {state.you.isStoryteller ? (
        <p className="muted">Waiting for everyone to submit a card matching your clue…</p>
      ) : me.hasSubmitted ? (
        <p className="muted">Submitted ✓ Waiting for others…</p>
      ) : (
        <>
          <p className="muted">Pick a card from your hand that fits the clue.</p>
          <Hand cards={state.you.hand} selected={picked} onPick={setPicked} />
          <button
            className="btn"
            style={{ marginTop: 12 }}
            disabled={!picked}
            onClick={submit}
          >
            Submit card
          </button>
        </>
      )}
    </div>
  );
}

// ---------- VOTE phase ----------
function VotePhase({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const me = state.players.find(p => p.id === state.you.id)!;
  // The card I submitted is on the table; I can't vote it.
  const myOwnCard = state.you.isStoryteller ? null : findMyCardOnTable(state);

  const submit = async () => {
    if (!picked) return;
    try {
      await callEmit('submitVote', { code: state.code, cardId: picked });
      setPicked(null);
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="panel">
      <div className="clue">"{state.clue}"</div>
      {state.you.isStoryteller ? (
        <p className="muted">Waiting for everyone to vote…</p>
      ) : me.hasVoted ? (
        <p className="muted">Voted ✓ Waiting for others…</p>
      ) : (
        <p className="muted">Which card is the storyteller's?</p>
      )}
      <div className="card-grid">
        {state.table.map(c => {
          const isMine = c.cardId === myOwnCard;
          const disabled =
            state.you.isStoryteller || me.hasVoted || isMine;
          return (
            <div
              key={c.cardId}
              className={
                'card' +
                (picked === c.cardId ? ' selected' : '') +
                (disabled ? ' disabled' : '')
              }
              onClick={() => !disabled && setPicked(c.cardId)}
            >
              <img src={cardUrl(c.cardId)} alt="" />
              {isMine && <div className="owner">your card</div>}
            </div>
          );
        })}
      </div>
      {!state.you.isStoryteller && !me.hasVoted && (
        <button
          className="btn"
          style={{ marginTop: 12 }}
          disabled={!picked}
          onClick={submit}
        >
          Cast vote
        </button>
      )}
    </div>
  );
}

function findMyCardOnTable(_state: PrivateState): string | null {
  // We don't get the mapping until reveal, so just track by hand difference is unreliable.
  // Server already prevents voting for own card, so this is best-effort UI only.
  return null;
}

// ---------- REVEAL phase ----------
function RevealPhase({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const reveal = state.reveal!;
  const playerName = (id: string) =>
    state.players.find(p => p.id === id)?.name ?? '?';

  const next = async () => {
    try {
      await callEmit('nextRound', { code: state.code });
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="panel">
      <div className="clue">"{reveal.clue}"</div>
      <div className="muted" style={{ textAlign: 'center', marginBottom: 8 }}>
        🎙️ {playerName(reveal.storytellerId)}'s card was the highlighted one
      </div>
      <div className="card-grid">
        {reveal.cards.map(c => (
          <div
            key={c.cardId}
            className={
              'card' + (c.cardId === reveal.storytellerCardId ? ' story' : '')
            }
          >
            <img src={cardUrl(c.cardId)} alt="" />
            <div className="owner">{playerName(c.ownerId)}</div>
            {c.voterIds.length > 0 && (
              <div className="voters">
                voted by {c.voterIds.map(playerName).join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>

      <h3 style={{ marginTop: 16 }}>Scores</h3>
      {[...state.players]
        .sort((a, b) => b.score - a.score)
        .map(p => {
          const d = reveal.deltas[p.id] ?? 0;
          return (
            <div key={p.id} className="score-row">
              <span>{p.name}</span>
              <span className="spacer" />
              <span className={'delta ' + (d > 0 ? 'pos' : 'zero')}>
                {d > 0 ? `+${d}` : '+0'}
              </span>
              <span style={{ width: 40, textAlign: 'right', fontWeight: 700 }}>{p.score}</span>
            </div>
          );
        })}

      {state.you.isHost ? (
        <button className="btn" style={{ marginTop: 14 }} onClick={next}>
          Next round
        </button>
      ) : (
        <p className="muted" style={{ marginTop: 14 }}>
          Waiting for host to continue…
        </p>
      )}
    </div>
  );
}

// ---------- GAME OVER ----------
function GameOver({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const winners = state.players.filter(p => state.winnerIds.includes(p.id));
  const again = async () => {
    try {
      await callEmit('newMatch', { code: state.code });
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="panel">
      <h2>🏆 Game over</h2>
      <p style={{ fontSize: 18 }}>
        Winner{winners.length > 1 ? 's' : ''}:{' '}
        <b>{winners.map(w => w.name).join(', ')}</b>
      </p>
      {[...state.players]
        .sort((a, b) => b.score - a.score)
        .map(p => (
          <div key={p.id} className="score-row">
            <span>{p.name}</span>
            <span className="spacer" />
            <span style={{ fontWeight: 700 }}>{p.score}</span>
          </div>
        ))}
      {state.you.isHost ? (
        <button className="btn" style={{ marginTop: 14 }} onClick={again}>
          Play again
        </button>
      ) : (
        <p className="muted" style={{ marginTop: 14 }}>Waiting for host…</p>
      )}
    </div>
  );
}

// ---------- Shared hand ----------
function Hand({
  cards,
  selected,
  onPick,
}: {
  cards: string[];
  selected?: string | null;
  onPick?: (id: string) => void;
}) {
  return (
    <div className="card-grid">
      {cards.map(c => (
        <div
          key={c}
          className={'card' + (selected === c ? ' selected' : '') + (onPick ? '' : ' disabled')}
          onClick={() => onPick?.(c)}
        >
          <img src={cardUrl(c)} alt="" />
        </div>
      ))}
    </div>
  );
}
