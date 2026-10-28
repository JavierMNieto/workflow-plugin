#!/usr/bin/env node
// Claude Code hook (docs/workflow.md, "The three agents", "Asked in plain
// words"): the owner reads a question on his phone, in the question tool's
// dialog, with none of the chat in front of him, so a question that names
// code, or is a single sentence, is sent back to be rewritten.
//
//   plain-words.mjs prompt     on UserPromptSubmit: the turn's count of
//                              refusals back to none
//   plain-words.mjs question   on PreToolUse (AskUserQuestion): refuses a
//                              question that names code or is one sentence,
//                              with the rule as its reason, at most twice in
//                              a turn; the third call passes
//
// In every chat with the plugin's hooks, with or without a project file and
// in both forms, since the rule is about the reader, not the agent. The
// words a regular expression cannot judge ("the mailbox") are the rule's.
// No model call; a hook that fails does nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { owner } from "./project.mjs";

/** Refusals in one turn; the next call passes, as the turn audit passes its second stop. */
export const MAX_REFUSALS = 2;

/** The turn's count, in the OS temp directory as `agentPath` keeps the agent; none without a session. */
export function countPath(sessionId) {
  return sessionId ? join(tmpdir(), `workflow-plain-words-${sessionId}.json`) : "";
}

/** What names code, each signal a regular expression, matched after the addresses are taken out. */
const SIGNALS = [
  /`/g,
  // A path: segments with a slash and an extension, or one under a known directory.
  /\b[\w.-]+\/[\w./-]*\.\w+\b/g,
  /(?<![\w./-])(?:plans|\.claude|src|scripts|docs|test)\/[\w./-]*/g,
  // A dotted name of two word parts of two or more letters each (not e.g., not 2.1.113).
  /\b[A-Za-z_]\w+\.[A-Za-z_]\w+\b/g,
  /\b\w+_\w+\b/g,
  /\b\w+\(\)/g,
  // A flag: two dashes and a word, or one dash and a single letter.
  /(?<=^|\s)(?:--[a-z][\w-]*|-[a-z](?![\w-]))/g,
  // A long hex id has a letter and a digit: 10000000 is a number, 9b372186 an id.
  /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/g,
  /\b(?:Ctrl|Cmd|Alt|Shift|Option)\+(?:\w+|\S)/g,
];

const ADDRESS = /https?:\/\/\S+/g;

/** The code names in a text, once each; a name inside another found (the file of a path) is the longer one's. */
export function codeNames(text) {
  const plain = String(text || "").replace(ADDRESS, " ");
  const found = [];
  for (const signal of SIGNALS)
    for (const m of plain.matchAll(signal)) {
      if (found.some((one) => one.includes(m[0]))) continue;
      for (let i = found.length - 1; i >= 0; i--) if (m[0].includes(found[i])) found.splice(i, 1);
      found.push(m[0]);
    }
  return found;
}

/** Whether a question states something before it asks: fewer than two sentence ends is one sentence. */
export function singleSentence(text) {
  const plain = String(text || "").replace(ADDRESS, " ");
  // A full stop may close a quotation or a bracket first: 'He said "keep it." Should it close?'
  return (plain.match(/[.!?]["'\u201d\u2019)\]]*(?=\s|$)/g) || []).length < 2;
}

/** What the call's questions name and whether one is a single sentence. */
export function judge(questions = []) {
  const found = [];
  let single = false;
  for (const q of Array.isArray(questions) ? questions : []) {
    const fields = [
      q?.question,
      q?.header,
      ...(Array.isArray(q?.options) ? q.options : []).flatMap((o) => [o?.label, o?.description]),
    ];
    for (const field of fields)
      for (const one of codeNames(field)) if (!found.includes(one)) found.push(one);
    if (singleSentence(q?.question)) single = true;
  }
  return { found, single };
}

/** The reason the model reads, word for word; null when nothing is found. */
export function reasonFor({ found = [], single = false }, name = owner()) {
  if (!found.length && !single) return null;
  const names = found
    .slice(0, 3)
    .map((one) => `"${one}"`)
    .join(", ");
  const why = [found.length ? `names code (${names})` : "", single ? "is a single sentence" : ""]
    .filter(Boolean)
    .join(" and ");
  return `The question ${why}: ${name} reads it on his phone with none of this chat in front of him. Rewrite it by "Asked in plain words" (the workflow's docs): say what it is about in the words he used when he asked for it, the situation from the start in two or three sentences, and what each choice means to him and costs him; call things by what they do for him, not by their names in the code, and keep the names for the plan. Options are what he gets, a few words each, the recommended one first.`;
}

function readCount(path) {
  try {
    return Number(JSON.parse(readFileSync(path, "utf8")).refused) || 0;
  } catch {
    return 0;
  }
}

function main(mode) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const path = countPath(input.session_id);
  if (mode === "prompt") {
    if (path) writeFileSync(path, JSON.stringify({ refused: 0 }));
    return;
  }
  if (mode !== "question") return;
  const reason = reasonFor(judge(input.tool_input?.questions));
  if (!reason) return;
  // **Twice at most in a turn**: the third call passes. A call with no
  // session is checked and never counted.
  if (path) {
    const refused = readCount(path);
    if (refused >= MAX_REFUSALS) return;
    writeFileSync(path, JSON.stringify({ refused: refused + 1 }));
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  try {
    main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`plain-words ${process.argv[2]}: ${error.message}\n`);
  }
}
