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
});

type WebFetchArgs = Static<typeof WebFetchParams>;

export const createWebFetchTool = (): AgentTool<typeof WebFetchParams> => ({
  name: 'web_fetch',
  label: 'Web Fetch',
  description:
    'Perform an HTTP GET request and return the response body as text. Useful for reading documentation or checking public URLs. Responses are truncated at max_bytes to avoid flooding the context window.',
  parameters: WebFetchParams,
  execute: async (_toolCallId, args: WebFetchArgs) => {
    const url = new URL(args.url);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ValidationError(`web_fetch only supports http/https URLs, got: ${url.protocol}`);
    }

    const requestedBytes = args.max_bytes ?? MAX_RESPONSE_BYTES;
    if (!Number.isFinite(requestedBytes) || requestedBytes < 1) {
      throw new ValidationError('web_fetch max_bytes must be a positive number.');
    }

    const limit = Math.min(Math.floor(requestedBytes), MAX_RESPONSE_BYTES);
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

    const details = {
      url: args.url,
      method: 'GET',
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body,
      bodyBytes: rawBytes,
      ...(truncated ? { truncated: true, returnedBytes: limit } : {}),
    };

    const summary = truncated
      ? `HTTP ${response.status} ${response.statusText} — ${rawBytes} bytes (truncated to ${limit})\n\n${body}`
      : `HTTP ${response.status} ${response.statusText} — ${rawBytes} bytes\n\n${body}`;

    return {
      content: asTextContent(summary),
      details,
    };
  },
});
