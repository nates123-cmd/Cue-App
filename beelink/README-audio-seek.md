# Audio-seek: bridge side of "resume in audio"

Cue's Kindle-compatible read→listen handoff. You read the ebook on a Kindle, paste
the last line into Cue, and the audiobook (in Audiobookshelf) jumps to that spot.

## Flow
1. Cue searches the aligned transcript (`book_transcripts`) client-side → timestamp.
2. Cue inserts `audio_seek_requests {abs_item_id, current_time_sec, book_title}`.
3. `bridge.py` → `process_seeks()` (called each `tick()`, ~20s) polls pending rows and
   `PATCH /api/me/progress/:absItemId {currentTime}` on Audiobookshelf, then marks the
   row `done` / `failed`.

Same outbox pattern as `media_requests` — phone → Supabase (HTTPS) → box → ABS, so the
PWA never touches the tailnet-only ABS directly (no mixed-content).

## bridge.env additions
```
ABS_URL=http://localhost:13378        # Audiobookshelf, local to the box
ABS_TOKEN=<root user API token>       # sqlite: SELECT token FROM users WHERE username='root'
```
Blank `ABS_TOKEN` = feature off (rows just sit pending). chmod 600 bridge.env.

## Deploy
`scp beelink/bridge.py nate@<box>:~/media-bridge/bridge.py` then
`ssh <box> 'kill $(systemctl show media-bridge -p MainPID --value)'` (systemd respawns, no sudo).

## Note on this copy
`bridge.py` here is the **currently deployed** box version (book-routing + Libgen +
Kindle-email + this seek handler). It supersedes the older copy on the unmerged
`worktree-book-routing` branch (PR #6); reconcile when that lands.

## Pending
- `book_transcripts` table + the Storyteller→transcript extractor are NOT built yet —
  they need a book aligned in Storyteller first. Until then `loadTranscript()` returns
  null and the Cue sheet says "no synced transcript yet."
- `process_seeks()` requires `abs_item_id` (carried on the transcript row). No title
  fallback yet.
