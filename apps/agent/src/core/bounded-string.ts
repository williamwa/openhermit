/**
 * Bounded UTF-8 string accumulator for streamed child-process output.
 *
 * Long-running shell commands can emit hundreds of MB of stdout/stderr.
 * Buffering all of it in memory blows the agent process up and
 * subsequently bloats the session_events table when the result is
 * persisted. This helper caps the accumulated string at `maxBytes` and
 * appends a single human-readable truncation marker once the cap is hit.
 *
 * The cap is measured in UTF-8 *byte* length so we track real memory use
 * (a 4-byte emoji and a 1-byte ASCII char each cost what they cost on
 * the wire), but we keep the underlying storage as `string` so callers
 * can hand the result straight to JSON / fetch / drizzle without a
 * second decode.
 */
export class BoundedString {
  private parts: string[] = [];
  private bytes = 0;
  private droppedBytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number, private readonly label = 'output') {}

  /** Append a streamed chunk. Anything beyond `maxBytes` is dropped (counted, not stored). */
  append(chunk: string): void {
    if (this.truncated) {
      this.droppedBytes += Buffer.byteLength(chunk, 'utf8');
      return;
    }
    const chunkBytes = Buffer.byteLength(chunk, 'utf8');
    if (this.bytes + chunkBytes <= this.maxBytes) {
      this.parts.push(chunk);
      this.bytes += chunkBytes;
      return;
    }
    // Partial fit. Slice the chunk to the largest UTF-8-safe prefix that
    // still fits under the cap, then mark truncated.
    const remaining = this.maxBytes - this.bytes;
    if (remaining > 0) {
      const fitted = sliceUtf8(chunk, remaining);
      this.parts.push(fitted);
      this.bytes += Buffer.byteLength(fitted, 'utf8');
      this.droppedBytes += chunkBytes - Buffer.byteLength(fitted, 'utf8');
    } else {
      this.droppedBytes += chunkBytes;
    }
    this.truncated = true;
  }

  /** Returns the buffered text plus a trailing marker if truncation occurred. */
  finalize(): string {
    const body = this.parts.join('');
    if (!this.truncated) return body;
    const human = formatBytes(this.droppedBytes);
    return `${body}\n[truncated: ${this.label} exceeded ${formatBytes(this.maxBytes)} cap; dropped ${human}]`;
  }

  wasTruncated(): boolean {
    return this.truncated;
  }
}

/**
 * Trim a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte codepoint. We intentionally keep this naive (linear scan
 * from the end) — the chunks we receive from child-process pipes are
 * typically small and this only runs at the truncation boundary.
 */
const sliceUtf8 = (s: string, maxBytes: number): string => {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  // Walk back from the byte cap until we land on a UTF-8 codepoint
  // boundary (high two bits != 10xxxxxx — i.e. not a continuation byte).
  let cut = maxBytes;
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) cut -= 1;
  return buf.subarray(0, cut).toString('utf8');
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
};

/** Default cap shared by exec-backend and the Docker CLI runner. */
export const DEFAULT_EXEC_OUTPUT_MAX_BYTES = 256 * 1024;
