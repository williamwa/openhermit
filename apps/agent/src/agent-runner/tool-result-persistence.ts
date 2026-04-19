import type { AgentWorkspace } from '../core/index.js';

// ── Constants ──────────────────────────────────────────────────────────

/** Tool results larger than this (in chars) are persisted to disk. */
export const PERSIST_THRESHOLD_CHARS = 8_000;

/** Characters kept from the head of the content for the inline preview. */
export const PREVIEW_HEAD_CHARS = 3_000;

/** Characters kept from the tail of the content for the inline preview. */
export const PREVIEW_TAIL_CHARS = 1_500;

const TOOL_RESULTS_DIR = '.openhermit/tool_results';

// ── Head + tail preview ────────────────────────────────────────────────

/**
 * Build a head+tail preview of a long string.
 * Returns the original text unchanged when it fits within the budget.
 */
export const createHeadTailPreview = (
  text: string,
  headChars: number = PREVIEW_HEAD_CHARS,
  tailChars: number = PREVIEW_TAIL_CHARS,
): string => {
  const budget = headChars + tailChars;
  if (text.length <= budget) return text;

  // Try to break at a newline so we don't slice mid-line.
  const headCut = findNewlineBefore(text, headChars);
  const tailCut = findNewlineAfter(text, text.length - tailChars);
  const omitted = tailCut - headCut;

  const head = text.slice(0, headCut);
  const tail = text.slice(tailCut);
  return `${head}\n\n[... ${omitted.toLocaleString()} characters omitted ...]\n\n${tail}`;
};

/** Find the last newline at or before `pos`, but no earlier than 80% of `pos`. */
const findNewlineBefore = (text: string, pos: number): number => {
  const floor = Math.floor(pos * 0.8);
  const idx = text.lastIndexOf('\n', pos);
  return idx >= floor ? idx : pos;
};

/** Find the first newline at or after `pos`, but no later than `pos + 20%` of remaining. */
const findNewlineAfter = (text: string, pos: number): number => {
  const ceiling = pos + Math.floor((text.length - pos) * 0.2);
  const idx = text.indexOf('\n', pos);
  return idx !== -1 && idx <= ceiling ? idx : pos;
};

// ── File persistence ───────────────────────────────────────────────────

/** Build the workspace-relative path for a persisted tool result. */
export const toolResultPath = (toolCallId: string): string =>
  `${TOOL_RESULTS_DIR}/${toolCallId}.json`;

/**
 * Check whether a tool result exceeds the persistence threshold and, if so,
 * return a synchronous preview string.  The actual file write should happen
 * separately (e.g. inside `queueSideEffect`).
 *
 * Returns `null` when the text is short enough and needs no truncation.
 */
export const buildToolResultPreview = (
  toolCallId: string,
  fullText: string,
): { preview: string; filePath: string } | null => {
  if (fullText.length <= PERSIST_THRESHOLD_CHARS) return null;

  const filePath = toolResultPath(toolCallId);
  const preview = createHeadTailPreview(fullText);
  const footer = `\n\n[Output truncated — full text (${fullText.length.toLocaleString()} chars) saved to workspace/${filePath}. Use read_file to view the complete content if needed.]`;

  return { preview: preview + footer, filePath };
};

/** Persist the full tool result content to a workspace file. */
export const persistToolResult = async (
  workspace: AgentWorkspace,
  toolCallId: string,
  fullText: string,
): Promise<void> => {
  await workspace.writeFile(toolResultPath(toolCallId), fullText);
};
