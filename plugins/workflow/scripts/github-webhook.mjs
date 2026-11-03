// **What people write on GitHub reaches the queue on its own**
// (plans/github-watched.md): the app's webhook posts each event to `plans
// webhook` on the container, which checks its signature, keeps it in
// `.claude/github-inbox/`, and turns it into the queue's events; `plans
// github` reads what a container that was down missed, into the same
// events. This file is the pure part and the listener; what is done with
// an event is `plan-queue.mjs`'s. `node:` modules only.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/**
 * **A delivery is GitHub's when its signature says so** (GitHub's
 * "Validating webhook deliveries"): `X-Hub-Signature-256` is `sha256=` and
 * the HMAC SHA-256 of the raw body under the secret, in hex, compared in
 * constant time. A missing header, a legacy `sha1=` one or no secret is no.
 */
export function verifyDelivery(secret, rawBody, signatureHeader) {
  if (!secret || typeof signatureHeader !== "string" || !signatureHeader.startsWith("sha256="))
    return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
  );
  const given = Buffer.from(signatureHeader);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The labels of an issue or a pull request, by name. */
export const labelsOf = (thing) =>
  (thing?.labels || []).map((label) => label?.name || label).filter(Boolean);

/**
 * **A delivery as the queue's items**, one shape for a delivery and for
 * `plans github`'s read: `{ deliveryId, kind, number, title, labels,
 * author, at, text, url, merged, pull, label, head }`, `kind` one of `opened`
 * (an issue), `labeled`, `comment`, `review` and `closed` (a pull request),
 * `pull` true on a pull request. An event the queue takes nothing from is
 * no item.
 */
export function itemsOfDelivery(event, payload = {}, deliveryId = "") {
  const issue = payload.issue;
  const pr = payload.pull_request;
  const base = (thing, pull) => ({
    deliveryId,
    number: thing?.number || 0,
    title: thing?.title || "",
    labels: labelsOf(thing),
    url: thing?.html_url || "",
    pull,
  });
  if (event === "issues" && issue && !issue.pull_request) {
    if (payload.action === "opened")
      return [
        {
          ...base(issue, false),
          kind: "opened",
          author: issue.user?.login || "",
          at: issue.created_at || "",
          text: issue.body || "",
        },
      ];
    if (payload.action === "labeled")
      return [
        {
          ...base(issue, false),
          kind: "labeled",
          label: payload.label?.name || "",
          author: payload.sender?.login || "",
          at: issue.updated_at || "",
          text: "",
        },
      ];
    return [];
  }
  if (event === "issue_comment" && payload.action === "created" && issue)
    return [
      {
        ...base(issue, Boolean(issue.pull_request)),
        kind: "comment",
        author: payload.comment?.user?.login || "",
        at: payload.comment?.created_at || "",
        text: payload.comment?.body || "",
        url: payload.comment?.html_url || issue.html_url || "",
      },
    ];
  if (
    (event === "pull_request_review" && payload.action === "submitted") ||
    (event === "pull_request_review_comment" && payload.action === "created")
  ) {
    const said = payload.review || payload.comment || {};
    return [
      {
        ...base(pr, true),
        head: pr?.head?.ref || "",
        kind: "review",
        author: said.user?.login || "",
        at: said.submitted_at || said.created_at || "",
        text: said.body || "",
        url: said.html_url || pr?.html_url || "",
      },
    ];
  }
  if (event === "pull_request" && payload.action === "closed" && pr)
    return [
      {
        ...base(pr, true),
        head: pr.head?.ref || "",
        kind: "closed",
        merged: Boolean(pr.merged),
        author: payload.sender?.login || "",
        at: pr.merged_at || pr.closed_at || "",
        text: pr.body || "",
      },
    ];
  return [];
}

/** The issue a pull request is for, from its `For #<n>.` line; 0 with none. */
export function forOf(text = "") {
  return Number(/^For #(\d+)\.?[ \t]*$/m.exec(text)?.[1] || 0);
}

/** An empty seen file. */
export const NOTHING_SEEN = Object.freeze({
  deliveries: [],
  issues: {},
  pulls: {},
  permissions: {},
  labeled: [],
  readAt: "",
});

/** Deliveries kept to tell a redelivery, newest last. */
const DELIVERIES_KEPT = 500;

/**
 * **The queue's events from GitHub's items** (plans/github-watched.md, part
 * 2), pure: `{ events, seen }`, each event `{ kind, number, by, at, text,
 * url, title, permission, pull }`, in the items' order. `context` says
 * what the checkout's plans hold: `carried` (the issues a plan or a brief
 * carries), `planned` (a planned plan's issues), `own` (the queue's own
 * pull requests) and `slug` (the app's). Kinds: `issue` (an issue opened,
 * unlabelled), `plan` (`status: planning` set on an issue nothing carries),
 * `mention` (`@<slug>` in a comment), `comment` (on an issue a plan
 * carries), `review` (a review, a review comment or a comment on the
 * queue's own pull request), `ready` (`status: ready` on a planned plan's
 * issue), `merged` (a pull request with a `For #<n>` line merged; its
 * number the issue's, `pull` the pull request's). A reader's item, one
 * whose author's permission is not write or admin in `seen.permissions`,
 * and the app's own are never events; a delivery seen is skipped, and so
 * is an item from a read no newer than what was seen of its issue.
 */
export function githubEvents(seen = NOTHING_SEEN, items = [], context = {}) {
  const carried = new Set(context.carried || []);
  const planned = new Set(context.planned || []);
  const own = new Set(context.own || []);
  const slug = context.slug || "";
  const next = {
    ...NOTHING_SEEN,
    ...seen,
    deliveries: [...(seen.deliveries || [])],
    issues: { ...(seen.issues || {}) },
    pulls: { ...(seen.pulls || {}) },
    permissions: { ...(seen.permissions || {}) },
    labeled: [...(seen.labeled || [])],
  };
  const events = [];
  for (const item of items) {
    if (item.deliveryId) {
      if (next.deliveries.includes(item.deliveryId)) continue;
      next.deliveries.push(item.deliveryId);
    } else {
      // A read's item: only what is newer than this issue's last item seen.
      const map = item.pull ? next.pulls : next.issues;
      const last = map[item.number];
      if (last && item.at && item.at <= last) continue;
    }
    const map = item.pull ? next.pulls : next.issues;
    if (item.at && (!map[item.number] || item.at > map[item.number])) map[item.number] = item.at;
    const author = item.author || "";
    if (!author || (slug && author === `${slug}[bot]`)) continue;
    const permission = next.permissions[author];
    if (permission !== "write" && permission !== "admin") continue;
    const event = (kind, extra = {}) =>
      events.push({
        kind,
        number: item.number,
        by: author,
        at: item.at || "",
        text: item.text || "",
        url: item.url || "",
        title: item.title || "",
        permission,
        ...extra,
      });
    const mentions = slug && new RegExp(`(^|[^\\w-])@${slug}\\b`, "i").test(item.text || "");
    const ours = own.has(item.number) || Boolean(item.head && own.has(item.head));
    if (item.kind === "opened") {
      // An issue opened with a label is labelled too, and that item is the one that counts.
      if (!item.labels?.length) event("issue");
    } else if (item.kind === "labeled") {
      const key = `${item.number}:${item.label}`;
      const once = () => {
        if (!next.labeled.includes(key)) next.labeled.push(key);
      };
      if (item.label === "status: planning" && !carried.has(item.number)) {
        once();
        event("plan");
      } else if (item.label === "status: ready" && planned.has(item.number)) {
        once();
        event("ready");
      }
    } else if (item.kind === "comment") {
      if (mentions) event("mention");
      else if (item.pull ? ours : carried.has(item.number)) event(item.pull ? "review" : "comment");
    } else if (item.kind === "review") {
      if (ours) event(mentions ? "mention" : "review");
    } else if (item.kind === "closed" && item.merged) {
      const issue = forOf(item.text);
      if (issue) event("merged", { number: issue, pull: item.number });
    }
  }
  next.deliveries = next.deliveries.slice(-DELIVERIES_KEPT);
  return { events, seen: next };
}

const MONTHS =
  "January February March April May June July August September October November December".split(
    " ",
  );

/** "3 November 2026 21:58", as the note writes a time. */
export function noteTime(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${hh}:${mm}`;
}

/**
 * **An event as its note** (plans/github-watched.md, part 3): the heading
 * when the note is new (`first`), then a line of the event and its text
 * as written, indented four spaces.
 */
export function noteFor(event, { first = false } = {}) {
  const head = first ? `# GitHub #${event.number}: ${event.title}\n\n` : "";
  const text = (event.text || "")
    .split("\n")
    .map((line) => (line.trim() ? `    ${line}` : ""))
    .join("\n")
    .replace(/\n+$/, "");
  return `${head}${event.kind}, ${noteTime(event.at)}, by ${event.by} (${event.permission}): ${event.url}\n${text ? `${text}\n` : ""}\n`;
}

/**
 * **The listener** (plans/github-watched.md, part 1): every verified POST
 * is kept by `keep(id, event, rawBody)` and answered 202 before `after()`
 * runs the work, GitHub wanting an answer within ten seconds; an
 * unverified one is answered 401 with nothing kept, anything but a POST
 * 405. The server, listening on `port`.
 */
export function listen({ port, secret, keep, after = () => {} }) {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      // GitHub caps a payload at 25 MB.
      if (size > 26_000_000) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (!verifyDelivery(secret, raw, request.headers["x-hub-signature-256"])) {
        response.writeHead(401).end();
        return;
      }
      const id = String(request.headers["x-github-delivery"] || "").replace(/[^\w-]/g, "");
      const event = String(request.headers["x-github-event"] || "");
      try {
        keep(id || `local-${Date.now()}`, event, raw.toString("utf8"));
      } catch {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(202).end();
      setImmediate(after);
    });
  });
  server.listen(port);
  return server;
}
