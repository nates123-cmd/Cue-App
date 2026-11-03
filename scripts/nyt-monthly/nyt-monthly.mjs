#!/usr/bin/env node
// Monthly: this month's NYT "Best Movies and TV Shows Coming to ..." picks
// into Cue's NYT picks row.
//
//   1. Skip if origin/main's src/data/nyt-picks.json already has this month.
//   2. Queue the article in Press (articles row, no share = in nobody's feed).
//      Press's Mac NYT reader (real signed-in Chrome, com.nate.press-nyt) is the
//      only thing that gets past NYT's bot wall; it fetches within ~2 min.
//   3. `claude -p` turns the article text into one month block (own-words notes).
//   4. Temp worktree off origin/main -> write the block -> run tests/nyt.test.js
//      -> PR -> merge (merge to main = Pages deploy). Then Telegram Nate.
//
// Runs from launchd com.nate.cue-nyt at 10 AM on days 1-7 (see install.sh).
// Idempotent: every run after the month lands exits at step 1.
//
//   node nyt-monthly.mjs                 this month
//   node nyt-monthly.mjs --url <nyt url> use this article (NYT ran it on an odd date)
//   node nyt-monthly.mjs --dry-run       stop before the PR; print the block

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const HOME = os.homedir()
const CUE = `${HOME}/Developer/cue-app`
const PRESS_URL_JS = `${HOME}/Developer/press/src/lib/url.js`
const PRESS_ENV = `${HOME}/Library/Application Support/press-poller/.env`
const CLAUDE = `${HOME}/.local/bin/claude`
const LOG_DIR = `${HOME}/.local/state/cue-nyt`
const DATA = 'src/data/nyt-picks.json'
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

const args = process.argv.slice(2)
const DRY = args.includes('--dry-run')
const URL_ARG = args.includes('--url') ? args[args.indexOf('--url') + 1] : null

fs.mkdirSync(LOG_DIR, { recursive: true })
const log = (...m) => {
  const line = `${new Date().toISOString().slice(0, 19)} ${m.join(' ')}`
  console.log(line)
  fs.appendFileSync(`${LOG_DIR}/run.log`, line + '\n')
}

function sh(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} ${argv.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout || '').slice(0, 400)}`)
  }
  return r
}

// Best effort: the Beelink can be unreachable (Nord on), never fail the run on it.
function telegram(msg) {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', 'nate@100.111.77.98', 'python3 ~/bin/notify_tg.py'], { input: msg, encoding: 'utf8', timeout: 30000 })
  log('telegram', r.status === 0 ? 'sent' : `FAILED ${(r.stderr || '').trim().slice(0, 120)}`)
}

// New York calendar month (the Mac is in NY; launchd fires in local time).
function nyToday() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]))
  return { yyyy: p.year, mm: p.month, dd: Number(p.day) }
}

// ── block formatting / merging (shared with the backfill) ─────────────
export function formatPicks(blocks) {
  const body = blocks.map((b) => {
    const picks = b.picks.map((p) => `      ${JSON.stringify(p).replace(/","/g, '", "').replace(/,"/g, ', "').replace(/":/g, '": ').replace(/^\{/, '{ ').replace(/\}$/, ' }')}`).join(',\n')
    return `  {\n    "month": ${JSON.stringify(b.month)},\n    "label": ${JSON.stringify(b.label)},\n    "source": ${JSON.stringify(b.source)},\n    "picks": [\n${picks}\n    ]\n  }`
  }).join(',\n')
  return `[\n${body}\n]\n`
}

export function mergeBlock(blocks, block) {
  return [...blocks.filter((b) => b.month !== block.month), block].sort((a, b) => a.month.localeCompare(b.month))
}

export function validateBlock(b, month) {
  const errs = []
  if (!b || typeof b !== 'object') return ['not an object']
  if (b.month !== month) errs.push(`month ${b.month} != ${month}`)
  if (!b.label || !b.source) errs.push('label/source missing')
  if (!Array.isArray(b.picks) || b.picks.length < 3 || b.picks.length > 30) errs.push(`picks count ${b.picks?.length}`)
  for (const p of b.picks || []) {
    if (!p.title || !p.note || !p.service) errs.push(`pick fields: ${JSON.stringify(p).slice(0, 80)}`)
    if (!['movie', 'tv'].includes(p.type)) errs.push(`type ${p.type} (${p.title})`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '')) errs.push(`date ${p.date} (${p.title})`)
  }
  return errs
}

// ── Press ────────────────────────────────────────────────────
function pressEnv() {
  return Object.fromEntries(fs.readFileSync(PRESS_ENV, 'utf8').split('\n').filter((l) => l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))
}

async function press(method, p, body) {
  const env = pressEnv()
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${p}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`press ${method} ${p.slice(0, 40)} -> ${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function fetchArticle(candidates) {
  const { canonicalize, siteOf, kindOf } = await import(PRESS_URL_JS)
  const rows = candidates.map((url) => { const c = canonicalize(url); const s = siteOf(c); return { url, canonical_url: c, site: s, kind: kindOf(s) } })
  const inList = `(${rows.map((r) => `"${r.canonical_url}"`).join(',')})`
  const sel = `articles?select=id,url,status,title,content_text,attempts&canonical_url=in.${encodeURIComponent(inList)}`

  let have = await press('GET', sel)
  const missing = rows.filter((r) => !have.some((h) => h.url === r.url || canonicalize(h.url) === r.canonical_url))
  if (missing.length) {
    await press('POST', 'articles?on_conflict=canonical_url', missing)
    log('queued in Press:', missing.map((r) => r.url.split('/').slice(3, 6).join('/')).join(' '))
  }
  // The NYT reader runs every 2 min while the Mac is awake; give it ~12.
  for (let i = 0; i < 24; i++) {
    have = await press('GET', sel)
    const ready = have.find((h) => h.status === 'ready' && (h.content_text || '').length > 2000)
    if (ready) return ready
    if (have.length && have.every((h) => h.status === 'failed')) return null
    await sleep(30000)
  }
  return null
}

// ── extraction ──────────────────────────────────────────────
function extract(article, month, label) {
  const prompt = `Below is a New York Times article listing the month's best new streaming movies and TV, grouped by service ("New to Amazon Prime Video", "New to AMC+", ...). Under each service are 1-2 FEATURED picks: a quoted title heading, a "Starts streaming: <date>" line, then a paragraph. Ignore every "Also arriving" list; featured picks only.

Reply with ONLY one JSON object, no prose, no code fence, in exactly this shape:
{"month":"${month}","label":"${label}","source":"${article.url}","picks":[{"title":"Carrie","type":"tv","year":2026,"season":1,"service":"Prime Video","date":"2026-10-07","note":"Mike Flanagan's modern, expanded take on the Stephen King novel."}]}

Rules:
- title: name without "Season N"; season goes in "season" (tv only; 1 for a new series).
- type: "movie" or "tv" (docuseries/miniseries/anime/limited = tv; documentary film or stand-up special = movie).
- year: premiere year of the title; for a later season the year the SERIES first premiered (omit if unsure).
- service: short name (Prime Video, AMC+, Apple TV, Disney+, HBO Max, Hulu, Netflix, Paramount+, Peacock, MGM+...).
- date: YYYY-MM-DD from "Starts streaming".
- note: one line, max ~14 words, entirely in your own words. Never copy 5+ consecutive words from the article.

ARTICLE:
${article.title}
${article.content_text}`
  const r = sh(CLAUDE, ['-p', '--output-format', 'text'], { input: prompt, timeout: 6 * 60 * 1000 })
  const out = r.stdout
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  return JSON.parse(json)
}

// ── Cue PR ─────────────────────────────────────────────────
function shipBlock(block) {
  const branch = `nyt-${block.month}`
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-nyt-'))
  try {
    sh('git', ['-C', CUE, 'worktree', 'add', '-B', branch, wt, 'origin/main'])
    const file = path.join(wt, DATA)
    const blocks = mergeBlock(JSON.parse(fs.readFileSync(file, 'utf8')), block)
    fs.writeFileSync(file, formatPicks(blocks))
    // Tests run against the primary checkout's node_modules (gitignored name,
    // and only DATA is ever staged, so the link can never be committed).
    fs.symlinkSync(`${CUE}/node_modules`, path.join(wt, 'node_modules'))
    sh(`${wt}/node_modules/.bin/vitest`, ['run', 'tests/nyt.test.js'], { cwd: wt })
    sh('git', ['-C', wt, 'add', DATA])
    sh('git', ['-C', wt, 'commit', '-q', '-m', `data(cue): NYT picks for ${block.label} ${block.month.slice(0, 4)}\n\nAutomated by scripts/nyt-monthly (launchd com.nate.cue-nyt).`])
    sh('git', ['-C', wt, 'push', '-q', '-f', 'origin', branch])
    const titles = block.picks.map((p) => `- ${p.title} (${p.service}, ${p.date})`).join('\n')
    const pr = sh('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', `NYT picks: ${block.label} ${block.month.slice(0, 4)}`,
      '--body', `Monthly NYT picks, added by \`scripts/nyt-monthly\`.\n\n${titles}\n\nSource: ${block.source}`], { cwd: wt }).stdout.trim()
    const merged = sh('gh', ['pr', 'merge', pr, '--merge', '--delete-branch'], { cwd: wt, allowFail: true })
    return { pr, merged: merged.status === 0 }
  } finally {
    sh('git', ['-C', CUE, 'worktree', 'remove', '--force', wt], { allowFail: true })
  }
}

// ── main ───────────────────────────────────────────────────
async function main() {
  const t = nyToday()
  const month = `${t.yyyy}-${t.mm}`
  const label = MONTHS[Number(t.mm) - 1][0].toUpperCase() + MONTHS[Number(t.mm) - 1].slice(1)
  const lastTry = t.dd >= 7

  // A dry run skips the "already on main" gate so the pipeline can be tried
  // on a month that already landed; it never writes to Cue.
  if (!DRY) {
    sh('git', ['-C', CUE, 'fetch', '-q', 'origin', 'main'])
    const onMain = sh('git', ['-C', CUE, 'show', `origin/main:${DATA}`], { allowFail: true })
    if (onMain.status !== 0) { log('nyt-picks.json not on main yet (Cue PR #29 unmerged); skipping'); return }
    if (JSON.parse(onMain.stdout).some((b) => b.month === month)) { log(month, 'already on main; nothing to do'); return }
  }

  // NYT runs it on the 1st; also try the next few days in case it slipped.
  const candidates = URL_ARG ? [URL_ARG] : Array.from({ length: Math.min(t.dd, 5) }, (_, i) =>
    `https://www.nytimes.com/${t.yyyy}/${t.mm}/${String(i + 1).padStart(2, '0')}/arts/television/movies-tv-shows-${MONTHS[Number(t.mm) - 1]}-${t.yyyy}-streaming.html`)

  const article = await fetchArticle(candidates)
  if (!article) {
    log(month, 'article not ready yet', lastTry ? '(last scheduled try)' : '(retry tomorrow)')
    if (lastTry) telegram(`Cue NYT picks: couldn't get the ${label} article (tried ${candidates.length} URLs via Press). Send Claude the link, or run:\nnode ~/Library/Application\\ Support/cue-nyt/nyt-monthly.mjs --url <link>`)
    return
  }
  log(month, 'article ready:', article.title)

  const block = extract(article, month, label)
  block.source = article.url
  const errs = validateBlock(block, month)
  if (errs.length) throw new Error(`extracted block invalid: ${errs.slice(0, 5).join('; ')}`)
  log(month, `extracted ${block.picks.length} picks`)

  if (DRY) { console.log(formatPicks([block])); return }
  const { pr, merged } = shipBlock(block)
  log(month, merged ? 'merged' : 'PR open, merge FAILED', pr)
  telegram(`Cue NYT picks: ${label} added, ${block.picks.length} titles${merged ? ' (live after deploy)' : ` but the merge failed, see ${pr}`}.\n` +
    block.picks.slice(0, 6).map((p) => `- ${p.title} (${p.service})`).join('\n'))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    log('ERROR', e.message)
    telegram(`Cue NYT picks job failed: ${e.message.slice(0, 300)}\nLog: ~/.local/state/cue-nyt/run.log`)
    process.exit(1)
  })
}
