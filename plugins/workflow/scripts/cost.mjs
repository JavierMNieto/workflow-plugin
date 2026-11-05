// **`plans cost` measures the queue** (plans/reuse-ceiling-per-agent.md, part
// 6): each session's turns, context and cost by agent, from the transcripts
// of this checkout, at the prices below with the date they were read. The
// reuse ceilings rest on these numbers (docs/decisions.md#context-cost), so
// they are measured again, not remembered.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The prices a million tokens, as Anthropic's pricing page gave them on the
 * day `read`; `write` is the one-hour cache write, which Claude Code uses. A
 * model is matched by its id's prefix.
 */
export const PRICES = {
  read: "2026-11-05",
  page: "platform.claude.com/docs/en/about-claude/pricing",
  models: {
    "claude-fable-5-1": { name: "Fable 5.1", input: 10, write: 20, read: 0.25, output: 50 },
    "claude-opus-5-5": { name: "Opus 5.5", input: 4, write: 8, read: 0.2, output: 20 },
  },
};

/** The model a price is taken from when a transcript's model is not in `PRICES`. */
const FALLBACK = "claude-opus-5-5";

const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

/** "5 November 2026" for a `yyyy-mm-dd` or an epoch time, as the plans write a day. */
function day(at) {
  const d = typeof at === "string" ? new Date(`${at}T00:00:00Z`) : new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * One row per transcript in `dir` (`*.jsonl`) whose first turn is on or after
 * `since` (`yyyy-mm-dd`, optional): `{ id, agent, model, models, turns,
 * maxContext, endContext, read, write, input, output, cost, compactions,
 * start }`. The main thread only (a sidechain's turns are a subagent's), each
 * assistant turn once by its message id, its last entry's usage, Claude Code's own `<synthetic>`
 * entries passed over; each turn priced at its own model's prices (`cost`, by
 * part; `models`, every model seen), so a session that changed model mid-way
 * is not priced at its last; `start` the first turn's epoch time.
 */
export function measure(dir, { since = "" } = {}) {
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const from = since ? Date.parse(`${since}T00:00:00Z`) : 0;
  const rows = [];
  for (const name of names) {
    let text = "";
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    const row = {
      id: name.replace(/\.jsonl$/, ""),
      agent: "",
      model: "",
      models: [],
      turns: 0,
      maxContext: 0,
      endContext: 0,
      read: 0,
      write: 0,
      input: 0,
      output: 0,
      cost: { input: 0, write: 0, read: 0, output: 0 },
      compactions: 0,
      start: 0,
    };
    // One turn per message id, the last entry written for it: Claude Code
    // writes an entry per content block, and the last carries the turn's
    // final usage. A turn keeps its place from its first entry.
    const turns = new Map();
    let unnamed = 0;
    for (const line of text.split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === "agent-setting") row.agent = entry.agentSetting || "";
      if (entry.type === "system" && entry.subtype === "compact_boundary") row.compactions++;
      const message = entry.message;
      if (entry.type !== "assistant" || !message?.usage || entry.isSidechain) continue;
      if (message.model === "<synthetic>") continue;
      const id = message.id || `unnamed-${unnamed++}`;
      const first = turns.get(id)?.at;
      turns.set(id, { message, at: first ?? (Date.parse(entry.timestamp) || 0) });
    }
    for (const { message, at } of turns.values()) {
      const u = message.usage;
      const context =
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0);
      row.model = message.model || row.model;
      if (!row.models.includes(row.model)) row.models.push(row.model);
      const { price } = priceOf(row.model);
      row.cost.input += ((u.input_tokens || 0) * price.input) / 1_000_000;
      row.cost.write += ((u.cache_creation_input_tokens || 0) * price.write) / 1_000_000;
      row.cost.read += ((u.cache_read_input_tokens || 0) * price.read) / 1_000_000;
      row.cost.output += ((u.output_tokens || 0) * price.output) / 1_000_000;
      row.turns++;
      row.maxContext = Math.max(row.maxContext, context);
      row.endContext = context;
      row.read += u.cache_read_input_tokens || 0;
      row.write += u.cache_creation_input_tokens || 0;
      row.input += u.input_tokens || 0;
      row.output += u.output_tokens || 0;
      row.start ||= at;
    }
    if (!row.turns || row.start < from) continue;
    rows.push(row);
  }
  return rows.sort((a, b) => a.start - b.start);
}

/** The price entry for a model id, and whether it was the fallback's. */
function priceOf(model) {
  const key = Object.keys(PRICES.models).find((id) => (model || "").startsWith(id));
  return { price: PRICES.models[key || FALLBACK], assumed: !key };
}

/** A row's cost in dollars, by part, each turn at its own model's prices. */
export function costOf(row) {
  return row.cost;
}

/** The middle value; the mean of the two middle ones for an even count. */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const k = (n) => `${Math.round(n / 1000)}k`;
const dollars = (n) => `$${n >= 10 ? Math.round(n) : n.toFixed(2)}`;
const SHARE_WORDS = {
  write: "cache writes",
  output: "output",
  read: "cache reads",
  input: "input",
};

/** The agents a line is given, by the agent setting's last word, and their headings. */
const KINDS = [
  ["planner", "Planners"],
  ["executor", "Executors"],
  ["assistant", "Assistants"],
];

const kindOf = (agent) => KINDS.find(([kind]) => agent.split(":").at(-1) === kind)?.[0] || "";

/**
 * The report's lines: the first says the machine, the span, the folder and
 * the prices with the day they were read; then one line per agent with
 * sessions (`ceilings`, the project's `{ executor, planner }` pairs, gives
 * the counts over them), and one for the sessions of no agent the queue
 * starts.
 */
export function costWords(rows, { ceilings = null, machine = "", since = "", dir = "" } = {}) {
  const first = since || (rows.length ? rows[0].start : 0);
  const prices = Object.values(PRICES.models);
  const head = `Cost of this queue's sessions${machine ? ` on ${machine}` : ""}${first ? ` since ${day(first)}` : ""} (${rows.length} transcript${rows.length === 1 ? "" : "s"}${dir ? ` in ${dir}` : ""}), at the prices read on ${day(PRICES.read)} from ${PRICES.page}: ${prices
    .map((p, i) =>
      i === 0
        ? `${p.name} $${p.input} input, $${p.write} one-hour cache write, $${p.read.toFixed(2)} cache read, $${p.output} output a million tokens`
        : `${p.name} $${p.input}, $${p.write}, $${p.read.toFixed(2)}, $${p.output}`,
    )
    .join("; ")}.`;
  const lines = [head];
  const total = (group) => {
    const parts = { write: 0, output: 0, read: 0, input: 0 };
    for (const row of group) {
      const cost = costOf(row);
      for (const part of Object.keys(parts)) parts[part] += cost[part];
    }
    const sum = Object.values(parts).reduce((a, b) => a + b, 0);
    return { parts, sum };
  };
  const assumedWords = (group) => {
    const models = [
      ...new Set(group.flatMap((row) => row.models).filter((model) => priceOf(model).assumed)),
    ];
    return models.length
      ? ` (${models.map((m) => m || "no model").join(", ")} priced as ${PRICES.models[FALLBACK].name})`
      : "";
  };
  for (const [kind, heading] of KINDS) {
    const group = rows.filter((row) => kindOf(row.agent) === kind);
    if (!group.length) continue;
    const { parts, sum } = total(group);
    const shares = Object.entries(parts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([part, value]) => `${SHARE_WORDS[part]} ${sum ? Math.round((value / sum) * 100) : 0}%`)
      .join(", ");
    const pair = ceilings?.[kind];
    const over = (n) => group.filter((row) => row.endContext > n).length;
    const overWords = pair
      ? pair.any === pair.related
        ? `, ${over(pair.any)} ended over ${k(pair.any)}`
        : `, ${over(pair.any)} ended over ${k(pair.any)} and ${over(pair.related)} over ${k(pair.related)}`
      : "";
    const compacted = group.filter((row) => row.compactions).length;
    lines.push(
      `${heading}: ${group.length} session${group.length === 1 ? "" : "s"}, median ${Math.round(median(group.map((row) => row.turns)))} turns, median context at the end ${k(median(group.map((row) => row.endContext)))}${overWords}, ${compacted ? `${compacted} compacted` : "none compacted"}; ${dollars(sum)}${assumedWords(group)}, ${shares}.`,
    );
  }
  const other = rows.filter((row) => !kindOf(row.agent));
  if (other.length) {
    const agents = [...new Set(other.map((row) => row.agent).filter(Boolean))];
    lines.push(
      `Other: ${other.length} session${other.length === 1 ? "" : "s"} (${agents.length ? `no agent setting, or ${agents.join(", ")}` : "no agent setting"}); ${dollars(total(other).sum)}${assumedWords(other)}.`,
    );
  }
  return lines;
}
