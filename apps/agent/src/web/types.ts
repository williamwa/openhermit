export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string | undefined;
  publishedDate?: string | undefined;
  score?: number | undefined;
}

export interface WebSearchOptions {
  /** Maximum number of results. Default 5, max 10. */
  limit?: number | undefined;
  includeDomains?: string[] | undefined;
  excludeDomains?: string[] | undefined;
  /** Request full page content instead of snippets. */
  contentMode?: 'snippet' | 'full' | undefined;
}

export interface WebFetchResult {
  url: string;
  title?: string | undefined;
  content: string;
  contentBytes: number;
  truncated: boolean;
  metadata?: Record<string, unknown> | undefined;
}

export interface WebFetchOptions {
  /** Maximum response bytes. Default 200KB. */
  maxBytes?: number | undefined;
  /** 'markdown' extracts main content; 'raw' returns unprocessed body. */
  output?: 'raw' | 'markdown' | undefined;
}

export interface WebProvider {
  readonly name: string;
  search(query: string, options?: WebSearchOptions): Promise<WebSearchResult[]>;
  fetch(url: string, options?: WebFetchOptions): Promise<WebFetchResult>;
}
