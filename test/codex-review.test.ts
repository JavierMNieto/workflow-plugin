import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * **The Codex review is one bounded call that never gates**
 * (docs/workflow.md, "A second model reviews every plan's diff"): the real script, run against a throwaway
 * repository with a stub `codex` first on the PATH, in every way it can end.
 */
const script = join(__dirname, "..", "plugins", "workflow", "scripts", "codex-review.sh");
let repo: string;
let bin: string;
let home: string;

const STUB = `#!/usr/bin/env bash
if [ "$1" = "login" ]; then
  # The real codex prints its login status on stderr.
  if [ "\${CODEX_STUB_MODE}" = "signed-out" ]; then echo "Not logged in" >&2; else echo "Logged in using ChatGPT" >&2; fi
  exit 0
fi
case "\${CODEX_STUB_MODE}" in
  limit) echo "You've hit your usage limit" >&2; exit 1 ;;
  slow) sleep 5; exit 0 ;;
  nosandbox) echo "bwrap: No permissions to create new namespace, likely because..." >&2; exit 0 ;;
  broken) echo "boom" >&2; exit 3 ;;
esac
printf '%s\\n' "$@" > "\${CODEX_STUB_ARGS}"
# The report is codex exec's last message, written where -o points; -C is where it reads.
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2" ;; -C) dir="$2" ;; esac
  shift
done
{
  echo "pwd=$dir"
  [ -e "$dir/.env" ] && echo "env-file=yes" || echo "env-file=no"
} > "\${CODEX_STUB_SEEN}"
printf '%s\\n' "**C1. A claim** (High, Confirmed)" "**C2. Another** (Low, Plausible)" > "$out"
`;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "codex-review-repo-"));
  bin = mkdtempSync(join(tmpdir(), "codex-review-bin-"));
  home = mkdtempSync(join(tmpdir(), "codex-review-home-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  git("init", "-q", "-b", "base");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "one");
  git("switch", "-q", "-c", "work");
  writeFileSync(join(repo, "a.txt"), "two\n");
  git("commit", "-q", "-am", "two");
  // Untracked, as every .env is: the worktree Codex reads must not have it.
  writeFileSync(join(repo, ".env"), "SECRET=1\n");
  writeFileSync(join(bin, "codex"), STUB);
  chmodSync(join(bin, "codex"), 0o755);
});

afterAll(() => {
  for (const dir of [repo, bin, home]) rmSync(dir, { recursive: true, force: true });
});

function review(mode: string | null, extra: Record<string, string> = {}) {
  const out = join(repo, "plans", "x", "codex-review.md");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    WORKFLOW_DATA: join(home, "data"),
    CODEX_STUB_ARGS: join(home, "args"),
    CODEX_STUB_SEEN: join(home, "seen"),
    ...extra,
  };
  if (mode === null) env.PATH = "/usr/bin:/bin";
  else {
    env.PATH = `${bin}:${process.env.PATH}`;
    env.CODEX_STUB_MODE = mode;
  }
  const said = execFileSync("bash", [script, "base", out, "A title"], {
    cwd: repo,
    env,
    encoding: "utf8",
  }).trim();
  return { said, out };
}

const worktrees = () =>
  execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;

describe("codex-review.sh", () => {
  it("says codex is not installed, and writes nothing", () => {
    const { said, out } = review(null);
    expect(said).toBe("codex review: not run: codex is not installed");
    expect(existsSync(out)).toBe(false);
  });

  it("says codex is not signed in", () => {
    expect(review("signed-out").said).toBe(
      "codex review: not run: codex is not signed in; run codex login",
    );
  });

  it("reviews in a throwaway worktree with no .env, writes the report and logs one line", () => {
    const { said, out } = review("ok", { DATABASE_URL: "postgres://secret" });
    expect(said).toBe(`codex review: written to ${out}`);
    expect(readFileSync(out, "utf8")).toContain("**C1. A claim** (High, Confirmed)");
    const seen = readFileSync(join(home, "seen"), "utf8");
    expect(seen).not.toContain(`pwd=${repo}\n`);
    expect(seen).toContain("env-file=no");
    const args = readFileSync(join(home, "args"), "utf8").split("\n");
    expect(args[0]).toBe("exec");
    expect(args.slice(args.indexOf("-s"), args.indexOf("-s") + 2)).toEqual([
      "-s",
      "danger-full-access",
    ]);
    expect(args).toContain("--ephemeral");
    expect(args).toContain('shell_environment_policy.inherit="core"');
    expect(args.join("\n")).toMatch(/Change no file: read and report\s+only\.\s*$/);
    // The tool rules of the project's notes are Claude Code's; Codex once stopped to ask.
    expect(args.join("\n")).toMatch(/read\s+with git, cat, sed and grep/);
    expect(args.join("\n")).toContain('`git diff base...HEAD` in this checkout, titled "A title"');
    expect(worktrees()).toBe(1);
    const log = readFileSync(join(home, "data", "codex-review.log"), "utf8")
      .trim()
      .split("\n");
    expect(log.at(-1)).toMatch(/^\S+Z base 0 \d+$/);
  });

  it("says when it is over the usage limit, and keeps the log", () => {
    const { said, out } = review("limit");
    expect(said).toBe("codex review: not run: over the usage limit");
    expect(readFileSync(`${out}.log`, "utf8")).toContain("usage limit");
  });

  it("stops at the timeout and removes the worktree", () => {
    expect(review("slow", { CODEX_REVIEW_TIMEOUT: "1s" }).said).toBe(
      "codex review: not run: timed out after 1s",
    );
    expect(worktrees()).toBe(1);
  });

  it("says when codex's sandbox cannot start, and keeps no report", () => {
    const { said, out } = review("nosandbox");
    expect(said).toBe(
      "codex review: not run: codex's sandbox cannot start here (no user namespaces)",
    );
    expect(existsSync(out)).toBe(false);
  });

  it("says how codex exited otherwise", () => {
    expect(review("broken").said).toBe("codex review: not run: codex exited 3");
  });
});
