# Beelink daemons (version-controlled copies)

Two stdlib-only Python daemons that live on the Beelink and do the work Cue's
push buttons ask for. They run there, not here — this directory is the copy of
record, because for a long time these files existed *only* on the box.

| File | Runs as | On the box | What it owns |
|---|---|---|---|
| `bridge.py` | `media-bridge.service` (`User=nate`) | `/home/nate/media-bridge/bridge.py` | acquisition: `media_requests` → Radarr / Sonarr / (books) Prowlarr+qBittorrent, import, Kindle email |
| `reading-sync-poller.py` | `reading-sync.service` (**user** unit) | `/home/nate/apps/reading-sync/poller.py` | reading position: `reading_sync_requests` → kosync (X4) + Audiobookshelf, ebook catalog, the `place` fulfillment leg |

Config is `bridge.env` / `reading-sync.env` on the box (chmod 600, service keys
and the Gmail app password). Neither file is in this repo and neither should be.

## Deploy

```sh
scp beelink/bridge.py nate@100.111.77.98:/home/nate/media-bridge/bridge.py
ssh nate@100.111.77.98 'kill $(systemctl show media-bridge -p MainPID --value)'

scp beelink/reading-sync-poller.py nate@100.111.77.98:/home/nate/apps/reading-sync/poller.py
ssh nate@100.111.77.98 'systemctl --user restart reading-sync'
```

**Do not reach for `sudo systemctl restart media-bridge`.** The unit is
`User=nate` + `Restart=always`, so killing the process is enough and systemd
respawns it on the new file in ~10s — and `!`-prefixed shell has no TTY, so
sudo just fails with "a terminal is required". `reading-sync` is a *user* unit
(`systemctl --user`), lingering is already on.

Both files are pure stdlib on purpose: the box has no venv and no pip for them,
and adding one would make a routine deploy a dependency problem.

## Routing table

| `media_requests.media_type` | Handler | Lands in |
|---|---|---|
| `movie` | Radarr (tmdb lookup) | `/srv/media/data/media/movies` |
| `tv` | Sonarr (title+year lookup) | `/srv/media/data/media/shows` |
| `book` | Prowlarr search → qBittorrent, **or** Libgen direct download | ebook `…/media/ebooks`, audiobook `…/media/audiobooks` |

There is **no \*arr for books** — Readarr is archived upstream and Prowlarr is
only an indexer manager, so `bridge.py` does the whole job itself: search, rank,
hand the .torrent *bytes* to qBittorrent, hardlink the result into the library.

## What one book push now does

1. `add_book` searches Prowlarr for an ebook **and** an audiobook. No ebook
   torrent (common — trackers barely carry recent nonfiction) → Libgen direct
   download, which takes seconds instead of hours.
2. `monitor_books` imports each finished torrent (hardlink, so it keeps seeding).
3. The epub is repaired (`<dc:language>` + charset declarations, or Amazon
   silently drops it) and emailed to the Kindle, exactly once.
4. **New:** the moment the epub is on disk, `kick_cwa_ingest()` runs the same
   sweep the 10-minute cron runs, so the OPDS shelf the X4 pulls from has the
   book in seconds. It takes the same `flock`, so racing the cron is a no-op.
5. **New:** the `place` leg is marked pending, and `reading-sync-poller.py`
   flips it to ready once it has actually parsed and indexed the epub and
   published it to `reading_books` — which is what lets the Place PWA push a
   reading position to the X4.

Each step stamps `recommendations.fulfillment` (see the migration
`20260731000001_recommendations_fulfillment.sql`) so the Cue card carries a
sticky answer long after the download tray has forgotten the push. The two
daemons share that column and **only ever merge their own legs** — `bridge.py`
owns `ebook`/`audiobook`/`download`, the poller owns `place`.

## Landmines

- **Prowlarr seeder counts are stale.** They're scraped off the indexer page,
  not live swarm state — a release advertising 7 seeders can have zero. Trust
  qBittorrent's `num_complete`. `reap_stalled_books()` re-grabs a different
  release after `BOOK_STALL_GRACE` (default 1800s) and marks the leg dead when
  nothing live is left; the card now shows that as "Audiobook failed" instead of
  letting a successful ebook mask it.
- **Prowlarr download URLs are proxied through `localhost:9696`**, and
  qBittorrent runs inside gluetun's network namespace where `localhost` is not
  Prowlarr. Handing qbit that URL fails *silently* (`success_count: 0`). Fetch
  the bytes here and POST them (plus a magnet-redirect catcher).
- **A qbit category's savePath must be under `/data/torrents`** — the only
  volume qbit mounts. Anything else writes into the container's ephemeral layer
  and never reaches the host.
- **`bridge.py` defines a function named `http()`**, which shadows the stdlib
  `http` package. `from http.cookiejar import CookieJar`, never
  `import http.cookiejar`.
- **Read-modify-write on `media_requests.detail` races the tick loop.** Stop the
  service before hand-editing that JSON, or an in-flight tick will overwrite you
  (this is how a book got emailed to the Kindle twice).

## OpenClaw media skill (added 2026-08-10)

Steering downloads from the phone. Same "copy of record" rule as above: these
run on the box, this directory is the version-controlled copy.

| File | On the box | What it owns |
|---|---|---|
| `media_helper.py` | `/opt/media-helper/media_helper.py`, `media-helper.service` (root-installed, bearer-gated, binds the Tailscale IP) | `/status` `/logs` `/restart` `/torrents` `/queue` `/wanted` `/releases` `/pick` `/drop` for the seven whitelisted media containers |
| `openclaw-media-stack-SKILL.md` | `/home/openclaw/.openclaw/skills/media-stack/SKILL.md` | what the Telegram bot knows about downloads |
| `install-dl-skill.sh` | `~/install-dl-skill.sh` | installs both of the above; run `sudo bash ~/install-dl-skill.sh` |

`pick` and `drop` only accept identifiers `/releases` and `/queue` just handed
out, so the agent cannot reach anything it was not shown. Credentials are read
from `bridge.env` / `/etc/media-helper.env` at runtime and are never in git.

Editing the skill means re-running the installer: the file is bind-mounted, so
the gateway needs a `docker compose restart` to re-read it, which the installer
does.
