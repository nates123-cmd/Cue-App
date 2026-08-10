---
name: media-stack
description: >
  Check and steer Nate's home media stack (Jellyfin, Sonarr, Radarr, Prowlarr,
  qBittorrent behind the VPN). Use this for "what's downloading", "is anything
  stuck", "why is X taking so long", "that's the wrong file, get a better one",
  "is season 3 done yet", "what am I waiting on" / "what's still missing" when
  the subject is shows, movies or books, and container health or logs. Talks to
  a bearer-gated local helper; never touches Docker or the *arr APIs directly.
  SCOPE: downloads and media only. Questions about tasks, projects, meetings or
  the inbox belong to course-plus, not here -- "waiting on" a person or a
  deliverable is never this skill. If it is genuinely unclear which is meant,
  ask which one rather than answering from both.
---

# Media stack

All calls go to the local helper at `$MEDIA_HELPER_URL` with
`Authorization: Bearer $OPENCLAW_MEDIA_SECRET`. Both are in the environment.
There is no `jq` in this container. Use `node -e` to parse JSON.

Only these seven container names exist: gluetun, qbittorrent, flaresolverr,
prowlarr, sonarr, radarr, jellyfin.

## Reading

**What is downloading right now**
```sh
curl -s -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" "$MEDIA_HELPER_URL/torrents"
```
Each torrent has `name`, `state`, `progress`, `num_seeds`, `dlspeed`, `eta`.
`state` is the tell:
- `downloading` — healthy.
- `metaDL` — the magnet cannot even fetch its file list. Dead unless it moves within ~10 minutes.
- `queuedDL` — waiting for a slot. Only a problem if nothing else is progressing.
- `stalledDL` — connected to nobody. Almost always dead.
- `stoppedUP` — finished. Seeding is off by design, so this means done, not stuck.

**What Sonarr/Radarr think is in flight**
```sh
curl -s -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" "$MEDIA_HELPER_URL/queue"
```
`stuck` counts rows sitting at 0%. Report `title`, `pct`, `eta`, `error`.

**What is still owed but not downloading**
```sh
curl -s -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" "$MEDIA_HELPER_URL/wanted"
```
Check this whenever `/torrents` and `/queue` come back empty. An empty queue does
not mean nothing is pending: it usually means Sonarr wants episodes it has not
managed to grab. "Nothing is downloading, but you are still waiting on 3
episodes" is the useful answer; "nothing is downloading" alone is not.

Finished torrents linger in qBittorrent on purpose (seeding is off, so they sit
at `stoppedUP` forever). **Never present those as things that are downloading.**
If every torrent is `stoppedUP`, the correct answer is "nothing is downloading
right now", followed by what `/wanted` says is still outstanding.

**Container health / logs**
```sh
curl -s -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" "$MEDIA_HELPER_URL/status"
curl -s -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" "$MEDIA_HELPER_URL/logs?name=sonarr&tail=80"
```

## Picking a better file

When Nate says a download is too slow or the wrong version, show him the
alternatives and let him choose. Do not silently swap.

**1. List candidates** (seeders first; `ok:false` means Sonarr would reject it)
```sh
curl -s -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" \
  "$MEDIA_HELPER_URL/releases?series=Sweethearts&season=3&episode=3"
curl -s -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" \
  "$MEDIA_HELPER_URL/releases?movie=Tenet"
```
`series`/`movie` is a substring match. If it matches more than one thing the
helper returns 409 with a `candidates` list: ask Nate which one, do not guess.

Present them as a short numbered list: seeders, size, quality, and the release
name. **Seeders are what matter**, but read them sceptically: Knaben's counts
are unreliable and routinely understate a swarm. Prefer a release another
indexer also lists.

The VPN forwards a port (AirVPN, 9199), so incoming connections work and small
swarms are far more viable than they used to be. A single-digit-seeder release
is no longer automatically doomed. If something still will not move, the
problem is that specific swarm, not the connection.

**2. Grab the one he picks**
```sh
curl -s -X POST -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" \
  -H 'content-type: application/json' \
  -d "$(node -e 'console.log(JSON.stringify({app:"sonarr",guid:process.argv[1],indexerId:Number(process.argv[2])}))' "$GUID" "$IDX")" \
  "$MEDIA_HELPER_URL/pick"
```
`app`, `guid` and `indexerId` all come from the `/releases` response. Never
invent them.

**3. Bin something that is going nowhere**
```sh
curl -s -X POST -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" \
  -H 'content-type: application/json' \
  -d '{"app":"sonarr","id":123,"research":true}' \
  "$MEDIA_HELPER_URL/drop"
```
`id` is the queue row id from `/queue`. This blocklists the release so it will
not come back. `research:true` makes Sonarr look for a replacement; use
`false` when the whole grab was wrong (wrong show entirely) and a re-search
would just fetch more of the same.

## Restarting

```sh
curl -s -X POST -H "Authorization: Bearer $OPENCLAW_MEDIA_SECRET" \
  -H 'content-type: application/json' -d '{"name":"qbittorrent"}' "$MEDIA_HELPER_URL/restart"
```
Confirm with Nate before restarting anything. Restarting `gluetun` drops the
VPN and every torrent with it.

## Talking to Nate about this

Answer in plain language, not JSON. "Season 3 is done, all 7 episodes" beats a
dump of torrent objects. Lead with the answer, then the detail he needs to
decide something.

A watchdog already pushes him a Telegram message when it drops a dead download
and when a show becomes ready to watch, so he may be replying to one of those.
If he says "that one" without naming it, check `/queue` and `/torrents` for
what changed most recently rather than asking him to repeat himself.

Never claim something is downloading because it is in the queue. Check
`progress` and `state`. A row at 0% for hours is not downloading.
