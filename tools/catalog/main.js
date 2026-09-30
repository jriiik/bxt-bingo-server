// Makes the segment catalog from the Half-Life Practice Kit (BINGO.md §3.1)
//
// Usage: npm run catalog -- "<Half-Life Practice Kit folder>" [catalog/hl1.json]
// Reads PracticeCfgs/*.cfg and hashes the saves they load from SAVE/
// Every segment gets pool `hl1` and game `valve`, and its save for the WON build
// Cfgs it can't use are listed at the end, with why

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { compareIds, parseCfg } from "./kit.js";

/**
 * Finds a file case-insensitively, as the kit's names don't always match their case
 * @param {string} dir
 * @param {string} name
 */
function findFile(dir, name) {
  const found = readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
  return found ? join(dir, found) : null;
}

/**
 * @param {string} kit
 * @param {string} out
 */
function run(kit, out) {
  const cfgDir = join(kit, "PracticeCfgs");
  const saveDir = join(kit, "SAVE");
  /** @type {import("../../src/protocol/segment.js").Segment[]} */
  const segments = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const notes = [];

  const names = readdirSync(cfgDir)
    .filter((f) => f.toLowerCase().endsWith(".cfg"))
    .map((f) => f.slice(0, -4));
  for (const name of names) {
    const result = parseCfg(name, readFileSync(join(cfgDir, `${name}.cfg`), "latin1"));
    if ("skip" in result) {
      if (result.skip !== "not a segment") {
        skipped.push(`${name}: ${result.skip}`);
      }
      continue;
    }
    const { segment, notes: cfgNotes } = result;
    notes.push(...cfgNotes.map((n) => `${name}: ${n}`));

    const path = findFile(saveDir, `${segment.save}.sav`);
    if (!path) {
      skipped.push(`${name}: its save ${segment.save}.sav isn't in SAVE`);
      continue;
    }
    const bytes = readFileSync(path);
    segments.push({
      id: segment.id,
      label: segment.label,
      chapter: segment.chapter,
      pool: "hl1",
      game: "valve",
      saves: { won: { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } },
      start: segment.start,
      end: segment.end,
      reference_time_ms: null,
    });
  }

  segments.sort((a, b) => compareIds(a.id, b.id));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(segments, null, 2) + "\n");
  const saves = new Set(segments.map((s) => s.saves.won.sha256)).size;
  console.log(`${out}: ${segments.length} segments, ${saves} different saves`);

  for (const [title, lines] of /** @type {const} */ ([
    ["Left out", skipped],
    ["Notes", notes],
  ])) {
    if (lines.length > 0) {
      console.log(`\n${title}:`);
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    }
  }
}

const [kit, out = "catalog/hl1.json"] = process.argv.slice(2);
if (!kit) {
  console.error('usage: npm run catalog -- "<Half-Life Practice Kit folder>" [catalog/hl1.json]');
  process.exit(1);
}
run(kit, out);
