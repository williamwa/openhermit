export type {
  WebProvider,
  WebSearchResult,
  WebSearchOptions,
  WebFetchResult,
  WebFetchOptions,
} from './types.js';

export { createWebProvider } from './factory.js';
export { DefuddleWebProvider } from './providers/defuddle.js';
export { ExaWebProvider } from './providers/exa.js';
export { TavilyWebProvider } from './providers/tavily.js';
