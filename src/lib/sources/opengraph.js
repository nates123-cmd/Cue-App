// OpenGraph / meta-tag scraper for articles. Uses the shared `quick-service`
// edge function's `fetchUrl` mode to fetch HTML server-side (no CORS), then
// parses OG / twitter / standard meta tags. Returns null for non-URL inputs.

import { fetchUrlViaProxy } from '../claude'

const URL_RE = /^https?:\/\//i

function metaContent(doc, selectors) {
  for (const sel of selectors) {
    const el = doc.querySelector(sel)
    const val = el?.getAttribute('content')?.trim()
    if (val) return val
  }
  return null
}

function estimateReadMin(wordCount) {
  if (!wordCount) return null
  return Math.max(1, Math.round(wordCount / 220)) // ~220 wpm average
}

export async function openGraphLookup(input) {
  const url = (input || '').trim()
  if (!URL_RE.test(url)) return null

  const fetched = await fetchUrlViaProxy(url)
  if (!fetched?.html) return null

  let doc
  try {
    doc = new DOMParser().parseFromString(fetched.html, 'text/html')
  } catch {
    return null
  }

  const title = metaContent(doc, [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
  ]) || doc.querySelector('title')?.textContent?.trim() || null

  const synopsis = metaContent(doc, [
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
    'meta[name="description"]',
  ])

  const source = metaContent(doc, [
    'meta[property="og:site_name"]',
    'meta[name="application-name"]',
  ])

  const author = metaContent(doc, [
    'meta[name="author"]',
    'meta[property="article:author"]',
  ])

  const image_url = metaContent(doc, [
    'meta[property="og:image"]',
    'meta[name="twitter:image"]',
    'meta[property="og:image:url"]',
  ])

  // Try to estimate word count from the article body. Best effort — many sites
  // are SPA-ish and the document.body text is minimal; in that case we leave
  // est_read_min null and let Claude estimate.
  const bodyText = doc.body?.innerText || doc.body?.textContent || ''
  const wordCount = bodyText.trim().split(/\s+/).filter(Boolean).length
  const est_read_min = wordCount > 200 ? estimateReadMin(wordCount) : null

  return {
    title,
    synopsis,
    source,
    author,
    image_url,
    word_count: wordCount > 200 ? wordCount : null,
    est_read_min,
    web_url: url,
  }
}
