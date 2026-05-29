import { useEffect, useRef, useState } from 'react';
import { socket, emit } from './socket';
import type { PrivateState, RoundReveal, TimerConfig } from '../../shared/src/types.ts';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  MIN_WIN_SCORE,
  MAX_WIN_SCORE,
  DEFAULT_WIN_SCORE,
  MAX_PHASE_SEC,
  DEFAULT_TIMERS,
  ALLOWED_REACTIONS,
} from '../../shared/src/types.ts';
import { sounds, buzz, unlockAudio } from './sounds';

// ---------- Per-player color (stable from id) ----------
const PLAYER_COLORS = [
  '#a855f7', '#22d3ee', '#22c55e', '#f59e0b',
  '#ef4444', '#ec4899', '#3b82f6', '#eab308',
  '#14b8a6', '#f97316',
];
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function playerColor(id: string): string {
  return PLAYER_COLORS[hashStr(id) % PLAYER_COLORS.length];
}
function playerInitial(name: string): string {
  const trimmed = name.trim();
  return (trimmed[0] || '?').toUpperCase();
}

function Avatar({
  player,
  size = 22,
}: {
  player: { id: string; name: string };
  size?: number;
}) {
  const bg = playerColor(player.id);
  return (
    <span
      className="avatar"
      title={player.name}
      style={{
        background: bg,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
      }}
    >
      {playerInitial(player.name)}
    </span>
  );
}

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

/** Force the browser to fetch & cache card images so they don't pop in later. */
const preloadCache = new Set<string>();
function preloadCards(ids: Iterable<string>) {
  for (const id of ids) {
    if (preloadCache.has(id)) continue;
    preloadCache.add(id);
    const img = new Image();
    img.decoding = 'async';
    img.loading = 'eager';
    img.src = cardUrl(id);
  }
}

export default function App() {
  const [state, setState] = useState<PrivateState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [reconnAttempt, setReconnAttempt] = useState(0);
  const { info, dismissInfo } = useGameAlerts(state);

  // Unlock WebAudio on the very first user gesture (required by Safari/iOS).
  useEffect(() => {
    const onFirst = () => {
      unlockAudio();
      window.removeEventListener('pointerdown', onFirst);
      window.removeEventListener('keydown', onFirst);
    };
    window.addEventListener('pointerdown', onFirst, { once: true });
    window.addEventListener('keydown', onFirst, { once: true });
    return () => {
      window.removeEventListener('pointerdown', onFirst);
      window.removeEventListener('keydown', onFirst);
    };
  }, []);

  useEffect(() => {
    socket.on('connect', () => {
      setConnected(true);
      setReconnAttempt(0);
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
    socket.io.on('reconnect_attempt', (n: number) => {
      setConnected(false);
      setReconnAttempt(n);
    });
    socket.io.on('reconnect', () => {
      setConnected(true);
      setReconnAttempt(0);
    });
    socket.on('state', s => setState(s));
    socket.on('error', m => {
      setError(m);
      // If the server told us we've been removed, drop our saved session so
      // we don't keep trying to rejoin.
      if (/removed/i.test(m) || /not in room/i.test(m)) {
        saveSession(null);
        setState(null);
      }
    });
    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('state');
      socket.off('error');
      socket.io.off('reconnect_attempt');
      socket.io.off('reconnect');
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3500);
    return () => clearTimeout(t);
  }, [error]);

  // Preload all card images currently visible to this client (hand, table,
  // reveal cards, history thumbnails) so they're cached before we render
  // them at a different size or in a flip animation.
  useEffect(() => {
    if (!state) return;
    const ids = new Set<string>();
    state.you.hand.forEach(id => ids.add(id));
    state.table.forEach(c => ids.add(c.cardId));
    state.reveal?.cards.forEach(c => ids.add(c.cardId));
    state.history.forEach(r => r.cards.forEach(c => ids.add(c.cardId)));
    preloadCards(ids);
  }, [state]);

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
        {!connected && !state && (
          <span className="pill" style={{ color: 'var(--warn)' }}>Offline</span>
        )}
      </header>

      {!connected && state && (
        <div className="reconnect-banner">
          <span className="spinner" />
          <span>
            Reconnecting{reconnAttempt > 0 ? ` (attempt ${reconnAttempt})` : ''}…
          </span>
        </div>
      )}

      {!state && <Home onJoined={s => saveSession(s)} setError={setError} />}
      {state && <Game state={state} setError={setError} />}

      {info && (
        <div className="toast info" onClick={dismissInfo}>
          {info}
        </div>
      )}
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
  const [timers, setTimers] = useState<TimerConfig>({ ...DEFAULT_TIMERS });
  const [showAdvanced, setShowAdvanced] = useState(false);
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
        timers,
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

            <div>
              <button
                type="button"
                className="btn ghost"
                onClick={() => setShowAdvanced(v => !v)}
                style={{ width: '100%', justifyContent: 'space-between' }}
              >
                <span>⚙️ Advanced options</span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {timerSummary(timers)} {showAdvanced ? '▾' : '▸'}
                </span>
              </button>
              {showAdvanced && (
                <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
                  <p className="muted field-hint" style={{ textAlign: 'center', margin: 0 }}>
                    Per-phase timers. 0 = off. If a player doesn't act in time,
                    a random pick is made for them.
                  </p>
                  <TimerSlider
                    label="Clue (storyteller)"
                    value={timers.clueSec}
                    onChange={v => setTimers(t => ({ ...t, clueSec: v }))}
                  />
                  <TimerSlider
                    label="Submit (others pick a card)"
                    value={timers.submitSec}
                    onChange={v => setTimers(t => ({ ...t, submitSec: v }))}
                  />
                  <TimerSlider
                    label="Vote"
                    value={timers.voteSec}
                    onChange={v => setTimers(t => ({ ...t, voteSec: v }))}
                  />
                </div>
              )}
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
      <HistoryPanel state={state} />
      <RoomBar state={state} />
      <PlayersBar state={state} setError={setError} />
      {state.phase === 'LOBBY' && <Lobby state={state} setError={setError} />}
      {state.phase === 'CLUE' && <CluePhase state={state} setError={setError} />}
      {state.phase === 'SUBMIT' && <SubmitPhase state={state} setError={setError} />}
      {state.phase === 'VOTE' && <VotePhase state={state} setError={setError} />}
      {state.phase === 'REVEAL' && <RevealPhase state={state} setError={setError} />}
      {state.phase === 'GAME_OVER' && <GameOver state={state} setError={setError} />}
      <FloatingReactions state={state} />
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
        <span className="spacer" />
        <PhaseCountdown state={state} />
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

/** Live countdown to state.phaseDeadline (epoch ms). Shows nothing if null. */
function PhaseCountdown({ state }: { state: PrivateState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.phaseDeadline) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [state.phaseDeadline]);
  if (!state.phaseDeadline) return null;
  const secsLeft = Math.max(0, Math.ceil((state.phaseDeadline - now) / 1000));
  const m = Math.floor(secsLeft / 60);
  const s = secsLeft % 60;
  const txt = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  const cls = 'pill timer' + (secsLeft <= 10 ? ' urgent' : '');
  return <span className={cls}>⏱️ {txt}</span>;
}

function PlayersBar({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const showStoryteller =
    state.phase !== 'LOBBY' && state.phase !== 'GAME_OVER';
  const winScore = state.winScore || MAX_WIN_SCORE;
  const iAmHost = state.you.isHost;
  const kick = async (playerId: string, name: string) => {
    if (!confirm(`Remove ${name} from the room? They won't be able to rejoin.`)) return;
    try {
      await callEmit('kickPlayer', { code: state.code, playerId });
    } catch (e: any) {
      setError(e.message);
    }
  };
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
        // Host can kick anyone except themselves. In mid-game, restrict to
        // disconnected players so we don't yank an active player out of a round.
        const canKick =
          iAmHost &&
          !isYou &&
          (state.phase === 'LOBBY' ||
            state.phase === 'GAME_OVER' ||
            !p.connected);
        return (
          <div key={p.id} className={cls.join(' ')}>
            <div className="pcard-row">
              <Avatar player={p} size={22} />
              {p.isHost && <span className="pcard-role" title="Host">👑</span>}
              {isStoryteller && <span className="pcard-role" title="Storyteller">🎙️</span>}
              <span className="pcard-name" title={p.name}>{p.name}</span>
              {isDone && <span className="pcard-done" title="Ready">✓</span>}
              <span className="pcard-score">
                <b>{p.score}</b>
                <span className="pcard-score-target">/{winScore}</span>
              </span>
              {canKick && (
                <button
                  className="pcard-kick"
                  title={`Remove ${p.name}`}
                  aria-label={`Remove ${p.name}`}
                  onClick={() => kick(p.id, p.name)}
                >
                  ✕
                </button>
              )}
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

function timerSummary(t: TimerConfig): string {
  const parts: string[] = [];
  if (t.clueSec) parts.push(`clue ${t.clueSec}s`);
  if (t.submitSec) parts.push(`submit ${t.submitSec}s`);
  if (t.voteSec) parts.push(`vote ${t.voteSec}s`);
  return parts.length ? parts.join(' · ') : 'off';
}

/** Host-only timer slider (used in the create-room form). */
function TimerSlider({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <span className="field-label">
        {label}: <b>{value === 0 ? 'off' : `${value}s`}</b>
      </span>
      <input
        className="slider"
        type="range"
        min={0}
        max={MAX_PHASE_SEC}
        step={5}
        value={value}
        disabled={disabled}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  );
}

// ---------- History panel (collapsed by default, at top) ----------
function HistoryPanel({ state }: { state: PrivateState }) {
  const [open, setOpen] = useState(false);
  const rounds = state.history ?? [];
  if (rounds.length === 0) return null;
  const playerName = (id: string) =>
    state.players.find(p => p.id === id)?.name ?? '?';
  return (
    <div className="history">
      <button
        className="history-bar"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <span>📜 History · {rounds.length} round{rounds.length === 1 ? '' : 's'}</span>
        <span className="muted" style={{ fontSize: 13 }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="history-body">
          {[...rounds].reverse().map(r => (
            <HistoryRound
              key={r.roundNumber ?? Math.random()}
              r={r}
              playerName={playerName}
              players={state.players}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HistoryRound({
  r,
  playerName,
  players,
}: {
  r: RoundReveal;
  playerName: (id: string) => string;
  players: { id: string; name: string }[];
}) {
  const [zoom, setZoom] = useState<string | null>(null);
  const storyteller = players.find(p => p.id === r.storytellerId) ?? {
    id: r.storytellerId,
    name: playerName(r.storytellerId),
  };
  return (
    <div className="history-round">
      <div className="history-round-head">
        <b>R{r.roundNumber ?? '?'}</b>
        <span className="muted">·</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Avatar player={storyteller} size={18} /> 🎙️ {storyteller.name}
        </span>
        <span className="muted">·</span>
        <span style={{ fontStyle: 'italic' }}>"{r.clue}"</span>
      </div>
      <div className="history-cards">
        {r.cards.map(c => {
          const isStory = c.cardId === r.storytellerCardId;
          return (
            <div
              key={c.cardId}
              className={'history-card' + (isStory ? ' story' : '')}
              onClick={() => setZoom(c.cardId)}
              title={`${playerName(c.ownerId)}${c.voterIds.length ? ' · voted by ' + c.voterIds.map(playerName).join(', ') : ''}`}
            >
              <img src={cardUrl(c.cardId)} alt="" />
              <div className="history-card-cap">
                {playerName(c.ownerId)}
                {c.voterIds.length > 0 && (
                  <span className="muted"> · {c.voterIds.length}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="history-deltas">
        {Object.entries(r.deltas)
          .filter(([, d]) => d > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([pid, d]) => (
            <span key={pid} className="pill" style={{ fontSize: 12 }}>
              {playerName(pid)} +{d}
            </span>
          ))}
      </div>
      <CardZoom cardId={zoom} onClose={() => setZoom(null)} />
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
  const [busy, setBusy] = useState(false);
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
    if (!picked || !clue.trim() || busy) return;
    setBusy(true);
    try {
      await callEmit('submitClue', { code: state.code, cardId: picked, clue });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
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
        <button className="btn" disabled={!picked || !clue.trim() || busy} onClick={submit}>
          {busy ? 'Sending…' : 'Give clue'}
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
  const [busy, setBusy] = useState(false);
  const me = state.players.find(p => p.id === state.you.id)!;

  const submit = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await callEmit('submitCard', { code: state.code, cardId: picked });
      setPicked(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
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
            disabled={!picked || busy}
            onClick={submit}
          >
            {busy ? 'Sending…' : 'Submit card'}
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
  const [zoom, setZoom] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const me = state.players.find(p => p.id === state.you.id)!;
  // The card I submitted is on the table; I can't vote it.
  const myOwnCard = state.you.isStoryteller ? null : findMyCardOnTable(state);

  const submit = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      await callEmit('submitVote', { code: state.code, cardId: picked });
      setPicked(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
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
              <button
                className="card-zoom-btn"
                title="Zoom"
                aria-label="Zoom card"
                onClick={e => {
                  e.stopPropagation();
                  setZoom(c.cardId);
                }}
              >
                🔍
              </button>
              {isMine && <div className="owner">your card</div>}
            </div>
          );
        })}
      </div>
      {!state.you.isStoryteller && !me.hasVoted && (
        <button
          className="btn"
          style={{ marginTop: 12 }}
          disabled={!picked || busy}
          onClick={submit}
        >
          {busy ? 'Sending…' : 'Cast vote'}
        </button>
      )}
      <CardZoom cardId={zoom} onClose={() => setZoom(null)} />
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
  const [zoom, setZoom] = useState<string | null>(null);
  // Stagger flip-in animation on enter.
  const [flippedSet, setFlippedSet] = useState<Set<string>>(new Set());
  useEffect(() => {
    setFlippedSet(new Set());
    const ids = reveal.cards.map(c => c.cardId);
    const timers: number[] = [];
    ids.forEach((id, i) => {
      const t = window.setTimeout(() => {
        setFlippedSet(prev => {
          const next = new Set(prev);
          next.add(id);
          return next;
        });
      }, 220 + i * 280);
      timers.push(t);
    });
    return () => timers.forEach(t => clearTimeout(t));
  }, [reveal.storytellerCardId, reveal.clue]);

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
        🎙️ {playerName(reveal.storytellerId)}'s card is highlighted
      </div>
      <div className="card-grid">
        {reveal.cards.map(c => {
          const isStory = c.cardId === reveal.storytellerCardId;
          const flipped = flippedSet.has(c.cardId);
          const owner = state.players.find(p => p.id === c.ownerId);
          return (
            <div
              key={c.cardId}
              className={'flip-card' + (flipped ? ' flipped' : '')}
              onClick={() => flipped && setZoom(c.cardId)}
              style={{ cursor: flipped ? 'zoom-in' : 'default' }}
            >
              <div className="flip-inner">
                <div className="flip-back">
                  <span className="flip-back-mark">✦</span>
                </div>
                <div className={'flip-front card' + (isStory ? ' story' : '')}>
                  <img src={cardUrl(c.cardId)} alt="" />
                  {owner && (
                    <div className="owner" style={{ borderLeft: `4px solid ${playerColor(owner.id)}` }}>
                      <Avatar player={owner} size={16} /> {owner.name}
                    </div>
                  )}
                  {c.voterIds.length > 0 && (
                    <div className="voters">
                      voted by {c.voterIds.map(playerName).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <ReactionsBar state={state} setError={setError} />

      <h3 style={{ marginTop: 16 }}>Scores</h3>
      {[...state.players]
        .sort((a, b) => b.score - a.score)
        .map(p => {
          const d = reveal.deltas[p.id] ?? 0;
          return (
            <div key={p.id} className="score-row">
              <Avatar player={p} size={20} />
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
      <CardZoom cardId={zoom} onClose={() => setZoom(null)} />
    </div>
  );
}

// ---------- Reactions ----------
function ReactionsBar({
  state,
  setError,
}: {
  state: PrivateState;
  setError: (m: string) => void;
}) {
  const send = async (emoji: string) => {
    try {
      buzz(40);
      await callEmit('react', { code: state.code, emoji });
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <div className="reactions-bar">
      {ALLOWED_REACTIONS.map(e => (
        <button
          key={e}
          className="reaction-btn"
          onClick={() => send(e)}
          aria-label={`React ${e}`}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

interface FloatingReaction {
  id: number;
  emoji: string;
  playerName: string;
  color: string;
  left: number; // %
}
function FloatingReactions({ state }: { state: PrivateState }) {
  const [items, setItems] = useState<FloatingReaction[]>([]);
  const counter = useRef(0);
  useEffect(() => {
    const onReact = (p: { playerId: string; emoji: string; ts: number }) => {
      const player = state.players.find(pp => pp.id === p.playerId);
      const id = ++counter.current;
      const it: FloatingReaction = {
        id,
        emoji: p.emoji,
        playerName: player?.name ?? '',
        color: playerColor(p.playerId),
        left: 10 + Math.random() * 70,
      };
      setItems(prev => [...prev, it]);
      window.setTimeout(() => {
        setItems(prev => prev.filter(x => x.id !== id));
      }, 1800);
    };
    socket.on('reaction', onReact);
    return () => {
      socket.off('reaction', onReact);
    };
  }, [state.players]);
  if (items.length === 0) return null;
  return (
    <div className="floating-reactions" aria-hidden>
      {items.map(it => (
        <div
          key={it.id}
          className="floating-reaction"
          style={{ left: `${it.left}%` }}
        >
          <span className="floating-reaction-emoji">{it.emoji}</span>
          <span
            className="floating-reaction-name"
            style={{ background: it.color }}
          >
            {it.playerName}
          </span>
        </div>
      ))}
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
  const share = async () => {
    try {
      const blob = await renderShareImage(state);
      if (!blob) return setError('Could not generate image');
      const file = new File([blob], 'dixit-results.png', { type: 'image/png' });
      const nav = navigator as any;
      if (nav.canShare?.({ files: [file] })) {
        await nav.share({
          files: [file],
          title: 'Dixit results',
          text: `🎨 Dixit — winner: ${winners.map(w => w.name).join(', ')}`,
        });
        return;
      }
      // Fallback: download
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dixit-results.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e: any) {
      // Swallow user-cancel from Web Share API
      if (e?.name === 'AbortError') return;
      setError(e.message ?? 'Share failed');
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
            <Avatar player={p} size={20} />
            <span>{p.name}</span>
            <span className="spacer" />
            <span style={{ fontWeight: 700 }}>{p.score}</span>
          </div>
        ))}
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn secondary" onClick={share}>
          📤 Share results
        </button>
        <span className="spacer" />
        {state.you.isHost ? (
          <button className="btn" onClick={again}>
            Play again
          </button>
        ) : (
          <p className="muted">Waiting for host…</p>
        )}
      </div>
    </div>
  );
}

/** Draw a shareable summary PNG of the final scores. */
async function renderShareImage(state: PrivateState): Promise<Blob | null> {
  const W = 1080;
  const headerH = 180;
  const rowH = 88;
  const padding = 56;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const H = headerH + sorted.length * rowH + padding * 2 + 80;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#312e81');
  bg.addColorStop(1, '#0f172a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 64px Georgia, serif';
  ctx.textAlign = 'left';
  ctx.fillText('🎨 Dixit', padding, padding + 60);
  ctx.fillStyle = '#94a3b8';
  ctx.font = '28px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(`Room ${state.code} · ${state.history.length} rounds`, padding, padding + 110);

  // Winner badge
  const winners = sorted.filter(p => state.winnerIds.includes(p.id));
  ctx.fillStyle = '#fde68a';
  ctx.font = 'bold 36px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'right';
  const winnerText =
    winners.length > 1
      ? `🏆 ${winners.map(w => w.name).join(' & ')}`
      : `🏆 ${winners[0]?.name ?? '—'}`;
  ctx.fillText(winnerText, W - padding, padding + 80);

  // Score rows
  let y = headerH + padding;
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const isWinner = state.winnerIds.includes(p.id);
    const rowY = y + i * rowH;
    // Row background
    ctx.fillStyle = isWinner ? 'rgba(253, 230, 138, 0.12)' : 'rgba(30, 41, 59, 0.6)';
    roundRect(ctx, padding, rowY, W - padding * 2, rowH - 14, 18);
    ctx.fill();

    // Avatar circle
    ctx.fillStyle = playerColor(p.id);
    ctx.beginPath();
    ctx.arc(padding + 44, rowY + (rowH - 14) / 2, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 28px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(playerInitial(p.name), padding + 44, rowY + (rowH - 14) / 2 + 1);

    // Rank
    ctx.fillStyle = '#94a3b8';
    ctx.font = 'bold 26px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`#${i + 1}`, padding + 90, rowY + (rowH - 14) / 2);

    // Name
    ctx.fillStyle = '#f8fafc';
    ctx.font = '32px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(p.name, padding + 150, rowY + (rowH - 14) / 2);

    // Score
    ctx.fillStyle = isWinner ? '#fde68a' : '#f8fafc';
    ctx.font = 'bold 44px -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(String(p.score), W - padding - 24, rowY + (rowH - 14) / 2);
  }

  // Footer
  ctx.fillStyle = '#64748b';
  ctx.font = '22px -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(
    `First to ${state.winScore} · ${state.players.length} players`,
    W / 2,
    H - padding / 1.5,
  );

  return await new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/png'));
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
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
  const [zoom, setZoom] = useState<string | null>(null);
  return (
    <>
      <div className="card-grid">
        {cards.map(c => (
          <div
            key={c}
            className={'card' + (selected === c ? ' selected' : '') + (onPick ? '' : ' disabled')}
            onClick={() => onPick?.(c)}
          >
            <img src={cardUrl(c)} alt="" />
            <button
              className="card-zoom-btn"
              title="Zoom"
              aria-label="Zoom card"
              onClick={e => {
                e.stopPropagation();
                setZoom(c);
              }}
            >
              🔍
            </button>
          </div>
        ))}
      </div>
      <CardZoom cardId={zoom} onClose={() => setZoom(null)} />
    </>
  );
}

// ---------- Card zoom lightbox ----------
function CardZoom({
  cardId,
  onClose,
}: {
  cardId: string | null;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!cardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cardId, onClose]);
  if (!cardId) return null;
  return (
    <div className="zoom-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <img src={cardUrl(cardId)} alt="" />
    </div>
  );
}

// ---------- Game alerts (audio + vibration + info toast) ----------
function useGameAlerts(state: PrivateState | null) {
  const prev = useRef<{
    phase?: string;
    round?: number;
    storytellerId?: string | null;
    youId?: string;
  }>({});
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!state) {
      prev.current = {};
      return;
    }
    const p = prev.current;
    const youChanged = p.youId !== state.you.id;
    const phaseChanged =
      youChanged ||
      p.phase !== state.phase ||
      p.round !== state.roundNumber ||
      p.storytellerId !== state.storytellerId;

    if (phaseChanged && !youChanged) {
      if (state.phase === 'CLUE' && state.you.isStoryteller) {
        sounds.yourTurn();
        buzz([140, 80, 140]);
        setInfo("🎙️ You're the storyteller — pick a card and give a clue!");
      } else if (state.phase === 'SUBMIT' && !state.you.isStoryteller) {
        sounds.phaseAdvance();
        buzz(120);
        setInfo('🃏 Pick a card from your hand that fits the clue.');
      } else if (state.phase === 'VOTE' && !state.you.isStoryteller) {
        sounds.phaseAdvance();
        buzz(120);
        setInfo("🗳️ Vote — which card is the storyteller's?");
      } else if (state.phase === 'REVEAL') {
        sounds.reveal();
        buzz([60, 50, 60]);
      } else if (state.phase === 'GAME_OVER') {
        const won = state.winnerIds.includes(state.you.id);
        if (won) {
          sounds.victory();
          buzz([200, 100, 200, 100, 400]);
          setInfo('🏆 You won! ');
        } else {
          sounds.gameOverSoft();
          buzz(200);
        }
      }
    }

    prev.current = {
      phase: state.phase,
      round: state.roundNumber,
      storytellerId: state.storytellerId,
      youId: state.you.id,
    };
  }, [
    state?.phase,
    state?.roundNumber,
    state?.storytellerId,
    state?.you?.id,
    state?.you?.isStoryteller,
    state?.winnerIds,
  ]);

  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => setInfo(null), 5000);
    return () => clearTimeout(t);
  }, [info]);

  // Periodic gentle buzz while it's the local player's turn to do something.
  // Fires every 5s until the phase advances or the player acts.
  useEffect(() => {
    if (!state) return;
    const me = state.players.find(p => p.id === state.you.id);
    if (!me) return;
    let needsAction = false;
    if (state.phase === 'CLUE' && state.you.isStoryteller) needsAction = true;
    else if (state.phase === 'SUBMIT' && !state.you.isStoryteller && !me.hasSubmitted) needsAction = true;
    else if (state.phase === 'VOTE' && !state.you.isStoryteller && !me.hasVoted) needsAction = true;
    if (!needsAction) return;
    const id = setInterval(() => buzz(60), 5000);
    return () => clearInterval(id);
  }, [
    state?.phase,
    state?.roundNumber,
    state?.you?.id,
    state?.you?.isStoryteller,
    // re-evaluate when our hasSubmitted / hasVoted flips
    state?.players.find(p => p.id === state?.you?.id)?.hasSubmitted,
    state?.players.find(p => p.id === state?.you?.id)?.hasVoted,
  ]);

  return { info, dismissInfo: () => setInfo(null) };
}

