import { GatewayClient } from '@openhermit/sdk';

/** Resolve the gateway base URL from environment. */
export const resolveGatewayUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.OPENHERMIT_GATEWAY_URL) return env.OPENHERMIT_GATEWAY_URL;
  const port = env.GATEWAY_PORT ?? env.PORT ?? '4000';
  return `http://127.0.0.1:${port}`;
};

/** Build a GatewayClient from environment. */
export const createGateway = (): GatewayClient => {
  const url = resolveGatewayUrl();
  const token = process.env.OPENHERMIT_TOKEN ?? '';
  return new GatewayClient({ baseUrl: url, token });
};

/** Print a formatted table of objects. */
export const printTable = (
  rows: Record<string, string>[],
  columns: { key: string; label: string; width?: number }[],
): void => {
  const widths = columns.map((col) => {
    const max = rows.reduce(
      (m, row) => Math.max(m, (row[col.key] ?? '').length),
      col.label.length,
    );
    return col.width ?? max;
  });

  const header = columns
    .map((col, i) => col.label.padEnd(widths[i]!))
    .join('  ');
  console.log(header);
  console.log(widths.map((w) => '─'.repeat(w)).join('──'));

  for (const row of rows) {
    const line = columns
      .map((col, i) => (row[col.key] ?? '').padEnd(widths[i]!))
      .join('  ');
    console.log(line);
  }
};

/** Handle errors from gateway calls gracefully. */
export const handleError = (error: unknown): never => {
  if (error instanceof Error) {
    console.error(`Error: ${error.message}`);
  } else {
    console.error(`Error: ${String(error)}`);
  }
  process.exit(1);
};
