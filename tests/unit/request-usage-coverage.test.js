import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const API_ROOT = new URL("../../src/app/api/", import.meta.url).pathname;

function routeFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.js" ? [full] : [];
  });
}

const files = ["v1", "v1beta"].flatMap((d) => routeFiles(path.join(API_ROOT, d)));

describe("every public API route records usage", () => {
  it("found the route files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [path.relative(API_ROOT, f), f]))("%s", (_rel, file) => {
    const src = fs.readFileSync(file, "utf8");
    // Re-export-only files (v1/route.js) inherit the wrapper from their source.
    if (/^export \{[^}]*\} from /m.test(src) && !/export (async )?function/.test(src)) return;
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/);
    expect(src).not.toMatch(/export\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/);
    expect(src).toMatch(/withRequestUsage\(/);
  });
});
