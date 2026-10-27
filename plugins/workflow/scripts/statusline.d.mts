// The types of statusline.mjs's exports, for its tests: the script stays
// plain JavaScript so Claude Code runs it with node and nothing else.
export type Window = { used_percentage: number; resets_at: number };
export type Usage = { at: number; five_hour?: Window; seven_day?: Window };
export function statusFrom(input: object, now?: number): { line: string; usage: Usage | null };
