// **The project's Claude on GitHub** (plans/plans-as-github-issues.md, part 1):
// the queue writes issues, comments, labels and pull requests as the
// project's own GitHub App, never under a person's name. Its id and private
// key reach the container as `GH_TOKEN` does, `WORKFLOW_APP_ID` and
// `WORKFLOW_APP_KEY`, or in the file `WORKFLOW_SECRETS_FILE` names, which the
// queue's `secret()` reads; an installation token is minted from them here, for an
// hour, and kept in `.claude/app-token.json` until five minutes before it
// ends. `node:` modules only; `fetch` is Node's own.
import { createSign } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://api.github.com";
/** The REST API's version every call names (GitHub's "API versions"). */
const API_VERSION = "2022-11-28";
/** A cached token is minted again this long before it ends. */
export const TOKEN_MARGIN = 5 * 60_000;

const base64url = (value) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

/**
 * The key as the variable holds it: a PEM's text, its line ends as written or
 * as `\n` escapes, which a one-line environment value often carries.
 */
export function keyOf(text = "") {
  return /\n/.test(text) ? text : text.replace(/\\n/g, "\n");
}

/**
 * **The app's JSON Web Token** (GitHub's "Generating a JSON Web Token"):
 * RS256, issued a minute back for the clock's drift, ending ten minutes on,
 * GitHub's longest, its issuer the app's id.
 */
export function appJwt(id, pem, now = Date.now()) {
  const at = Math.floor(now / 1000);
  const head = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat: at - 60, exp: at + 600, iss: String(id) })}`;
  const signature = createSign("RSA-SHA256").update(head).end().sign(keyOf(pem), "base64url");
  return `${head}.${signature}`;
}

function readCache(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, file);
}

async function call(fetch, method, path, jwt) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${jwt}`,
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "workflow-plugin",
    },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // No JSON: the status says it.
  }
  if (!response.ok)
    throw new Error(
      `${method} ${path} answered ${response.status}${body?.message ? `: ${body.message}` : ""}`,
    );
  return body;
}

/**
 * **An installation token for the repository** (GitHub's "Generating an
 * installation access token"): the cached one while more than five minutes
 * of it are left and it is this repository's, else the installation read from
 * `GET /repos/{owner}/{repo}/installation` and a token minted for it, an hour
 * long, cached with its end. Throws with GitHub's answer when either call fails.
 */
export async function installationToken({
  owner,
  repo,
  id,
  key,
  cacheFile,
  fetch = globalThis.fetch,
  now = Date.now(),
}) {
  const name = `${owner}/${repo}`;
  const cached = cacheFile ? readCache(cacheFile) : null;
  if (
    cached?.token &&
    cached.repo === name &&
    String(cached.app) === String(id) &&
    Date.parse(cached.expiresAt) - now > TOKEN_MARGIN
  )
    return cached.token;
  const jwt = appJwt(id, key, now);
  const installation = await call(fetch, "GET", `/repos/${name}/installation`, jwt);
  const minted = await call(
    fetch,
    "POST",
    `/app/installations/${installation.id}/access_tokens`,
    jwt,
  );
  if (cacheFile)
    writeCache(cacheFile, {
      token: minted.token,
      expiresAt: minted.expires_at,
      repo: name,
      app: String(id),
    });
  return minted.token;
}

/** **The app's slug** (`GET /app`, with the app's JWT), which a mention of it names: `@<slug>`. */
export async function appSlug({ id, key, fetch = globalThis.fetch, now = Date.now() }) {
  const app = await call(fetch, "GET", "/app", appJwt(id, key, now));
  return app?.slug || "";
}

/** `owner/repo` from a GitHub remote's address, https or ssh; null for another host. */
export function repoOfRemote(url = "") {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
