import type { ApprovalDecision } from '../tools.js';

const APPROVAL_TIMEOUT_MS = 120_000;

export class ApprovalGate {
  private readonly pending = new Map<
    string,
    {
      resolve: (decision: ApprovalDecision) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  request(toolCallId: string): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(toolCallId);
        resolve('timed_out');
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(toolCallId, { resolve, timeout });
    });
  }

  respond(toolCallId: string, approved: boolean): boolean {
    const pending = this.pending.get(toolCallId);

    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(toolCallId);
    pending.resolve(approved ? 'approved' : 'rejected');
    return true;
  }

  cancelAll(): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timeout);
      entry.resolve('cancelled');
    }

    this.pending.clear();
  }
}
