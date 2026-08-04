import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const markdownFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((relative) => existsSync(resolve(root, relative)))
  .sort();

const errors = [];
let checkedLinks = 0;

function githubSlug(value) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function anchorsFor(file) {
  const content = readFileSync(file, "utf8");
  const anchors = new Set();
  const occurrences = new Map();
  for (const line of content.split("\n")) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const base = githubSlug(match[2]);
    if (!base) continue;
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const anchorCache = new Map();

function validateTarget(sourceRelative, rawTarget, lineNumber) {
  let target = rawTarget.trim().replace(/^<|>$/g, "");
  if (!target || /^(?:https?:|mailto:|data:|app:)/i.test(target)) return;

  target = target.replace(/\\([() ])/g, "$1");
  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const anchorPart = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
  const sourcePath = resolve(root, sourceRelative);
  let destination;

  try {
    destination = pathPart
      ? resolve(dirname(sourcePath), decodeURIComponent(pathPart))
      : sourcePath;
  } catch {
    errors.push(`${sourceRelative}:${lineNumber}: invalid encoded link: ${rawTarget}`);
    return;
  }

  checkedLinks += 1;
  if (!existsSync(destination)) {
    errors.push(`${sourceRelative}:${lineNumber}: missing link target: ${rawTarget}`);
    return;
  }

  if (!anchorPart || statSync(destination).isDirectory()) return;
  const normalizedAnchor = decodeURIComponent(anchorPart).toLowerCase();
  let anchors = anchorCache.get(destination);
  if (!anchors) {
    anchors = anchorsFor(destination);
    anchorCache.set(destination, anchors);
  }
  if (!anchors.has(normalizedAnchor)) {
    errors.push(`${sourceRelative}:${lineNumber}: missing heading anchor: ${rawTarget}`);
  }
}

for (const relative of markdownFiles) {
  const content = readFileSync(resolve(root, relative), "utf8");
  const patterns = [
    /!?\[[^\]]*\]\(([^)]+)\)/g,
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const lineNumber = content.slice(0, match.index).split("\n").length;
      validateTarget(relative, match[1], lineNumber);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`docs: ${markdownFiles.length} Markdown files, ${checkedLinks} local links OK`);
}
