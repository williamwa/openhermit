import type { Toolset, ToolContext } from './shared.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';

const WEB_DESCRIPTION = `\
### Web

Use \`web_search\` to search the web and \`web_fetch\` to fetch a URL and extract its content.`;

export const createWebToolset = (context: ToolContext): Toolset => ({
  id: 'web',
  description: WEB_DESCRIPTION,
  tools: [createWebSearchTool(context), createWebFetchTool(context)],
});
