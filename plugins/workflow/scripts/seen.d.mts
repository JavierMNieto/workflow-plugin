// The types of seen.mjs's exports, for its tests: the hook stays plain
// JavaScript so Claude Code runs it with node and nothing else.
export type Seen = Record<string, number>;
/** The paths a brief or a planner's plan names, bare root names included. */
export function briefPaths(text: string): string[];
/** What one tool call adds to what the chat holds of each file, in tokens. */
export function seenIn(
  input: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: unknown;
    cwd?: string;
  },
  options?: { checkout?: string },
): Seen;
/** The session's append-only count, `workflow-seen-<id>.jsonl` in `dir`. */
export function seenFile(sessionId: string, dir?: string): string;
/** Appends one line per path of `map` to the session's count. */
export function noteSeen(sessionId: string, map: Seen, dir?: string): void;
/** The session's count summed per path; `{}` with none. */
export function seenOf(sessionId: string, dir?: string): Seen;
