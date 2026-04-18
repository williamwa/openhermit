/**
 * Ring buffer that captures log lines for the admin UI.
 */

export interface LogEntry {
  timestamp: string;
  message: string;
}

export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  push(message: string): void {
    if (this.entries.length >= this.maxSize) {
      this.entries.shift();
    }
    this.entries.push({ timestamp: new Date().toISOString(), message });
  }

  /** Return the last `n` entries (default: all). */
  tail(n?: number): LogEntry[] {
    if (n === undefined || n >= this.entries.length) return [...this.entries];
    return this.entries.slice(-n);
  }

  /** Wrap a log function so it also captures to this buffer. */
  wrap(fn: (message: string) => void): (message: string) => void {
    return (message: string) => {
      fn(message);
      this.push(message);
    };
  }
}
