#!/usr/bin/env python3
"""Normalise an audiobook folder into ONE mp3 carrying ID3 chapter marks.

WHY THIS EXISTS
    Place's audio sync has two hard requirements that a torrent rarely satisfies:

      1. `audiomap.find_audio()` returns None unless the book folder holds
         exactly ONE audio file, because the chapter map models no per-track
         offsets. A multi-file rip therefore syncs nothing, silently.
      2. `audiomap.build_map()` ffprobes for chapter markers. With none it
         degrades to `confidence:'linear'`, which on a long book puts a seek
         hours away from the right spot.

    Both are satisfied by a single mp3 with embedded chapters, and mp3 ID3v2
    CHAP frames survive an ffprobe round-trip (verified), so no re-encode is
    needed -- every path here is `-c copy`.

TWO INPUT SHAPES
    multi-file : N tracks -> concatenated, one chapter per source track.
    cue        : one long mp3 + a sidecar .cue -> chapters read from the cue.

    A .cue INDEX is MM:SS:FF (minutes:seconds:frames, 75 frames/sec) -- NOT
    H:M:S. Reading it as hours silently yields nonsense on any book over an
    hour, so the parser asserts the marks land inside the real duration.

ffmpeg lives only inside the jellyfin image (the box has none), and jellyfin's
own mount is read-only, so we run a throwaway container with a rw bind.
"""

import argparse
import os
import re
import subprocess
import sys

IMG      = "jellyfin/jellyfin:latest"
HOST_ROOT = "/srv/media/data/media"
CROOT     = "/media"


def _docker(tool):
    return ["docker", "run", "--rm", "--user", "1000:1000",
            "-v", "%s:%s" % (HOST_ROOT, CROOT),
            "--entrypoint", "/usr/lib/jellyfin-ffmpeg/" + tool, IMG]


def cpath(host):
    """Host path -> the same file as the throwaway container sees it."""
    if not host.startswith(HOST_ROOT):
        raise ValueError("outside the mount: %s" % host)
    return CROOT + host[len(HOST_ROOT):]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def duration(host_path):
    out = run(_docker("ffprobe") + [
        "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
        cpath(host_path)]).stdout.strip()
    return float(out)


def strip_tags(src, dst):
    """Rewrite an mp3 with no metadata at all.

    The concat demuxer copies packets verbatim, so a source file's ID3v2 header
    and ID3v1 trailer end up spliced INTO the middle of the output stream. The
    decoder recovers, but logs 'Header missing' and drops a frame at each
    junction. Stripping first removes the splice entirely.
    """
    r = run(_docker("ffmpeg") + [
        "-hide_banner", "-loglevel", "error", "-y", "-i", cpath(src),
        "-map", "0:a:0",          # drop attached cover art: an mp3 muxer with
                                  # ID3v2 disabled refuses to write a picture
                                  # stream and fails the whole strip
        "-map_metadata", "-1", "-c", "copy",
        "-id3v2_version", "0", "-write_id3v1", "0", cpath(dst)])
    if r.returncode != 0:
        raise RuntimeError("strip failed for %s: %s" % (src, r.stderr[:300]))


def parse_cue(path, total):
    """[(title, start_seconds)] from a .cue sheet. INDEX is MM:SS:FF."""
    marks, title = [], None
    for line in open(path, encoding="utf-8", errors="replace"):
        line = line.strip()
        m = re.match(r'TITLE\s+"?(.+?)"?$', line)
        if m and line.startswith("TITLE"):
            title = m.group(1)
        m = re.match(r"INDEX\s+01\s+(\d+):(\d+):(\d+)", line)
        if m:
            mm, ss, ff = (int(x) for x in m.groups())
            marks.append((title or "Chapter %02d" % (len(marks) + 1),
                          mm * 60 + ss + ff / 75.0))
            title = None
    if not marks:
        raise RuntimeError("no INDEX lines in %s" % path)
    if marks[-1][1] > total * 1.02:
        raise RuntimeError(
            "cue marks overrun the audio (last %.0fs > %.0fs) -- wrong timebase?"
            % (marks[-1][1], total))
    if any(b[1] < a[1] for a, b in zip(marks, marks[1:])):
        raise RuntimeError("cue marks are not monotonic")
    return marks


MIN_CHAPTER_MS = 1000


def write_meta(path, title, author, chapters, total):
    """chapters = [(name, start_seconds)]; ends are the next start.

    Returns the number of chapters actually written, which can be fewer than
    were passed in: a cue sheet's last marker often sits within a second of EOF
    (Battle Cry's 63rd was 0.28s from the end), and ffmpeg hard-fails the whole
    mux on 'Chapter end time before start' rather than skipping it. Anything
    shorter than MIN_CHAPTER_MS is a marker, not a chapter -- drop it.
    """
    out = [";FFMETADATA1", "title=%s" % title, "artist=%s" % author,
           "album=%s" % title, "genre=Audiobook"]
    written = 0
    for i, (name, start) in enumerate(chapters):
        end = chapters[i + 1][1] if i + 1 < len(chapters) else total
        s_ms, e_ms = round(start * 1000), round(end * 1000) - 1
        if e_ms - s_ms < MIN_CHAPTER_MS:
            print("  dropping degenerate chapter %r (%.2fs long)"
                  % (name, (e_ms - s_ms) / 1000.0))
            continue
        out += ["[CHAPTER]", "TIMEBASE=1/1000",
                "START=%d" % s_ms, "END=%d" % e_ms, "title=%s" % name]
        written += 1
    open(path, "w").write("\n".join(out) + "\n")
    return written


def decode_errors(host_path):
    """Count decoder complaints over a full pass. Used as a BASELINE.

    Rips carry their own damage: 'Lathe of Heaven 02.mp3' arrived with two
    unreadable frames (~50ms). Demanding a clean decode of the output would
    reject a perfect remux because of a defect that was already in the source,
    so what matters is whether the remux ADDED errors, not whether any exist.
    """
    dec = run(_docker("ffmpeg") + ["-hide_banner", "-v", "error",
                                   "-i", cpath(host_path), "-f", "null", "-"])
    return [l for l in dec.stderr.splitlines() if l.strip()]


def verify(host_path, want_chapters, want_seconds):
    """A remux that silently lost the chapters is worse than no remux."""
    import json
    r = run(_docker("ffprobe") + [
        "-v", "error", "-show_chapters", "-show_entries", "format=duration",
        "-of", "json", cpath(host_path)])
    d = json.loads(r.stdout)
    got_ch = len(d.get("chapters", []))
    got_s  = float(d["format"]["duration"])
    print("  verify: %d chapters, %.3f h" % (got_ch, got_s / 3600))
    if got_ch != want_chapters:
        raise RuntimeError("chapter count %d != %d" % (got_ch, want_chapters))
    if abs(got_s - want_seconds) > 2.0:
        raise RuntimeError("duration %.1f != %.1f" % (got_s, want_seconds))
    bad = decode_errors(host_path)
    print("  decode: %d error lines" % len(bad))
    for l in bad[:3]:
        print("    " + l[:110])
    return len(bad)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder", help="book folder under the audiobooks dir")
    ap.add_argument("--title", required=True)
    ap.add_argument("--author", default="")
    ap.add_argument("--cue", help="sidecar .cue for a single-file book")
    ap.add_argument("--apply", action="store_true",
                    help="replace the folder contents (otherwise stop at the staged file)")
    a = ap.parse_args()

    src = a.folder.rstrip("/")
    work = os.path.join(HOST_ROOT, "audiobooks", ".remux")
    os.makedirs(work, exist_ok=True)
    stage = os.path.join(work, a.title + ".mp3")

    audio = sorted(f for f in os.listdir(src)
                   if f.lower().endswith((".mp3", ".m4a", ".m4b")))
    print("source: %s\n  %d audio file(s)" % (src, len(audio)))
    baseline = sum(len(decode_errors(os.path.join(src, f))) for f in audio)

    if a.cue:
        if len(audio) != 1:
            sys.exit("--cue expects exactly one audio file, found %d" % len(audio))
        big = os.path.join(src, audio[0])
        total = duration(big)
        chapters = parse_cue(a.cue, total)
        print("  cue: %d chapters, last at %.0fs of %.0fs" %
              (len(chapters), chapters[-1][1], total))
        n_ch = write_meta(os.path.join(work, "meta.txt"), a.title, a.author,
                          chapters, total)
        r = run(_docker("ffmpeg") + [
            "-hide_banner", "-loglevel", "error", "-y", "-i", cpath(big),
            "-i", cpath(os.path.join(work, "meta.txt")),
            "-map_metadata", "1", "-map_chapters", "1", "-c", "copy",
            "-id3v2_version", "3", cpath(stage)])
        if r.returncode != 0:
            sys.exit("ffmpeg failed: " + r.stderr[:400])
    else:
        clean = os.path.join(work, "clean")
        os.makedirs(clean, exist_ok=True)
        durs, parts = [], []
        for i, f in enumerate(audio, 1):
            c = os.path.join(clean, "%03d.mp3" % i)
            strip_tags(os.path.join(src, f), c)
            parts.append(c)
            durs.append(duration(c))
        total = sum(durs)
        print("  stripped %d tracks, %.3f h" % (len(parts), total / 3600))

        chapters, t = [], 0.0
        for i, d in enumerate(durs, 1):
            chapters.append(("Part %02d" % i, t))
            t += d
        n_ch = write_meta(os.path.join(work, "meta.txt"), a.title, a.author,
                          chapters, total)
        with open(os.path.join(work, "list.txt"), "w") as fh:
            for p in parts:
                fh.write("file '%s'\n" % cpath(p).replace("'", "'\\''"))
        r = run(_docker("ffmpeg") + [
            "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", cpath(os.path.join(work, "list.txt")),
            "-i", cpath(os.path.join(work, "meta.txt")),
            "-map_metadata", "1", "-map_chapters", "1", "-c", "copy",
            "-id3v2_version", "3", cpath(stage)])
        if r.returncode != 0:
            sys.exit("ffmpeg failed: " + r.stderr[:400])

    print("staged: %s (%.0f MB)" % (stage, os.path.getsize(stage) / 1e6))
    errs = verify(stage, n_ch, total)

    print("  source baseline: %d error lines" % baseline)
    if not a.apply:
        print("dry run -- staged file left in place, folder untouched")
        return
    if errs > baseline:
        sys.exit("refusing to apply: remux ADDED %d decode errors (%d -> %d)"
                 % (errs - baseline, baseline, errs))

    for f in audio:
        os.remove(os.path.join(src, f))
    os.replace(stage, os.path.join(src, a.title + ".mp3"))
    print("applied -> %s/%s.mp3" % (src, a.title))
    print("folder now:", os.listdir(src))


if __name__ == "__main__":
    main()
