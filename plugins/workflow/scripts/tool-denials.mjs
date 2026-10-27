#!/usr/bin/env node
// Claude Code hook (docs/workflow.md, "The project file", the `deny`
// paragraph): keeps an agent off the MCP tools the project file's `deny` key
// names for it, which a plugin agent's own frontmatter cannot be extended to
// say from a project, and a settings deny would say for every agent alike.
//
//   tool-denials.mjs tool     on PreToolUse (mcp__.*): refuses a call whose
//                             tool name a pattern of the agent's, or of its
//                             session's agent's, matches whole, with the
//                             reason the model reads
//   tool-denials.mjs prompt   on UserPromptSubmit: records the session's
//                             agent, so a subagent started from it (whose
//                             hook input names its own type) is held to it
//
// Nothing without a project file naming `deny`; in both forms, full and
// compact, and in every chat with the plugin's hooks. The tool stays listed;
// the call never runs. No model call; a hook that fails does nothing.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { everyTool, kindOf, matches, pluginAgents, project } from "./project.mjs";

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

/** The session's recorded agent, in the OS temp directory as the catalogue hook keeps its state; none without a session. */
export function agentPath(sessionId) {
  return sessionId ? join(tmpdir(), `workflow-agent-${sessionId}.json`) : "";
}

/** What the model reads when a call is refused. */
export function reasonFor(tool, agent) {
  return `${tool} is not the ${agent}'s here: .claude/workflow.md denies it (deny, ${agent}). Do not reach it another way; say so when the answer needs it.`;
}

function readRecorded(sessionId) {
  const path = agentPath(sessionId);
  if (!path) return "";
  try {
    return String(JSON.parse(readFileSync(path, "utf8")).agent || "");
  } catch {
    return "";
  }
}

function main(mode) {
  const proj = project(root);
  if (!proj.found) return;
  const denies = Object.keys(proj.deny).length > 0;
  if (mode === "tool" && !denies) return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  if (mode === "prompt") {
    const path = agentPath(input.session_id);
    if (!path) return;
    const agent = kindOf(input);
    // A chat with no agent of the plugin's, or a project with no `deny`,
    // leaves no record, so nothing stale is read when the key comes back.
    if (denies && agent && pluginAgents().includes(agent))
      writeFileSync(path, JSON.stringify({ agent }));
    else
      try {
        unlinkSync(path);
      } catch {
        // None recorded.
      }
    return;
  }
  if (mode !== "tool") return;
  // **Two lists hold**: the input's own agent's, and the session's recorded
  // agent's, since a subagent's input names its own type (the hooks
  // reference); a subagent with a list of its own is still held to its
  // session's. Nothing is written in this mode. A connector named alone
  // denies its every tool.
  const tool = String(input.tool_name || "");
  const agent = [kindOf(input), readRecorded(input.session_id)].find(
    (one) => Object.hasOwn(proj.deny, one) && matches(proj.deny[one].map(everyTool), tool),
  );
  if (!agent) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reasonFor(tool, agent),
      },
    }),
  );
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  try {
    main(process.argv[2]);
  } catch (error) {
    process.stderr.write(`tool-denials ${process.argv[2]}: ${error.message}\n`);
  }
}
