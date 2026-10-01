# Cue — design constraints

Read this before changing anything visual. It exists so Cue keeps a point of
view instead of drifting back to the generic default a code generator produces
when left unconstrained.

## References, and who owns what

Nate's brief (moodboard deck, Sept 2026): *"Letterbox and strand (mostly
letterbox) but with the current color scheme; look at different fonts too."*

| Question | Owner | What it answers |
| --- | --- | --- |
| Ground and palette | **Cue's own scheme** (pre-restyle) | Cream paper by day, warm near-black by night, one signal orange. Kept on purpose. |
| Structure, type system, devices | **Letterboxd** | Poster is the object, chrome recedes. Bold serif headlines, plain grotesk UI, spaced-caps section heads over a hairline, stat counters, text tab strip. |
| The motif | **Letterboxd** | The overlapping poster stack (its list preview). In Cue it is a collection: everything one person recommended. |
| One device | **The Strand** | The staff-pick shelf card: a coloured band naming whose pick it is, the card under it. In Cue it wraps who recommended it, when, and whether it is shared. |

Where they disagreed: Letterboxd is dark only and green/orange/blue; Cue's
scheme won the ground and colour outright. The Strand is red; its band is
`--signal`, not red.

## Register

Letterboxd's: a film nerd's shelf that is friendly, not reverent. The posters
are the loudest thing on every screen. **If a change makes the chrome louder
than the artwork, it is wrong.** If it starts to feel like a newspaper (edition
numbers, "No. 002", mono datelines), it is drifting back to the old look.

## Colour

No colour outside this table. Two grounds, swapped by the clock (`editionForHour`).

| Token | Night | Day (paper) | Role |
| --- | --- | --- | --- |
| `--ink` | `#15120f` | `#f3ece1` | Page ground |
| `--paper` | `#1c1916` | `#fbf6ec` | Cards, sheets, poster placeholder |
| `--paper-soft` | `#23201c` | `#f6efe2` | Button and chip fill |
| `--text` | `#f0e8d8` | `#1c1611` | Headlines, live tab, values |
| `--text-soft` | `#cdc3b1` | `#3d342a` | Prose, section-head labels |
| `--muted` | `#8a8275` | `#7a6f60` | Meta lines, counts, idle tabs |
| `--hairline` | text @ 8% | text @ 10% | Row dividers |
| `--hairline-strong` | text @ 22% | text @ 25% | Under section heads, stat dividers |
| `--signal` | `#ec5a2a` | `#ec5a2a` | The one accent: live tab underline, Now bar, rating dots, the pick band, primary button |

Three text tiers, three jobs: `--text` (headline/value), `--text-soft` (read),
`--muted` (meta). Do not collapse them back into one `--muted`.

## Type

Four faces, four jobs. Loaded in `index.html`, set as vars on the App root.

| Var | Face | Job |
| --- | --- | --- |
| `--display` | Newsreader **700** | Titles: masthead, item title, collection names, stat numerals. Upright, always. (Letterboxd's Tiempos Headline.) |
| `--read` | Newsreader 400 | Synopsis and anything read at length. |
| `--ui` / `--body` | Schibsted Grotesk | Every label, control, tab and meta line. Spaced caps via `<Mono>` for section labels only. (Letterboxd's Graphik.) |
| `--note` | Instrument Serif *italic* | The personal voice and nothing else: the pick band, the `&` mark, rating tones ("loved it"), your review, the free-text ask. |

Scale runs 34 (masthead) / 26 (detail title) / 22 (stat numerals) / 17 (row
titles) / 16 (read) / 13–14 (UI) / 9.5–11.5 (caps labels). `<Mono>` kept its
name for ~100 call sites but is a grotesk now.

Font options looked at (fonts.html, Sept 30): A Newsreader + Schibsted Grotesk
(chosen, closest to Letterboxd and warmest on the cream), B Source Serif 4 +
Instrument Sans (crisper, body ran wide), C Bricolage Grotesque headlines
(lost the serif authority). Swapping is a token change in `App.jsx` +
`index.html` + `styles.css`.

## Devices — reach for these first

- **`SectionHead`**: spaced caps label, hairline under, count or action flush right. The one way a screen is divided.
- **Poster frame** (`posterFrame` + keyline): 2:3, 3px corners, a faint inner 1px light keyline, no drop shadow.
- **Grid cell** (`Card`): poster only. One quiet row under it: rating dots, or "Now" in signal; the `&` mark right. No title (the cover carries it; it is the aria-label).
- **Now**: a 3px signal bar along the poster's bottom edge.
- **`PosterStack`**: up to 5 covers fanned left-over-right. A collection.
- **`StatRow`**: bold serif numerals over tiny caps labels, hairline between. Tapping one filters.
- **Text tab strip**: 14px grotesk, idle in `--muted`, live in `--text` with a 2px signal underline.
- **Buttons and chips**: filled `--paper-soft` blocks, 3px corners, sentence case. `--signal` fill for the single primary action.
- **`PickCard`**: signal band, `--note` italic "Amanda's pick" left, "Saved Sep 12" caps right.
- **`CueMark`**: three flat dots (signal, soft, muted) + "Cue" in the grotesk.

## Banned

- Monospace anywhere in the UI. JetBrains Mono caps on every label was the old tell.
- Italic serif titles. Headlines are upright bold; italic belongs to `--note`.
- Newspaper conceits in copy: "No. 00x", editions in the kicker, BK/TV/MV spine codes on screen.
- Inter / Inter Tight / Roboto / Space Grotesk / Poppins, or a bare system stack.
- Bordered rounded cards as the way to group things. Group with space, hairlines, or a flat `--paper` fill.
- Outline-only buttons and 999px pill chips (the capture FAB is the one exception).
- Drop shadows on posters or cards; the film-grain overlay. Flat.
- Unicode ★/☆. Ratings are signal dots.
- An icon beside every label. Type tabs are words.
- Metadata stacks under grid posters.

## Honesty rules that outrank the design

- **Never invent a "why".** The pick card shows who, when, and whether it is shared, because that is what the data holds. There is no recommender-note field yet; until there is, the card does not fake one.
- **Pipeline pills stay.** `FulfillmentPills` (is it on the Kindle, downloaded) are real state; the poster-first grid still shows them under the poster when they exist.
- Collections are grouped by `recommended_by` only. They are not playlists. Real custom collections (Nate's "Amanda list", "create your own playlist", "add to playlist") need a table; that is feature work, not styling.

## Looking at it

The real app needs auth and live Supabase, so render the real components against
sample data:

1. Make a scratch `preview.html` at the repo root loading `/src/preview.jsx`, which mounts `LibraryPage`, `ActivePage` and `ItemDetail` inside an `EditionContext.Provider` with the root vars from `App.jsx` and a few items with TMDB poster URLs. Use `?paper=1` for the day ground, `?view=detail|active`.
2. `npx vite --port <free port> --strictPort` (5199 is often taken by another app), open it in Chrome at 390px wide, screenshot, critique, fix, look again.
3. Delete `preview.html` and `src/preview.jsx` before committing.

Live check after a ship: the same-site iframe trick on `nates123-cmd.github.io/Cue-App/` gives a phone viewport with the real session.
