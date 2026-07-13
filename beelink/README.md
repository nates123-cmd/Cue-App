# media-bridge

The daemon that drains Cue's `media_requests` outbox on the Beelink.

Cue inserts a row (`Push to Radarr` / `Push to Sonarr` / `Push to Prowler`); this
daemon polls Supabase from the Beelink, adds the title to the right downloader,
and writes live progress back onto the same row so Cue's download tray can render
it. Nothing inbound is exposed — the box reaches out.

**This file is the source of truth.** It is deployed to `~/media-bridge/bridge.py`
on the Beelink, which is NOT a git repo, so edit here and copy it up.

## Routing

| `media_type` | Goes to | How |
|---|---|---|
| `movie` | Radarr | `movie/lookup` → add → Radarr grabs |
| `tv` | Sonarr | `series/lookup` → add → Sonarr grabs |
| `book` | Prowlarr + qBittorrent | bridge searches, picks, grabs, and imports itself |

Books have no *arr on this box: Readarr is archived upstream, and Prowlarr is only
an indexer manager — it cannot download. So for a book the bridge does the whole
job an *arr would: search Prowlarr, pick a release, hand it to qBittorrent, then
hardlink the finished files into the library. It grabs **both** an ebook and an
audiobook when both are available.

- ebooks → `/srv/media/data/media/ebooks` (mounted into Audiobookshelf as `/ebooks`)
- audiobooks → `/srv/media/data/media/audiobooks`

Files are **hardlinked**, not moved, so the torrent keeps seeding.

## Landmines

1. **Prowlarr's download urls are proxied** (`http://localhost:9696/<n>/download?apikey=…`).
   qBittorrent runs inside gluetun's network namespace, where `localhost` is not
   Prowlarr — handing that url to qbit silently fails (`success_count: 0`, no error).
   The bridge fetches the .torrent itself and POSTs the bytes, which is exactly what
   Radarr/Sonarr do.
2. **A qBittorrent category's save path must be under `/data/torrents`** — that is the
   only volume qbit has mounted. The pre-existing `audiobooks` category pointed at
   `/data/media/audiobooks`, which does not exist in the container, so anything it
   grabbed vanished into the container's ephemeral layer. That is why books never
   worked before.
3. **This file defines a function named `http()`**, which shadows the stdlib `http`
   package. Import `from http.cookiejar import CookieJar`, never `import http.cookiejar`.
4. **Restarting needs no sudo** — the unit is `User=nate` + `Restart=always`:
   `ssh nate@100.111.77.98 'kill $(systemctl show media-bridge -p MainPID --value)'`

## Deploy

```sh
scp beelink/bridge.py nate@100.111.77.98:/tmp/bridge.py
ssh nate@100.111.77.98 'python3 -m py_compile /tmp/bridge.py \
  && cp /tmp/bridge.py ~/media-bridge/bridge.py \
  && kill $(systemctl show media-bridge -p MainPID --value)'
```

## Config

`~/media-bridge/bridge.env` (chmod 600, not in git) holds `SUPABASE_*`, `RADARR_*`,
`SONARR_*`, `PROWLARR_*`, `QBIT_*`, and the book paths (`BOOK_CATEGORY`,
`BOOK_SAVE_CT`, `TORRENT_HOST_DIR`, `AUDIOBOOK_DIR`, `EBOOK_DIR`).
