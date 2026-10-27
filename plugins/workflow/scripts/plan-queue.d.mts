// The types of plan-queue.mjs's exports, for its tests: the hook stays plain
// JavaScript so Claude Code runs it with node and nothing else.
import type { Usage } from "./statusline.mjs";

export type PlanState = {
  state: "brief" | "planning" | "built" | "building" | "handed" | "ready" | "old";
  kind?: string;
  day?: string;
  date?: number;
  mtime?: number;
  sha?: string;
  builtDay?: string;
  session?: string;
  since?: string;
  stale?: boolean;
  asks?: boolean;
  resumed?: string[];
  stuck?: boolean;
  branch?: string;
  step?: string;
};
export type Waiting = { path: string; related?: boolean; asks?: boolean; state?: string };
export type Handed = { path: string; stuck: boolean; resumed: string[] };
export type Run = { id: number; status: string; conclusion: string | null; onHead: boolean };
export type Lock = {
  sessionId: string;
  pid?: number | null;
  name?: string;
  taken?: number;
  released?: number | false;
};
export type StopDecision = {
  refuse?: true;
  reason?: string;
  runId?: number;
  told?: string[];
  retire?: true;
  paths?: string[];
  handover?: Handed;
  context?: string;
} | null;
export type StartDecision = {
  start?: true;
  name?: string;
  note?: string;
  defer?: true;
  until?: number;
  refuse?: true;
  why?: string;
};

export const QUEUE_SINCE: number;
export const FIVE_HOUR_MAX: number;
export const SEVEN_DAY_MAX: number;
export function parseDay(text: string): number;
export function today(now?: number): string;
export function stateOf(
  text: string,
  options?: { mtime?: number; live?: string[] | null },
): PlanState | null;
export function pathsIn(text: string): string[];
/** Whether a session's working directory is this checkout, one of its worktrees, or under one. */
export function inThisRepo(cwd: string | undefined, paths: string[]): boolean;
/** The rows a project counts as its own: in its checkout or worktrees, or named by its lock or plans. */
export function ownRows<R extends { sessionId?: string; cwd?: string }>(
  rows: R[],
  options?: { paths?: string[]; lockId?: string; named?: string[] },
): R[];
export function liveSessions(options?: { fresh?: boolean; timeout?: number }): LiveRow[] | null;
export function data(env?: Record<string, string | undefined>, scriptDir?: string): string;
export function owner(env?: Record<string, string | undefined>, settings?: string): string;
export function kindOf(input: { agent_type?: string } | null | undefined): string;
/** A started chat's environment, without the root and the hook variables. */
export function sessionEnv(
  env?: Record<string, string | undefined>,
): Record<string, string | undefined>;
export function takeLock(
  sessionId: string,
  live: LiveRow[] | null,
  options?: { path?: string; alive?: ((lock: Lock) => boolean) | null },
): boolean;
export function changedFiles(state: { sessionId: string; base?: string }, dir?: string): string[];
export function related(text: string, changed: string[]): boolean;
export function briefPaths(text: string): string[];
export function relatedBrief(briefText: string, ownTexts?: string[], ownPaths?: string[]): boolean;
export function withPlans<
  S extends { agent?: string; brief?: string; planned?: boolean; plans?: string[] },
>(state: S): S & { plans?: string[] };
export type LiveRow = {
  sessionId: string;
  id?: string;
  name?: string;
  status?: string;
  cwd?: string;
  kind?: string;
  pid?: number;
  waitingFor?: string;
};
export type Tree = { path: string; branch: string };
/** A live executor or planner session, as its line and `canStart` see it. */
export type Session = {
  kind: "executor" | "planner";
  sessionId: string;
  id: string;
  name: string;
  status: string;
  where: string;
  branch: string;
  holdsLock: boolean;
  retired: boolean;
  /** The plan an executor's Building line, or the brief a planner's Planning line, names. */
  on: string;
  /** A planner's plans, in the order it wrote them. */
  holds?: string[];
  /** A planner's compactions. */
  compactions?: number;
};
export function worktrees(): Tree[];
export function isSession(
  kind: "executor" | "planner",
  row: LiveRow,
  state: { agent?: string } | null | undefined,
  lock: Lock | null,
): boolean;
export function sessionsOf(
  kind: "executor" | "planner",
  live: LiveRow[] | null,
  lock: Lock | null,
  options?: {
    trees?: Tree[];
    plans?: { state: string; session?: string; path: string }[];
    stateFor?: (
      sessionId: string,
    ) => { agent?: string; retired?: boolean; plans?: string[]; compactions?: number } | null;
  },
): Session[];
export function describeSession(one: Session): string;
export type WaitingBrief = { path: string; related?: boolean };
export function decidePlannerStop(facts: {
  current?: { path: string } | null;
  waiting?: WaitingBrief[];
  compactions?: number;
  told?: string[];
  paused?: boolean;
  retired?: boolean;
}):
  | { retire: true; related: boolean; declined?: boolean }
  | { refuse: true; told: string[]; reason: string }
  | null;
export function plannerMayEdit(facts: {
  plans?: string[];
  brief?: string;
  toolName?: string;
  filePath?: string;
  base?: string;
}): boolean;
export function planEdited(facts: { plans?: string[]; filePath?: string; base?: string }): string;
export function planTaken(text?: string): boolean;
export function whoTook(text?: string, live?: LiveRow[] | null): string;
export function plannerContext(
  state: { plans?: string[]; retired?: boolean } | null,
  live?: LiveRow[] | null,
  textOf?: (path: string) => string,
): string;
export type PlannerState = {
  agent?: string;
  retired?: boolean;
  brief?: string;
  planned?: boolean;
  plans?: string[];
  stopAsked?: number;
};
export function stopPlannersOn(
  path: string,
  live: LiveRow[] | null,
  options?: {
    stateFor?: (sessionId: string) => PlannerState | null;
    textOf?: (path: string) => string;
    stop?: (sessionId: string, live: LiveRow[] | null) => void;
    write?: (path: string, value: object) => void;
    now?: number;
  },
): void;
export function stopTakenPlanners(
  live: LiveRow[] | null,
  options?: {
    stateFor?: (sessionId: string) => PlannerState | null;
    textOf?: (path: string) => string;
    stop?: (sessionId: string, live: LiveRow[] | null) => void;
    write?: (path: string, value: object) => void;
    now?: number;
  },
): void;
export function stopRetiredPlanners(
  live: LiveRow[] | null,
  options?: {
    except?: string;
    stateFor?: (sessionId: string) => { agent?: string; retired?: boolean } | null;
    stop?: (sessionId: string, live: LiveRow[] | null) => void;
  },
): void;
export function plannerPrompt(path: string): string;
export function versionLine(
  live: LiveRow[] | null,
  options?: { installed?: string; versionOf?: (pid?: number) => string },
): string;
export function queueBehindTest(): boolean;
export function sync(options?: { fetch?: boolean }): string;
export function agentEffort(agent: string, dir?: string): string;
export function start(
  paths: string[],
  options?: {
    replace?: string;
    dry?: boolean;
    agent?: string;
    at?: number;
    timer?: boolean;
  },
): string;
export function list(options?: { all?: boolean; live?: LiveRow[] | null }): string;
export function lockHeldByOther(
  lock: Lock | null,
  sessionId: string,
  alive?: (pid?: number | null) => boolean,
): boolean;
export function allowedWhileLocked(command: string): boolean;
export function countCompaction<S extends { compactions?: number; lastCompactAt?: number }>(
  state: S,
  now?: number,
): S;
export function decideStop(facts: {
  compactions?: number;
  waiting?: Waiting[];
  handed?: Handed[];
  run?: Run | null;
  told?: string[];
  paused?: boolean | string;
  retired?: boolean;
  current?: { path: string } | null;
  continuing?: boolean;
  refusedRun?: number | null;
}): StopDecision;
export function decideResumed(facts: {
  compactions?: number;
  plan?: { path: string; stuck?: boolean } | null;
}): string;
export function canStart(facts: {
  kind?: "executor" | "planner";
  lock?: Lock | null;
  alive?: (pid?: number | null) => boolean;
  log?: { at: number; name: string }[];
  progressAt?: number;
  now?: number;
  paused?: boolean | string;
  usage?: Usage | null;
  sessions?: Session[];
  /** The brief a planner start was asked for, named in the message to send a live planner. */
  brief?: string;
}): StartDecision;
export function cutoffEdit(
  text: string,
  options: { sessionId: string; branch: string; day?: string },
): string;
export function readPlans(
  dir?: string,
  live?: string[] | null,
): (PlanState & { path: string; file: string; text: string })[];
export function resetTime(usage: Partial<Usage> | null, transcriptText?: string): number;
