import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { ValidationError } from '@openhermit/shared';

import { asTextContent } from './shared.js';

const MAX_RESPONSE_BYTES = 200_000;

const WebFetchParams = Type.Object({
  url: Type.String({
    description: 'Fully-qualified URL to fetch over HTTP(S).',
  }),
  max_bytes: Type.Optional(
    Type.Number({
      description: `Maximum response body bytes to return. Defaults to ${MAX_RESPONSE_BYTES}.`,
    }),
  ),
  output: Type.Optional(
    Type.Union([
      Type.Literal('raw', {
        description: 'Return the raw HTTP response body.',
      }),
      Type.Literal('markdown', {
        description:
          'Extract main article content as Markdown (default); best for blog posts and documentation.',
      }),
    ], {
      description:
        "Format of returned content: 'raw' is the unprocessed HTTP body; 'markdown' extracts main content via Defuddle.",
    }),
  ),
});

type WebFetchArgs = Static<typeof WebFetchParams>;

async function executeFetchBackend(
  args: WebFetchArgs,
  limit: number,
): Promise<{ summary: string; details: Record<string, unknown> }> {
  const url = new URL(args.url);
  const response = await fetch(url, { method: 'GET' });

  const rawBuffer = await response.arrayBuffer();
  const rawBytes = rawBuffer.byteLength;
  const truncated = rawBytes > limit;
  const bodyBytes = truncated ? rawBuffer.slice(0, limit) : rawBuffer;
  const body = new TextDecoder('utf-8', { fatal: false }).decode(bodyBytes);

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  const details: Record<string, unknown> = {
    url: args.url,
    method: 'GET',
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
    body,
    bodyBytes: rawBytes,
    output: 'raw',
  };
  if (truncated) {
    details.truncated = true;
    details.returnedBytes = limit;
  }

  const summary =
    truncated
      ? `HTTP ${response.status} ${response.statusText} — ${rawBytes} bytes (truncated to ${limit})\n\n${body}`
      : `HTTP ${response.status} ${response.statusText} — ${rawBytes} bytes\n\n${body}`;

  return { summary, details };
}

async function executeDefuddleBackend(
  args: WebFetchArgs,
  limit: number,
): Promise<{ summary: string; details: Record<string, unknown> }> {
  const url = new URL(args.url);
  const response = await fetch(url, { method: 'GET' });

  if (!response.ok) {
    const body = await response.text();
    const details: Record<string, unknown> = {
      url: args.url,
      method: 'GET',
      status: response.status,
      statusText: response.statusText,
      output: 'markdown',
    };
    const summary = `HTTP ${response.status} ${response.statusText}\n\n${body.slice(0, limit)}`;
    return { summary, details };
  }

  const rawBuffer = await response.arrayBuffer();
  const rawBytes = rawBuffer.byteLength;
  const html = new TextDecoder('utf-8', { fatal: false }).decode(rawBuffer);

  let DefuddleFn: (htmlOrDom: string, url?: string, options?: { markdown?: boolean }) => Promise<{
    content: string;
    title?: string;
    author?: string;
    description?: string;
    domain?: string;
    site?: string;
    published?: string;
    wordCount?: number;
  }>;
  try {
    const node = await import('defuddle/node');
    DefuddleFn = node.Defuddle;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ValidationError(
      `web_fetch output "markdown" requires the defuddle package: ${msg}`,
    );
  }

  const result = await DefuddleFn(html, args.url, { markdown: true });
  const content = result.content ?? '';
  const contentBytes = new TextEncoder().encode(content).byteLength;
  const truncated = contentBytes > limit;
  const returnedContent = truncated
    ? new TextDecoder('utf-8', { fatal: false }).decode(
        new TextEncoder().encode(content).slice(0, limit),
      )
    : content;

  const meta: string[] = [];
  if (result.title) meta.push(`Title: ${result.title}`);
  if (result.author) meta.push(`Author: ${result.author}`);
  if (result.site) meta.push(`Site: ${result.site}`);
  if (result.published) meta.push(`Published: ${result.published}`);
  if (result.wordCount != null) meta.push(`Words: ${result.wordCount}`);

  const summary =
    meta.length > 0
      ? `[Defuddle] ${meta.join(' | ')}\n\n${returnedContent}`
      : returnedContent;
  if (truncated) {
    const suffix = `\n\n[Content truncated to ${limit} bytes; total ${contentBytes} bytes.]`;
    return {
      summary: summary + suffix,
      details: {
        url: args.url,
        method: 'GET',
        status: response.status,
        statusText: response.statusText,
        output: 'markdown',
        title: result.title,
        author: result.author,
        description: result.description,
        domain: result.domain,
        site: result.site,
        published: result.published,
        wordCount: result.wordCount,
        contentBytes,
        truncated: true,
        returnedBytes: limit,
      },
    };
  }

  return {
    summary,
    details: {
      url: args.url,
      method: 'GET',
      status: response.status,
      statusText: response.statusText,
      output: 'markdown',
      title: result.title,
      author: result.author,
      description: result.description,
      domain: result.domain,
      site: result.site,
      published: result.published,
      wordCount: result.wordCount,
      contentBytes,
    },
  };
}

export const createWebFetchTool = (): AgentTool<typeof WebFetchParams> => ({
  name: 'web_fetch',
  label: 'Web Fetch',
  description:
    'Perform an HTTP GET request and return the response. Use output "markdown" (default) to extract main article content as Markdown, or "raw" for the unprocessed HTTP body. Responses are truncated at max_bytes to avoid flooding the context window.',
  parameters: WebFetchParams,
  execute: async (_toolCallId, args: WebFetchArgs) => {
    const url = new URL(args.url);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(
        `web_fetch only supports http/https URLs, got: ${url.protocol}`,
      );
    }

    const requestedBytes = args.max_bytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isFinite(requestedBytes) || requestedBytes < 1) {
      throw new ValidationError('web_fetch max_bytes must be a positive number.');
    }

    const limit = Math.min(Math.floor(requestedBytes), MAX_RESPONSE_BYTES);
    const output = args.output ?? 'markdown';

    const { summary, details } =
      output === 'raw'
        ? await executeFetchBackend(args, limit)
        : await executeDefuddleBackend(args, limit);

    return {
      content: asTextContent(summary),
      details,
    };
  },
});
