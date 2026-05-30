# Dixit (web)

A mobile-friendly, real-time, Dixit-inspired party game for 3–6 friends.

- **Server**: Node + Express + Socket.IO (TypeScript)
- **Client**: React + Vite (TypeScript)
- **Cards**: 80 procedurally-generated abstract SVGs (drop in your own AI-generated set later)
- **Rules**: official Dixit scoring, 30-point win, host advances rounds, rematch keeps the room.

## Setup

```powershell
npm install
npm run gen:cards    # generates 80 placeholder cards under client/public/cards
npm run dev          # starts server (:3001) + Vite client (:5173)
```

Open http://localhost:5173 on your laptop and on each phone connected to the same Wi-Fi (use the LAN IP shown by Vite). One person clicks **Create room**, picks a player count (3–6), and shares the room code or invite link.

## Build & run for production

```powershell
npm run build
npm start            # serves both client and websocket on :3001
```

## Deploy (Render — recommended)

1. Push this folder to a GitHub repo.
2. On https://render.com, click **New → Blueprint** and pick the repo. `render.yaml` and the `Dockerfile` are already configured.
3. Render builds the Docker image, generates the cards, and serves everything on a public URL.
4. Share that URL with your friends. They open it on their phones, enter a name, and you're playing.

Free Render web services sleep after inactivity; first request after a nap takes ~30s to wake up.

## Replacing the card art

The deck is whatever `client/public/cards/manifest.json` references. To use your own AI-generated images:

1. Generate ~80+ images (PNG/JPG/SVG), all the same aspect ratio (2:3 looks best).
2. Place them in `client/public/cards/` (e.g. `myart-001.svg`).
3. Edit `manifest.json` to list all the ids, e.g. `{ "cards": ["myart-001", "myart-002", ...] }`.
4. Rebuild and redeploy.

## How a round works

1. **Storyteller** picks a card from their hand and types a clue (a word, phrase, or song lyric).
2. **Other players** each pick a card from their own hand that could match the clue.
3. All cards are shuffled and shown face-up.
4. Non-storytellers **vote** for which card they think is the storyteller's.
5. **Scoring**:
   - If everyone or no one finds the storyteller's card → storyteller scores 0, everyone else +2.
   - Otherwise → storyteller and correct guessers +3 each.
   - Plus +1 per vote any non-storyteller's card attracted.
6. Everyone draws back up to 6. First to **30** wins.

## Reconnect

Each player's session is stored in `localStorage`. If your phone screen locks or you refresh, you'll automatically rejoin the same seat with your hand and score intact.

## AI bots & per-card clues

Bots can fill empty seats. Their behaviour is driven by a **per-card
dictionary** at `server/data/cardClues.json`. For every card image the
generator stores two things:

- `clues` — 5 evocative storyteller lines (used when this card is chosen).
- `tags` — 20–30 lowercase concept/synonym words (objects, mood, archetypes,
  e.g. for a monster card: `beast, monster, creature, fangs, claws, predator,
  fear, danger, shadow, nightmare, …`). These tags are what the bot scores
  free-form clues against.

Matching logic (in `server/src/cardClues.ts`):

- Tokenise the clue, drop stop-words, apply light stemming (`beasts` → `beast`).
- For each clue token, **+3** if it appears in a card's tags, **+1.5** for a
  short prefix overlap (`lighthouse` ↔ `lighthouses`), **+1** if it appears
  inside the curated clue lines.
- Highest-scoring card wins (random tie-break). With no curated data the bot
  falls back to random + a generic poetic clue.

This means a single-word clue like **"beast"** will hit any card whose tags
include `beast`, `monster`, `creature`, `demon`, etc. — exactly what was
missing in the original random implementation.

### (Re)generate the dictionary

Run a one-time vision pass over `client/public/cards/*.png`:

```powershell
# Free option (recommended): get a key at https://aistudio.google.com/apikey
$env:GEMINI_API_KEY = "YOUR_KEY"
npm run clues:generate

# Or OpenAI:
$env:OPENAI_API_KEY = "YOUR_KEY"
npm run clues:generate

# Options:
node scripts/generateClues.mjs --force                 # overwrite existing entries
node scripts/generateClues.mjs --only=card-001,card-007
node scripts/generateClues.mjs --concurrency=4
node scripts/generateClues.mjs --model=gemini-2.0-flash
```

The script is resumable: cards that already have ≥5 clues **and** ≥10 tags
are skipped unless you pass `--force`. Results stream into
`server/data/cardClues.json`. After regenerating, restart the server.

The on-disk format is:

```json
{
  "card-001": {
    "clues": ["the hungry shadow", "caught by the monster", "..."],
    "tags":  ["beast","monster","creature","fangs","claws","predator","fear","..."]
  }
}
```

The legacy array-only shape (`["clue1","clue2",...]`) is still loaded for
backward compatibility — but you'll get far better matching with the new
schema, so re-run the generator with `--force` if you have older data.



