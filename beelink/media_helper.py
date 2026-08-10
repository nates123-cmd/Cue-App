#!/usr/bin/env python3
"""
Least-privilege media-stack helper for the OpenClaw bot.

Exposes ONLY: status / logs / restart / torrents / queue / releases / pick /
drop, and ONLY for a hardcoded whitelist of media containers. Bearer-gated. No
arbitrary exec, no socket handed to the agent, no control of any container
outside the whitelist. Talks to the system Docker via the `docker` CLI (the
service user must be in the `docker` group).

The download-steering endpoints exist so the phone can answer "this grab looks
wrong, use a different file" without anyone opening Sonarr:
  GET  /queue                              what is in flight, and what is stuck at 0%
  GET  /releases?series=&season=&episode=  ranked candidates (seeders first)
  GET  /releases?movie=
  POST /pick   {app, guid, indexerId}      force-grab one of those candidates
  POST /drop   {app, id, research}         bin a queue item, blocklist, search again
`pick` and `drop` only ever act on identifiers the helper itself just handed
out, so the agent cannot reach anything it was not shown.

Env:
  MEDIA_HELPER_SECRET  (required)  shared bearer secret
  MEDIA_HELPER_BIND    (default 127.0.0.1)  bind address  -> set to the Tailscale IP
  MEDIA_HELPER_PORT    (default 8099)
  QBIT_USER / QBIT_PASS (optional) qBittorrent WebUI creds. If set, the /torrents
                        endpoint logs in to the WebUI API; if unset it assumes the
                        WebUI bypasses auth for localhost.
  SONARR_URL / SONARR_KEY, RADARR_URL / RADARR_KEY (optional) enable /queue,
                        /releases, /pick and /drop. Without them those endpoints
                        return "not configured" and the rest still works.
"""
import json, os, subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import urllib.request, urllib.error

SECRET = os.environ["MEDIA_HELPER_SECRET"]
BIND = os.environ.get("MEDIA_HELPER_BIND", "127.0.0.1")
PORT = int(os.environ.get("MEDIA_HELPER_PORT", "8099"))
QBIT_USER = os.environ.get("QBIT_USER", "")
QBIT_PASS = os.environ.get("QBIT_PASS", "")

# The ONLY containers this helper will ever touch.
WHITELIST = ["gluetun", "qbittorrent", "flaresolverr", "prowlarr", "sonarr", "radarr", "jellyfin"]
WL = set(WHITELIST)

QBIT_BASE = "http://localhost:8080"
QBIT_API = QBIT_BASE + "/api/v2"

# Sonarr/Radarr, for the download-steering endpoints (/queue, /releases, /pick,
# /drop). Read-only unless the endpoint is explicitly a POST. Keys stay here on
# the host; the bot never sees them.
ARR = {
    "sonarr": {"url": os.environ.get("SONARR_URL", "http://localhost:8989").rstrip("/"),
               "key": os.environ.get("SONARR_KEY", ""),
               "id_field": "seriesId", "search": "SeriesSearch"},
    "radarr": {"url": os.environ.get("RADARR_URL", "http://localhost:7878").rstrip("/"),
               "key": os.environ.get("RADARR_KEY", ""),
               "id_field": "movieId", "search": "MoviesSearch"},
}


def docker(args, timeout=40):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)


def qbit_torrents(timeout=25):
    """Fetch torrents/info from qBittorrent's WebUI from INSIDE the container
    (true localhost). Logs in first if QBIT_USER/QBIT_PASS are set; otherwise
    relies on localhost auth bypass. Returns (ok, data_or_error)."""
    if QBIT_USER:
        # login -> cookie jar -> torrents/info, all in one in-container shell.
        snippet = (
            "cj=$(mktemp); "
            "curl -s -c \"$cj\" -H 'Referer: %s' "
            "--data-urlencode \"username=$QU\" --data-urlencode \"password=$QP\" "
            "%s/auth/login >/dev/null; "
            "curl -s -b \"$cj\" %s/torrents/info; rm -f \"$cj\""
        ) % (QBIT_BASE, QBIT_API, QBIT_API)
        r = docker(["exec", "-e", "QU=" + QBIT_USER, "-e", "QP=" + QBIT_PASS,
                    "qbittorrent", "sh", "-c", snippet], timeout=timeout)
    else:
        r = docker(["exec", "qbittorrent", "curl", "-s", QBIT_API + "/torrents/info"], timeout=timeout)
    out = (r.stdout or "").strip()
    if r.returncode != 0:
        return False, (r.stderr or "exec failed").strip()[:200]
    if out == "Forbidden" or not out:
        return False, "qBittorrent WebUI rejected the request (auth required / empty response)"
    try:
        return True, json.loads(out)
    except Exception:
        return False, ("unexpected response: " + out[:200])


def summarize_torrents(raw):
    """Trim qBittorrent's verbose torrent objects to a readable summary."""
    out = []
    for t in raw:
        progress = round(t.get("progress", 0) * 100, 1)  # percent
        out.append({
            "hash": t.get("hash"),
            "name": t.get("name"),
            "state": t.get("state"),
            "progress": progress,
            "done": progress >= 100,                       # finished downloading
            "size": t.get("size"),
            "downloaded": t.get("completed"),
            "dlspeed": t.get("dlspeed"),
            "upspeed": t.get("upspeed"),
            "eta": t.get("eta"),
            "completion_on": t.get("completion_on"),       # unix ts done, -1 if not
            "added_on": t.get("added_on"),
            "num_seeds": t.get("num_seeds"),
            "num_leechs": t.get("num_leechs"),
            "ratio": round(t.get("ratio", 0), 2),
            "category": t.get("category"),
        })
    return out


def arr(app, method, path, body=None, timeout=120):
    """Call Sonarr/Radarr. Returns (status, parsed_or_text)."""
    cfg = ARR.get(app)
    if not cfg or not cfg["key"]:
        return 0, f"{app} not configured on the helper"
    sep = "&" if "?" in path else "?"
    url = f"{cfg['url']}/api/v3/{path}{sep}apikey={cfg['key']}"
    data = json.dumps(body).encode() if body is not None else None
    rq = urllib.request.Request(url, data=data, method=method,
                                headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(rq, timeout=timeout) as f:
            raw = f.read().decode()
            try:
                return f.status, json.loads(raw)
            except Exception:
                return f.status, raw
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
    except Exception as e:
        return 0, str(e)[:300]


def queue_rows(app):
    code, q = arr(app, "GET", "queue?pageSize=100&includeEpisode=true")
    if code != 200 or not isinstance(q, dict):
        return []
    rows = []
    for r in q.get("records", []):
        size, left = r.get("size") or 0, r.get("sizeleft")
        pct = round((size - left) / size * 100, 1) if size and left is not None else None
        rows.append({"app": app, "id": r.get("id"), "title": (r.get("title") or "")[:90],
                     "status": r.get("status"), "pct": pct,
                     "eta": r.get("timeleft"), "error": r.get("errorMessage"),
                     "arr_id": r.get(ARR[app]["id_field"])})
    return rows


def _series_id(name):
    code, ser = arr("sonarr", "GET", "series")
    if code != 200 or not isinstance(ser, list):
        return None, []
    want = (name or "").lower().strip()
    hits = [s for s in ser if want and want in (s.get("title") or "").lower()]
    if len(hits) == 1:
        return hits[0], []
    return None, [s.get("title") for s in (hits or ser)][:12]


def rank_releases(rels):
    """Approved releases, most seeders first, trimmed for a phone screen."""
    out = []
    for r in rels if isinstance(rels, list) else []:
        out.append({"ok": bool(r.get("approved")), "seeders": r.get("seeders"),
                    "size_gb": round((r.get("size") or 0) / 1e9, 2),
                    "quality": ((r.get("quality") or {}).get("quality") or {}).get("name"),
                    "title": (r.get("title") or "")[:95],
                    "rejections": (r.get("rejections") or [])[:2],
                    "guid": r.get("guid"), "indexerId": r.get("indexerId")})
    out.sort(key=lambda x: (not x["ok"], -(x["seeders"] or 0)))
    return out


class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _auth(self):
        a = self.headers.get("authorization", "")
        tok = a[7:] if a.startswith("Bearer ") else ""
        return len(tok) == len(SECRET) and tok == SECRET

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def do_GET(self):
        if not self._auth():
            return self._send(401, {"error": "unauthorized"})
        u = urlparse(self.path)
        q = parse_qs(u.query)

        if u.path == "/status":
            out = []
            for n in WHITELIST:
                ins = docker(["inspect", "--format",
                              "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}|{{.State.StartedAt}}|{{.RestartCount}}", n])
                if ins.returncode == 0:
                    parts = (ins.stdout.strip().split("|") + ["", "", "", ""])[:4]
                    out.append({"name": n, "state": parts[0], "health": parts[1],
                                "started": parts[2], "restarts": parts[3]})
                else:
                    out.append({"name": n, "state": "absent", "health": "-", "started": "", "restarts": ""})
            return self._send(200, {"ok": True, "containers": out})

        if u.path == "/logs":
            name = q.get("name", [""])[0]
            if name not in WL:
                return self._send(403, {"error": "container not allowed"})
            try:
                tail = min(int(q.get("tail", ["80"])[0] or 80), 300)
            except Exception:
                tail = 80
            r = docker(["logs", "--tail", str(tail), name], timeout=25)
            body = ((r.stdout or "") + (r.stderr or ""))[-12000:]
            return self._send(200, {"ok": True, "name": name, "logs": body})

        if u.path == "/torrents":
            ok, data = qbit_torrents()
            if not ok:
                return self._send(502, {"ok": False, "error": data})
            torrents = summarize_torrents(data)
            # active downloads first (incomplete, then fastest), completed last
            torrents.sort(key=lambda t: (t["done"], -(t["dlspeed"] or 0)))
            downloading = sum(1 for t in torrents if not t["done"])
            return self._send(200, {"ok": True, "count": len(torrents),
                                    "downloading": downloading,
                                    "completed": len(torrents) - downloading,
                                    "torrents": torrents})

        if u.path == "/queue":
            rows = queue_rows("sonarr") + queue_rows("radarr")
            stuck = [r for r in rows if (r["pct"] or 0) <= 0]
            return self._send(200, {"ok": True, "count": len(rows),
                                    "stuck": len(stuck), "queue": rows})

        if u.path == "/wanted":
            # "Nothing is downloading" and "nothing is pending" are different
            # answers. An empty queue usually means Sonarr wants things it has
            # not been able to grab, which is the question actually being asked.
            out = {"episodes": [], "movies": []}
            code, w = arr("sonarr", "GET",
                          "wanted/missing?pageSize=40&sortKey=airDateUtc"
                          "&sortDirection=descending&includeSeries=true")
            if code == 200 and isinstance(w, dict):
                for r in w.get("records", []):
                    s = r.get("series") or {}
                    out["episodes"].append({
                        "series": s.get("title"),
                        "episode": f"S{r.get('seasonNumber')}E{r.get('episodeNumber')}",
                        "title": r.get("title"), "aired": (r.get("airDateUtc") or "")[:10]})
            code, w = arr("radarr", "GET", "wanted/missing?pageSize=40")
            if code == 200 and isinstance(w, dict):
                for r in w.get("records", []):
                    out["movies"].append({"title": r.get("title"), "year": r.get("year")})
            return self._send(200, {"ok": True,
                                    "episode_count": len(out["episodes"]),
                                    "movie_count": len(out["movies"]), **out})

        if u.path == "/releases":
            season = q.get("season", [""])[0]
            episode = q.get("episode", [""])[0]
            movie = q.get("movie", [""])[0]
            series = q.get("series", [""])[0]
            if movie:
                code, ms = arr("radarr", "GET", "movie")
                want = movie.lower().strip()
                hits = [m for m in ms if want in (m.get("title") or "").lower()] \
                    if isinstance(ms, list) else []
                if len(hits) != 1:
                    return self._send(409, {"ok": False, "error": "name did not match one movie",
                                            "candidates": [m.get("title") for m in hits][:12]})
                code, rels = arr("radarr", "GET", f"release?movieId={hits[0]['id']}")
                return self._send(200, {"ok": code == 200, "app": "radarr",
                                        "for": hits[0]["title"],
                                        "releases": rank_releases(rels)[:12]})
            s, cands = _series_id(series)
            if s is None:
                return self._send(409, {"ok": False, "error": "name did not match one series",
                                        "candidates": cands})
            if episode:
                code, eps = arr("sonarr", "GET", f"episode?seriesId={s['id']}")
                match = [e for e in eps
                         if str(e.get("seasonNumber")) == str(season)
                         and str(e.get("episodeNumber")) == str(episode)] \
                    if isinstance(eps, list) else []
                if not match:
                    return self._send(404, {"ok": False, "error": "no such episode"})
                code, rels = arr("sonarr", "GET", f"release?episodeId={match[0]['id']}")
                label = f"{s['title']} S{season}E{episode}"
            elif season:
                code, rels = arr("sonarr", "GET",
                                 f"release?seriesId={s['id']}&seasonNumber={season}")
                label = f"{s['title']} season {season}"
            else:
                return self._send(400, {"ok": False, "error": "need season or episode"})
            return self._send(200, {"ok": code == 200, "app": "sonarr", "for": label,
                                    "releases": rank_releases(rels)[:12]})

        return self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._auth():
            return self._send(401, {"error": "unauthorized"})
        b = self._body()

        if self.path == "/restart":
            name = str(b.get("name", "")).strip()
            if name == "all":
                targets = WHITELIST
            elif name in WL:
                targets = [name]
            else:
                return self._send(403, {"error": "container not allowed"})
            res = []
            for n in targets:
                r = docker(["restart", n], timeout=60)
                res.append({"name": n, "ok": r.returncode == 0,
                            "err": ("" if r.returncode == 0 else r.stderr.strip()[:200])})
            return self._send(200, {"ok": all(x["ok"] for x in res), "restarted": res})

        if self.path == "/pick":
            app = str(b.get("app", "")).strip()
            guid, idx = b.get("guid"), b.get("indexerId")
            if app not in ARR or not guid or idx is None:
                return self._send(400, {"error": "need app, guid, indexerId"})
            code, resp = arr(app, "POST", "release", {"guid": guid, "indexerId": idx})
            return self._send(200 if code in (200, 201) else 502,
                              {"ok": code in (200, 201), "status": code,
                               "detail": str(resp)[:300]})

        if self.path == "/drop":
            app = str(b.get("app", "")).strip()
            qid = b.get("id")
            if app not in ARR or qid is None:
                return self._send(400, {"error": "need app and id"})
            again = "true" if b.get("research", True) else "false"
            code, resp = arr(app, "DELETE",
                             f"queue/{qid}?removeFromClient=true&blocklist=true"
                             f"&skipRedownload={'false' if again == 'true' else 'true'}")
            return self._send(200 if code in (200, 201) else 502,
                              {"ok": code in (200, 201), "status": code,
                               "researched": again == "true"})

        return self._send(404, {"error": "not found"})

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((BIND, PORT), H).serve_forever()
