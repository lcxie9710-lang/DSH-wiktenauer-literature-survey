/**
 * Wiktenauer MediaWiki API client.
 *
 * Ported from the original `wiktenauer_mcp.py` (FastMCP server) in the HEMA
 * Question Agent project: the four query operations are preserved verbatim,
 * only the MCP transport is dropped because a DSH tool runs in-process and
 * calls this client directly.
 */

export const WIKI_API_BASE = 'https://wiktenauer.com/api.php'
export const USER_AGENT = 'dsh-weinao/0.1.0 (维脑 Agent HEMA research plugin)'
export const TIMEOUT_SECONDS = 15

/** One full-text search hit. */
export interface WikiSearchHit {
  title: string
  snippet: string
}

/** Structured result of one wiki query operation. */
export type WikiResult =
  | { ok: true; kind: 'search'; hits: WikiSearchHit[] }
  | { ok: true; kind: 'page'; text: string }
  | { ok: true; kind: 'titles'; titles: string[] }
  | { ok: true; kind: 'links'; links: string[] }
  | { ok: false; kind: 'error'; message: string }

async function makeRequest(params: Record<string, string>): Promise<unknown> {
  const url = new URL(WIKI_API_BASE)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SECONDS * 1000)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Wiktenauer API returned HTTP ${response.status}`)
    }
    return await response.json() as unknown
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Error: Wiktenauer API request timed out after 15 seconds')
    }
    if (error instanceof TypeError) {
      throw new Error(
        'Error: Unable to connect to Wiktenauer API. The service may be temporarily unavailable.',
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Convert HTML to plain text while preserving structure.
 * Ported from `html_to_text` in wiktenauer_mcp.py.
 */
export function htmlToText(html: string): string {
  // Minimal DOM-free tag stripping: preserve headings/paragraphs/lists as
  // line breaks. MediaWiki parse output is well-formed enough for this.
  const withBreaks = html
    // Block-level boundaries become newlines
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    // List markers
    .replace(/<li[^>]*>/gi, '• ')
    // Strip every remaining tag
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

  const lines: string[] = []
  for (const raw of withBreaks.split('\n')) {
    const stripped = raw.trim()
    if (stripped) {
      lines.push(stripped)
    } else if (lines.length > 0 && lines[lines.length - 1] !== '') {
      lines.push('')
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  return lines.join('\n')
}

/** Full-text search. */
export async function wikiSearch(keyword: string, limit = 10): Promise<WikiResult> {
  try {
    const data = await makeRequest({
      action: 'query',
      list: 'search',
      srsearch: keyword,
      srlimit: String(Math.min(limit, 500)),
      format: 'json',
    }) as {
      query?: { search?: Array<{ title?: string; snippet?: string }> }
    }
    const hits = (data.query?.search ?? []).slice(0, limit).map(item => ({
      title: item.title ?? '',
      snippet: item.snippet ?? '',
    }))
    return { ok: true, kind: 'search', hits }
  } catch (error: unknown) {
    return { ok: false, kind: 'error', message: errorMessage(error) }
  }
}

/** Get one page's full text (HTML converted to plain text). */
export async function wikiGetPage(title: string): Promise<WikiResult> {
  try {
    const data = await makeRequest({
      action: 'parse',
      page: title,
      prop: 'text',
      format: 'json',
    }) as {
      error?: { code?: string; info?: string }
      parse?: { text?: { '*': string } }
    }
    if (data.error) {
      if (data.error.code === 'missingtitle') {
        return { ok: false, kind: 'error', message: `Error: Page '${title}' not found on Wiktenauer` }
      }
      return { ok: false, kind: 'error', message: `Error: ${data.error.info ?? 'Unknown error'}` }
    }
    const html = data.parse?.text?.['*'] ?? ''
    if (!html) {
      return { ok: false, kind: 'error', message: `Error: Page '${title}' not found on Wiktenauer` }
    }
    const text = htmlToText(html)
    if (!text) {
      return { ok: false, kind: 'error', message: `Error: Page '${title}' has no content` }
    }
    return { ok: true, kind: 'page', text }
  } catch (error: unknown) {
    return { ok: false, kind: 'error', message: errorMessage(error) }
  }
}

/** Prefix-based title search (for term disambiguation). */
export async function wikiPrefixSearch(prefix: string, limit = 10): Promise<WikiResult> {
  try {
    const data = await makeRequest({
      action: 'query',
      list: 'prefixsearch',
      pssearch: prefix,
      pslimit: String(Math.min(limit, 500)),
      format: 'json',
    }) as {
      query?: { prefixsearch?: Array<{ title?: string }> }
    }
    const titles = (data.query?.prefixsearch ?? [])
      .slice(0, limit)
      .map(item => item.title ?? '')
    return { ok: true, kind: 'titles', titles }
  } catch (error: unknown) {
    return { ok: false, kind: 'error', message: errorMessage(error) }
  }
}

/** Get internal links of one page (concept discovery). */
export async function wikiGetLinks(title: string): Promise<WikiResult> {
  try {
    const data = await makeRequest({
      action: 'query',
      titles: title,
      prop: 'links',
      pllimit: 'max',
      format: 'json',
    }) as {
      query?: { pages?: Record<string, { missing?: string; links?: Array<{ title?: string }> }> }
    }
    const pages = data.query?.pages ?? {}
    for (const page of Object.values(pages)) {
      if (page.missing !== undefined) {
        return { ok: false, kind: 'error', message: `Error: Page '${title}' not found on Wiktenauer` }
      }
      return {
        ok: true,
        kind: 'links',
        links: (page.links ?? []).map(link => link.title ?? ''),
      }
    }
    return { ok: true, kind: 'links', links: [] }
  } catch (error: unknown) {
    return { ok: false, kind: 'error', message: errorMessage(error) }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `Error: ${error.message}`
  return `Error: ${String(error)}`
}
