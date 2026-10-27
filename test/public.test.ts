import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");

/**
 * **The repository is public**: no tracked file names a host's address, a
 * personal email, the home lab's own domain, or the projects the workflow
 * runs in; the README says "the author's projects", never which. This test
 * is the one tracked file that spells those names, as patterns.
 */

/** Files a person does not read as prose, or that hold addresses on purpose. */
const SKIPPED = [
  // Binaries and fonts: no text to read.
  /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|pdf|mp4|webm|zip|gz)$/i,
  // Resolved package URLs and integrity hashes, never written by hand.
  /(^|\/)package-lock\.json$/,
];

const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.]*\d)(\/\d{1,2})?/g;

/** Addresses that name no machine of ours. */
function allowedAddress(match: RegExpExecArray): boolean {
  const [whole, a, b, c, d, bits] = match;
  const octets = [a, b, c, d].map(Number);
  // Four numbers above 255 are not an address (an SVG path, a version).
  if (octets.some((n) => n > 255)) return true;
  // A range, which names no one machine.
  if (bits) return true;
  // Loopback and "every interface", which every compose file and doc names.
  if (whole.startsWith("127.") || whole === "0.0.0.0") return true;
  // RFC 5737's documentation ranges, for examples.
  return ["192.0.2.", "198.51.100.", "203.0.113."].some((p) => whole.startsWith(p));
}

/** Personal mail providers; a founder's address is the company's or GitHub's noreply. */
const PERSONAL_EMAIL = /[A-Za-z0-9._%+-]+@(gmail\.com|yandex\.ru|[a-z0-9.-]*ethz\.ch)\b/i;
/** The home lab's own domain, written here as a name and nowhere else. */
const HOME_LAB = /javinieto/i;
/** The project the workflow was first written in, which this repository does not name. */
const FIRST_PROJECT = /wordplay/i;

function trackedFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
  return out
    .split("\0")
    .filter(Boolean)
    .filter((path) => !SKIPPED.some((rule) => rule.test(path)))
    .filter((path) => path !== "test/public.test.ts");
}

describe("a tracked file", () => {
  it("names no host address, personal email, home lab or first project in a tracked file", () => {
    const found: string[] = [];
    for (const path of trackedFiles()) {
      let text: string;
      try {
        text = readFileSync(join(root, path), "utf8");
      } catch {
        continue; // deleted in the working tree, or a submodule
      }
      text.split("\n").forEach((line, i) => {
        const where = `${path}:${i + 1}`;
        for (const match of line.matchAll(IPV4)) {
          if (!allowedAddress(match as RegExpExecArray)) found.push(`${where}: ${match[0]}`);
        }
        if (PERSONAL_EMAIL.test(line)) found.push(`${where}: a personal email`);
        if (HOME_LAB.test(line)) found.push(`${where}: the home lab's domain`);
        if (FIRST_PROJECT.test(line)) found.push(`${where}: the first project's name`);
      });
    }
    expect(found).toEqual([]);
  });
});
