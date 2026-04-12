import type {
  WebFetchOptions,
  WebFetchResult,
  WebProvider,
  WebSearchOptions,
  WebSearchResult,
} from '../types.js';

const MAX_RESPONSE_BYTES = 200_000;
const GOOGLE_SEARCH_URL = 'https://www.google.com/search';

type DefuddleFn = (
  htmlOrDom: string,
  url?: string,
  options?: { markdown?: boolean },
) => Promise<{
  content: string;
  title?: string;
  author?: string;
  description?: string;
  domain?: string;
  site?: string;
  published?: string;
  wordCount?: number;
}>;

async function loadDefuddle(): Promise<DefuddleFn> {
  const node = await import('defuddle/node');
  return node.Defuddle;
}

async function fetchHtml(url: string): Promise<{ html: string; status: number; statusText: string }> {
  const response = await fetch(new URL(url), {
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; OpenHermit/1.0)',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  const rawBuffer = await response.arrayBuffer();
  const html = new TextDecoder('utf-8', { fatal: false }).decode(rawBuffer);
  return { html, status: response.status, statusText: response.statusText };
}

function truncateToBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  return {
    text: new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, maxBytes)),
    truncated: true,
  };
}

/**
 * Extract search results from Google HTML using Defuddle.
 *
 * Google serves link blocks inside the results page.  Defuddle converts them
 * to Markdown and we parse the link/title/snippet triples out of that Markdown.
 */
async function extractGoogleResults(
  html: string,
  limit: number,
): Promise<WebSearchResult[]> {
  const Defuddle = await loadDefuddle();
  const result = await Defuddle(html, GOOGLE_SEARCH_URL, { markdown: true });
  const content = result.content ?? '';

  // Google's Defuddle-extracted markdown contains blocks like:
  //   [Title](https://example.com)
  //   Snippet text...
  // We extract markdown links as result anchors.
  const linkPattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  // Split content into lines for snippet extraction
  const lines = content.split('\n');

  for (let i = 0; i < lines.length && results.length < limit; i++) {
    const line = lines[i]!;
    linkPattern.lastIndex = 0;
    const match = linkPattern.exec(line);
    if (!match) continue;

    const title = match[1]!;
    const url = match[2]!;

    // Skip Google internal links
    if (url.includes('google.com/') && !url.includes('google.com/url')) continue;
    if (url.includes('accounts.google')) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    // Collect snippet from subsequent non-link lines
    const snippetLines: string[] = [];
    for (let j = i + 1; j < lines.length && j <= i + 3; j++) {
      const nextLine = lines[j]?.trim();
      if (!nextLine) continue;
      linkPattern.lastIndex = 0;
      if (linkPattern.test(nextLine)) break;
      snippetLines.push(nextLine);
    }

    results.push({
      title,
      url,
      snippet: snippetLines.join(' ').slice(0, 300),
    });
  }

  return results;
}

export class DefuddleWebProvider implements WebProvider {
  readonly name = 'defuddle';

  async search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]> {
    const limit = Math.max(1, Math.min(10, options?.limit ?? 5));

    const params = new URLSearchParams({
      q: query,
      num: String(limit + 5), // request a few extra to account for filtering
      hl: 'en',
    });

    const { html, status } = await fetchHtml(`${GOOGLE_SEARCH_URL}?${params.toString()}`);

    if (status !== 200) {
      throw new Error(`Google search returned HTTP ${status}`);
    }

    const results = await extractGoogleResults(html, limit);

    // If content_mode is 'full', fetch each result page
    if (options?.contentMode === 'full') {
      await Promise.all(
        results.map(async (r) => {
          try {
            const fetched = await this.fetch(r.url, { output: 'markdown', maxBytes: 50_000 });
            r.content = fetched.content;
          } catch {
            // Content fetch is best-effort
          }
        }),
      );
    }

    return results;
  }

  async fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult> {
    const maxBytes = Math.min(options?.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
    const output = options?.output ?? 'markdown';

    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Only http/https URLs are supported, got: ${parsedUrl.protocol}`);
    }

    const { html, status, statusText } = await fetchHtml(url);

    if (output === 'raw') {
      const { text, truncated } = truncateToBytes(html, maxBytes);
      return {
        url,
        content: text,
        contentBytes: new TextEncoder().encode(html).byteLength,
        truncated,
        metadata: { status, statusText, output: 'raw' },
      };
    }

    // Markdown mode via Defuddle
    const Defuddle = await loadDefuddle();
    const result = await Defuddle(html, url, { markdown: true });
    const content = result.content ?? '';
    const contentBytes = new TextEncoder().encode(content).byteLength;
    const { text: returnedContent, truncated } = truncateToBytes(content, maxBytes);

    return {
      url,
      title: result.title,
      content: returnedContent,
      contentBytes,
      truncated,
      metadata: {
        status,
        statusText,
        output: 'markdown',
        author: result.author,
        description: result.description,
        domain: result.domain,
        site: result.site,
        published: result.published,
        wordCount: result.wordCount,
      },
    };
  }
}
