// The boards a game can be made with (BINGO.md §3.3): 25 segments drawn at random from the
// catalog pools the host ticks, or a test board (BXT's offline manifests). No imports of the
// catalog here, so the tests can pass their own

import { ALL_TILES } from "../src/protocol/index.js";
import { DEFAULT_GAME, DEFAULT_POOL } from "../src/protocol/segment.js";

/** @typedef {import("../src/protocol/segment.js").Segment} Segment */

/** What the create form calls each pool; others go by their id */
export const POOL_NAMES = Object.freeze({ hl1: "Half-Life campaign" });

// Most pools one board may be drawn from
const MAX_POOLS = 20;

/**
 * The pools of a catalog, for the create form
 * @param {Segment[]} catalog
 * @returns {{ id: string, name: string, game: string, segments: number }[]}
 */
export function catalogPools(catalog) {
  /** @type {Map<string, { id: string, name: string, game: string, segments: number }>} */
  const pools = new Map();
  for (const s of catalog) {
    const id = s.pool ?? DEFAULT_POOL;
    const pool = pools.get(id) ?? { id, name: Object.hasOwn(POOL_NAMES, id) ? POOL_NAMES[/** @type {"hl1"} */ (id)] : id, game: s.game ?? DEFAULT_GAME, segments: 0 };
    pool.segments++;
    pools.set(id, pool);
  }
  return [...pools.values()];
}

/**
 * 25 segments from these pools, in random order, as the game wants its tiles
 * @param {Segment[]} catalog
 * @param {unknown} pools The pool ids the host ticked
 * @param {(n: number) => number} [random] An integer from 0 to n - 1
 * @returns {{ tiles: { id: string, segment: Segment }[] } | { error: string }}
 */
export function drawBoard(catalog, pools, random = randomIndex) {
  if (!Array.isArray(pools) || pools.length === 0 || pools.length > MAX_POOLS || !pools.every((p) => typeof p === "string")) {
    return { error: "pools must be a list of pool ids" };
  }
  const known = new Set(catalog.map((s) => s.pool ?? DEFAULT_POOL));
  if (!pools.every((p) => known.has(p))) {
    return { error: `pools must be some of ${[...known].join(", ")}` };
  }
  const chosen = new Set(pools);
  const segments = catalog.filter((s) => chosen.has(s.pool ?? DEFAULT_POOL));
  // A board is one game (the game refuses others too, but this says why)
  if (new Set(segments.map((s) => s.game ?? DEFAULT_GAME)).size > 1) {
    return { error: "pools of different games can't be on one board" };
  }
  if (segments.length < ALL_TILES.length) {
    return { error: `these pools have ${segments.length} segments, a board needs ${ALL_TILES.length}` };
  }
  // Shuffled, then the first 25
  for (let i = segments.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [segments[i], segments[j]] = [segments[j], segments[i]];
  }
  return { tiles: ALL_TILES.map((id, i) => ({ id, segment: segments[i] })) };
}

/**
 * A test board's tiles as the game wants them. A tile the catalog has (same label, save and
 * triggers) is that segment, with its id and chapter; others are made up as `dev-game` does
 * @param {any} manifest
 * @param {Segment[]} catalog
 */
export function boardTiles(manifest, catalog) {
  return manifest.tiles.map((/** @type {any} */ t) => {
    const known = catalog.find(
      (s) =>
        s.label === t.label &&
        s.saves.won?.sha256 === t.save?.sha256 &&
        JSON.stringify(s.start) === JSON.stringify(t.start) &&
        JSON.stringify(s.end) === JSON.stringify(t.end),
    );
    return {
      id: t.id,
      segment: known ?? {
        id: String(t.label ?? t.id).toLowerCase(),
        label: t.label ?? t.id,
        chapter: "",
        game: manifest.game ?? DEFAULT_GAME,
        saves: { won: t.save },
        start: t.start,
        end: t.end,
        reference_time_ms: null,
      },
    };
  });
}

/**
 * An unbiased random integer from 0 to n - 1
 * @param {number} n
 */
function randomIndex(n) {
  const value = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= limit);
  return value[0] % n;
}
