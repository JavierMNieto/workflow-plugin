// The types of turn-audit.mjs's exports, for its tests: the hook stays plain
// JavaScript so Claude Code runs it with node and nothing else.
export type Files = Record<string, [number, number]>;
export type TurnState = {
  prompt?: string;
  agent?: string;
  files: Files;
  audited?: boolean;
  wrote?: string[];
  shell?: boolean;
  calls?: string[];
};
export type ToolEvent = {
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string };
};
export function treeFiles(dir?: string): Files;
export function changedSince(snapshot: Files, now: Files): string[];
export function shellWrites(command: string): boolean;
export function recordTool<S extends TurnState>(
  state: S,
  input: ToolEvent,
  dir?: string,
  tools?: string[],
): S;
export function listToJudge(state: TurnState, now: Files): string[];
export function untiered(text: string): string[];
export function agentsChoice(text: string, day?: string | string[]): string[];
export function reasonFor(
  changed: string[],
  prompt: string,
  lastMessage: string,
  rule?: {
    ui?: RegExp[];
    catalogue?: string;
    texts?: Record<string, string>;
    inherits?: string[];
    who?: string;
    day?: string;
    calls?: string[];
    wrote?: string[];
  },
): string;
