#!/usr/bin/env node
/**
 * **The trial's report** (plans/reading-tools-trial.md, part 3): per
 * repository and arm, the runs, the success rate, the mean and median of
 * each token figure and of cost, the mean turns and seconds, and `tools`
 * against `native` in percent; the indexes' time and size; the noise floor
 * of a pass rate; and the decision rule of part 4 applied.
 *
 *   node trials/reading-tools/report.mjs [results.jsonl]
 *
 * `T = cache_creation + input`, what a session pays for new reading; the
 * pilot's lines are left out.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readResults, tokensOf } from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** The token saving, in percent of `native`'s T, at which the tools are worth wiring. */
export const SAVING = 20;
/** The most the success rate may fall, in points. */
export const LOSS = 10;

const FIGURES = ["T", "cache_creation", "cache_read", "input", "output", "cost"];

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** One run's figure by name. */
function figure(run, name) {
  if (name === "cost") return run.cost;
  if (!run.usage) return null;
  if (name === "T") return tokensOf(run.usage);
  return run.usage[name];
}

/**
 * **The summary**: `{ repos: { <repo>: { native, tools, delta, verdict } },
 * index, outcome }`, each arm's runs, success and figures; the delta in
 * percent of `native` for each mean, and in points for success.
 */
export function summarize(lines) {
  const runs = lines.filter((l) => l.kind === "run" && !l.pilot);
  const index = lines.filter((l) => l.kind === "index");
  const repos = {};
  for (const repo of [...new Set(runs.map((r) => r.repo))].sort()) {
    const arm = (name) => {
      const own = runs.filter((r) => r.repo === repo && r.arm === name);
      const out = {
        runs: own.length,
        success: own.length ? (100 * own.filter((r) => r.ok).length) / own.length : null,
        turns: mean(own.map((r) => r.turns).filter((x) => x != null)),
        seconds: mean(own.map((r) => r.seconds)),
        errors: own.filter((r) => r.error).length,
        // Runs that called either server at least once: whether the policy took.
        server: own.filter((r) => Object.keys(r.tools || {}).some((t) => t.startsWith("mcp__")))
          .length,
      };
      for (const f of FIGURES) {
        const xs = own.map((r) => figure(r, f)).filter((x) => x != null);
        out[f] = { mean: mean(xs), median: median(xs) };
      }
      return out;
    };
    const native = arm("native");
    const tools = arm("tools");
    const pct = (a, b) => (a == null || b == null || a === 0 ? null : (100 * (b - a)) / a);
    // With an arm missing there is nothing to compare, and the rule says nothing.
    const both = native.runs > 0 && tools.runs > 0;
    const delta = { success: both ? tools.success - native.success : null };
    for (const f of [...FIGURES, "turns", "seconds"]) {
      // A figure is `{ mean, median }`; turns and seconds are a mean, or null.
      const value = (x) => (x && typeof x === "object" ? x.mean : x);
      const a = value(native[f]);
      const b = value(tools[f]);
      delta[f] = pct(a, b);
    }
    const saves = both && delta.T != null && delta.T <= -SAVING;
    const keeps = both && delta.success >= -LOSS;
    repos[repo] = {
      native,
      tools,
      delta,
      noise: native.runs ? 100 / Math.sqrt(native.runs) : null,
      both,
      saves,
      keeps,
    };
  }
  const all = Object.values(repos);
  const outcome =
    !all.length || !all.every((r) => r.both)
      ? "incomplete: an arm has no runs"
      : all.every((r) => r.saves && r.keeps)
        ? "everywhere"
        : all.some((r) => !r.keeps) || !all.some((r) => r.saves)
          ? "drop"
          : "per project";
  return { repos, index, outcome };
}

const n = (x, digits = 0) =>
  x == null ? "–" : x.toLocaleString("en-US", { maximumFractionDigits: digits });
const signed = (x, unit = "%") => (x == null ? "–" : `${x > 0 ? "+" : ""}${x.toFixed(1)}${unit}`);

/** The report as Markdown tables, ready for results.md. */
export function format({ repos, index, outcome }) {
  const out = [];
  for (const [repo, r] of Object.entries(repos)) {
    out.push(`### ${repo}`, "");
    out.push("| | native | tools | tools against native |", "|---|---|---|---|");
    out.push(`| runs | ${r.native.runs} | ${r.tools.runs} | |`);
    out.push(
      `| success | ${n(r.native.success, 1)}% | ${n(r.tools.success, 1)}% | ${signed(r.delta.success, " points")} |`,
    );
    for (const f of FIGURES) {
      const d = f === "cost" ? 4 : 0;
      const cell = (a) => `${n(a[f].mean, d)} (median ${n(a[f].median, d)})`;
      out.push(`| ${f} | ${cell(r.native)} | ${cell(r.tools)} | ${signed(r.delta[f])} |`);
    }
    out.push(
      `| turns | ${n(r.native.turns, 1)} | ${n(r.tools.turns, 1)} | ${signed(r.delta.turns)} |`,
    );
    out.push(
      `| seconds | ${n(r.native.seconds, 1)} | ${n(r.tools.seconds, 1)} | ${signed(r.delta.seconds)} |`,
    );
    out.push(`| runs calling a server | ${r.native.server} | ${r.tools.server} | |`);
    out.push(`| runs with an error | ${r.native.errors} | ${r.tools.errors} | |`, "");
    out.push(
      `Noise floor of a pass rate: ±${n(r.noise, 0)} points. ` +
        `T ${signed(r.delta.T)} (the rule asks ${-SAVING}% or less): ${r.saves ? "holds" : "does not hold"}; ` +
        `success ${signed(r.delta.success, " points")} (no more than ${LOSS} under): ${r.keeps ? "holds" : "does not hold"}.`,
      "",
    );
  }
  if (index.length) {
    out.push("### The indexes", "", "| repo | jcodemunch | jdocmunch |", "|---|---|---|");
    for (const i of index)
      out.push(
        `| ${i.repo} | ${n(i.seconds.code, 1)} s, ${n(i.bytes.code / 1024)} KB | ${n(i.seconds.docs, 1)} s, ${n(i.bytes.docs / 1024)} KB |`,
      );
    out.push("");
  }
  out.push(`**Outcome by the rule: ${outcome}.**`);
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] || join(here, "results.jsonl");
  console.log(format(summarize(readResults(path))));
}
