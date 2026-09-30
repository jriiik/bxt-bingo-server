// Makes and runs games on the local server (`npm run dev`), standing in for the web pages
//
// npm run dev-game -- create <board.json> [options]
//   board.json: a manifest like BXT's offline test boards (boards/scriptless.json),
//   or { "tiles": [{ "id": "A1", "segment": { ...Segment } }, ...] },
//   or `catalog` for 25 segments from the catalog (catalog/*.json), or one catalog file
//   --pools hl1,hazard-course      only from these pools (catalog only)
//   --segments oar-2-0,uc-5-1      these first, in board order, and the rest at random (catalog only)
//   --players red:ninya,blue:edd   players to add, each gets a join code
//   --ruleset scriptless|scripted  default scriptless
//   --settings timeLimitMs=900000,suddenDeathMs=600000   see RoomSettings in src/room/room.js
//     e.g. redoOwnTile=false, lockout=true, hideLabels=true, showContesting=false, singleSegment=true
//   --saves <folder>               upload the board's saves from here (e.g. valve_WON/SAVE)
//   The extra files (rules/extra-files.json, e.g. the win sound) are uploaded from files/ every time
// npm run dev-game -- player <game> <team> <name> [steamid64]   add a player, prints their join code
//   (give the steamid64 to add someone again, e.g. after unban)
// npm run dev-game -- code <game> <steamid64>            a new join code for a player
// npm run dev-game -- <action> <game> [name=value ...]
//   start force=true, end, lock locked=true, move steamid64=... team=blue, kick steamid64=... ban=false,
//   unban steamid64=... (then add them again with `player`),
//   handicaps steamid64=... handicaps=no_damage,jupiter (ids in rules/handicaps.json), void attempt_id=..., accept attempt_id=...
// Values: true, false, null and numbers are read as such, and lists are comma-separated
// (a JSON object works too, where the shell allows the quotes)
// npm run dev-game -- show <game>                        the game's snapshot
// --server http://localhost:8787 picks another server

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ALL_TILES } from "../src/protocol/index.js";

const args = process.argv.slice(2);

/** @param {string} name */
function option(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    return undefined;
  }
  const [, value] = args.splice(i, 2);
  return value;
}

const server = (option("server") ?? "http://localhost:8787").replace(/\/$/, "");

// Always lists, even with one value
const LISTS = ["handicaps", "tiebreakers"];

/**
 * `name=value` words (or one comma-separated word) as an object, e.g. for Windows shells that
 * mangle JSON quotes
 * @param {string[]} words
 */
function readArgs(words) {
  if (words.length === 1 && words[0].trim().startsWith("{")) {
    return JSON.parse(words[0]);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const word of words) {
    const eq = word.indexOf("=");
    if (eq < 0) {
      throw new Error(`expected name=value, got ${word}`);
    }
    const name = word.slice(0, eq);
    const text = word.slice(eq + 1);
    /** @param {string} v */
    const value = (v) => (v === "true" ? true : v === "false" ? false : v === "null" ? null : /^-?\d+$/.test(v) && name !== "steamid64" ? Number(v) : v);
    out[name] = LISTS.includes(name) || text.includes(",") ? text.split(",").filter(Boolean).map(value) : value(text);
  }
  return out;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function call(method, path, body) {
  const response = await fetch(server + path, {
    method,
    headers: body instanceof Uint8Array ? {} : { "Content-Type": "application/json" },
    body: /** @type {any} */ (body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

/**
 * 25 segments from a catalog: the listed ones first, then random ones from the pools
 * @param {any[]} catalog
 * @param {string | undefined} pools
 * @param {string | undefined} listed
 */
function pickSegments(catalog, pools, listed) {
  const pool = pools ? catalog.filter((s) => pools.split(",").includes(s.pool ?? "hl1")) : catalog;
  const chosen = (listed ? listed.split(",") : []).map((id) => {
    const segment = catalog.find((s) => s.id === id);
    if (!segment) {
      throw new Error(`no segment ${id} in the catalog`);
    }
    return segment;
  });
  const rest = pool.filter((s) => !chosen.includes(s));
  // Shuffled, then as many as the board still needs
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const segments = [...chosen, ...rest].slice(0, ALL_TILES.length);
  if (segments.length < ALL_TILES.length) {
    throw new Error(`only ${segments.length} segments to pick from, a board needs ${ALL_TILES.length}`);
  }
  return ALL_TILES.map((id, i) => ({ id, segment: segments[i] }));
}

/** Every segment in catalog/*.json */
function readCatalog() {
  const dir = new URL("../catalog/", import.meta.url);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")));
}

/**
 * The board file as the server wants it
 * @param {string} file
 * @param {string | undefined} pools
 * @param {string | undefined} listed
 */
function readBoard(file, pools, listed) {
  if (file === "catalog") {
    return pickSegments(readCatalog(), pools, listed);
  }
  const board = JSON.parse(readFileSync(file, "utf8"));
  if (Array.isArray(board)) {
    return pickSegments(board, pools, listed);
  }
  if (board.type === "manifest") {
    // BXT's offline boards are manifests: one save per tile, for the WON build
    return board.tiles.map((/** @type {any} */ t) => ({
      id: t.id,
      segment: {
        id: String(t.label ?? t.id).toLowerCase(),
        label: t.label ?? t.id,
        chapter: "",
        saves: { won: t.save },
        start: t.start,
        end: t.end,
        reference_time_ms: null,
      },
    }));
  }
  return board.tiles;
}

/**
 * Uploads the saves whose hash is on the board, from a folder of .sav files
 * @param {any[]} tiles
 * @param {string} folder
 */
async function uploadSaves(tiles, folder) {
  const wanted = new Set(tiles.flatMap((t) => Object.values(t.segment.saves).map((/** @type {any} */ s) => s.sha256)));
  let uploaded = 0;
  for (const name of readdirSync(folder)) {
    if (!name.toLowerCase().endsWith(".sav")) {
      continue;
    }
    const bytes = readFileSync(join(folder, name));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (wanted.delete(hash)) {
      await call("PUT", `/dev/files/${hash}`, new Uint8Array(bytes));
      uploaded++;
    }
  }
  console.log(`uploaded ${uploaded} saves${wanted.size ? `, ${wanted.size} not found in ${folder}` : ""}`);
}

/** Uploads the files in rules/extra-files.json from files/ */
async function uploadExtraFiles() {
  const root = new URL("..", import.meta.url);
  const list = JSON.parse(readFileSync(new URL("rules/extra-files.json", root), "utf8"));
  for (const file of list) {
    await call("PUT", `/dev/files/${file.sha256}`, new Uint8Array(readFileSync(new URL(`files/${file.path}`, root))));
  }
}

/**
 * @param {string} gameId
 * @param {string} team
 * @param {string} name
 * @param {string} [id] A steamid64, or a made-up one
 */
async function addPlayer(gameId, team, name, id) {
  const { steamid64, code } = await call("POST", `/dev/games/${gameId}/players`, { name, team: team === "none" ? null : team, steamid64: id });
  console.log(`${team.padEnd(5)} ${name.padEnd(16)} ${steamid64}  bxt_bingo_join ${code}`);
}

const [command, ...rest] = args;
try {
  if (command === "create") {
    const [file] = rest;
    const tiles = readBoard(file, option("pools"), option("segments"));
    const settingsText = option("settings");
    const settings = settingsText ? readArgs(settingsText.trim().startsWith("{") ? [settingsText] : settingsText.split(/,(?=[A-Za-z]+=)/)) : {};
    const ruleset = option("ruleset") ?? "scriptless";
    const players = option("players");
    const saves = option("saves");
    if (saves) {
      await uploadSaves(tiles, saves);
    }
    await uploadExtraFiles();
    const { id } = await call("POST", "/dev/games", { tiles, settings, ruleset });
    console.log(`game ${id}`);
    // The board, a row per line
    for (let row = 0; row < 5; row++) {
      console.log("  " + tiles.slice(row * 5, row * 5 + 5).map((/** @type {any} */ t) => `${t.id} ${t.segment.label}`.padEnd(12)).join(""));
    }
    for (const entry of players ? players.split(",") : []) {
      const [team, name] = entry.split(":");
      await addPlayer(id, team, name ?? team);
    }
  } else if (command === "player") {
    const [gameId, team, name, id] = rest;
    await addPlayer(gameId, team, name ?? team, id);
  } else if (command === "code") {
    const [gameId, steamid64] = rest;
    const { code } = await call("POST", `/dev/games/${gameId}/code`, { steamid64 });
    console.log(`bxt_bingo_join ${code}`);
  } else if (command === "show") {
    console.log(JSON.stringify(await call("GET", `/api/games/${rest[0]}`), null, 2));
  } else if (command && rest[0]) {
    const [gameId, ...words] = rest;
    console.log(JSON.stringify(await call("POST", `/dev/games/${gameId}/${command}`, readArgs(words))));
  } else {
    console.error("usage: npm run dev-game -- create <board.json> [--players red:a,blue:b] | player | code | show | <action> <game>");
    process.exit(1);
  }
} catch (e) {
  console.error(`error: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}
