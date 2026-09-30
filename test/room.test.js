import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createHash } from "node:crypto";

import { ALL_TILES, isSafeExtraPath } from "../src/protocol/index.js";
import { Room, RoomError } from "../src/room/index.js";
import { applyHandicaps, checkHandicapPresets } from "../src/rules/handicaps.js";

const scriptless = JSON.parse(readFileSync(new URL("../rules/won-scriptless.json", import.meta.url), "utf8"));
const presets = checkHandicapPresets(JSON.parse(readFileSync(new URL("../rules/handicaps.json", import.meta.url), "utf8")));

const RED = "76561190000000001";
const RED2 = "76561190000000002";
const BLUE = "76561190000000003";
const T0 = 1_800_000_000_000;
const MIN = 60_000;

/** @param {number} i */
const sha = (i) => i.toString(16).padStart(64, "0");
/** @param {number} i */
const uuid = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function makeTiles() {
  return ALL_TILES.map((id, i) => ({
    id,
    segment: {
      id: `seg-${i}`,
      label: `S${i}`,
      chapter: "Test",
      saves: { won: { sha256: sha(i + 1), size: 1000 } },
      start: { type: /** @type {const} */ ("trigger"), corners: /** @type {[[number, number, number], [number, number, number]]} */ ([[0, 0, 0], [1, 1, 1]]) },
      end: { corners: /** @type {[[number, number, number], [number, number, number]]} */ ([[2, 2, 2], [3, 3, 3]]) },
      reference_time_ms: 10_000,
    },
  }));
}

/** @param {import("../src/room/room.js").RoomSettings} [settings] */
function makeRoom(settings = {}) {
  return new Room({ id: "g1", settings, tiles: makeTiles(), ruleset: scriptless, handicapPresets: presets });
}

/**
 * @param {import("../src/room/room.js").Changes} changes
 * @param {string} steamid64
 * @param {string} type
 */
const sent = (changes, steamid64, type) =>
  changes.send.filter((s) => s.steamid64 === steamid64 && s.message.type === type).map((s) => /** @type {any} */ (s.message));

/** @param {string} tile */
const tileIndex = (tile) => ALL_TILES.indexOf(tile);

/**
 * A room with red and blue connected, ready and running at T0
 * @param {import("../src/room/room.js").RoomSettings} [settings]
 */
function runningRoom(settings) {
  const room = makeRoom(settings);
  for (const [id, team] of /** @type {const} */ ([[RED, "red"], [BLUE, "blue"]])) {
    room.addPlayer({ steamid64: id, name: team, team });
    room.setConnected(id, true);
    const hello = room.hello(id, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "tok", T0 - 10_000);
    assert.ok("changes" in hello);
    room.onMessage(id, { type: "ready", manifest_hash: room.manifestFor(id).manifest_hash }, T0 - 10_000);
  }
  room.start(T0 - 5000, false);
  room.tick(T0);
  assert.equal(room.state, "running");
  let next = 1;

  /**
   * Starts and finishes a run
   * @param {string} player
   * @param {string} tile
   * @param {number} timeMs
   * @param {number} at When it finishes, ms after T0
   */
  const run = (player, tile, timeMs, at, { started = true, save = sha(tileIndex(tile) + 1) } = {}) => {
    const attempt_id = uuid(next++);
    if (started) {
      room.onMessage(player, { type: "attempt_started", attempt_id, tile }, T0 + at - timeMs);
    }
    const changes = room.onMessage(
      player,
      {
        type: "attempt_result",
        attempt_id,
        tile,
        time_ms: timeMs,
        server_time_delta_ms: timeMs,
        frames: 100,
        real_ms: timeMs,
        load_ms: 0,
        save_sha256: save,
        ruleset_ok: true,
        demo: null,
      },
      T0 + at,
    );
    return { attempt_id, changes, ack: sent(changes, player, "result_ack")[0] };
  };
  return { room, run };
}

test("hello sends welcome, lobby, manifest and board", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: RED, name: "ninya\u0007", team: "red" });
  const result = room.hello(RED, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "tok", T0);
  assert.ok("changes" in result);
  const types = result.changes.send.map((s) => s.message.type);
  assert.deepEqual(types, ["welcome", "lobby", "manifest", "board"]);
  const welcome = sent(result.changes, RED, "welcome")[0];
  assert.deepEqual(welcome.player, { steamid64: RED, name: "ninya", team: "red" });
  assert.equal(welcome.session_token, "tok");
  const manifest = sent(result.changes, RED, "manifest")[0];
  assert.equal(manifest.tiles.length, 25);
  assert.equal(manifest.tiles[0].save.sha256, sha(1));
  assert.equal(manifest.ruleset.single_segment, false);
});

test("hello with another protocol or engine build is refused", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  const base = { type: /** @type {const} */ ("hello"), bxt_version: "t", dll_sha256: null, steamid64: null };
  assert.deepEqual(Object.keys(room.hello(RED, { ...base, protocol: 2, engine_build: "won" }, "t", T0)), ["error", "detail"]);
  const steam = room.hello(RED, { ...base, protocol: 1, engine_build: "steam" }, "t", T0);
  assert.ok("error" in steam && steam.error === "engine_build_unsupported");
});

test("joining: full, locked, banned, finished", () => {
  const room = makeRoom({ maxPlayers: 2 });
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  room.addPlayer({ steamid64: BLUE, name: "b", team: "blue" });
  assert.throws(() => room.addPlayer({ steamid64: RED2, name: "c", team: "red" }), (e) => e instanceof RoomError && e.code === "game_full");
  room.addPlayer({ steamid64: RED, name: "renamed", team: "blue" });
  assert.equal(room.players[RED].name, "renamed");
  const kicked = room.kick(BLUE, true);
  assert.deepEqual(kicked.close, [{ steamid64: BLUE, code: 4004, reason: "banned" }]);
  assert.deepEqual(kicked.events, ["b was banned"]);
  assert.throws(() => room.addPlayer({ steamid64: BLUE, name: "b", team: "blue" }), /banned/);
  assert.deepEqual(room.snapshot(0).banned, [BLUE]);
  room.unban(BLUE);
  assert.deepEqual(room.snapshot(0).banned, []);
  assert.throws(() => room.unban(BLUE), (e) => e instanceof RoomError && e.code === "unknown_player");
  room.addPlayer({ steamid64: BLUE, name: "b", team: "blue" });
  assert.equal(room.players[BLUE].team, "blue");
  assert.deepEqual(room.kick(BLUE, false).events, ["b was kicked"]);
  room.lock(true);
  assert.throws(() => room.addPlayer({ steamid64: RED2, name: "c", team: "red" }), /locked/);
  assert.throws(() => room.addPlayer({ steamid64: "123", name: "c", team: "red" }), /17 digits/);
});

test("the others are told when a player joins, rejoins or leaves, until the game is over", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  room.addPlayer({ steamid64: BLUE, name: "b", team: null });
  const hello = { type: /** @type {const} */ ("hello"), protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null };
  /** @param {string} id */
  const joined = (id) => {
    const result = room.hello(id, hello, "tok", T0);
    assert.ok("changes" in result);
    return result.changes.othersEvents;
  };
  assert.deepEqual(joined(RED), [{ text: "a joined RED", except: RED }]);
  assert.deepEqual(joined(BLUE), [{ text: "b joined", except: BLUE }]);
  assert.deepEqual(joined(RED), [{ text: "a rejoined", except: RED }]);
  room.setConnected(RED, true);
  assert.deepEqual(room.setConnected(RED, false, "left").othersEvents, [{ text: "a left", except: RED }]);
  room.setConnected(RED, true);
  assert.deepEqual(room.setConnected(RED, false, "lost").othersEvents, [{ text: "a lost connection", except: RED }]);
  room.setConnected(RED, true);
  assert.deepEqual(room.setConnected(RED, false).othersEvents, []);
  room.end(T0);
  assert.deepEqual(joined(RED), []);
  room.setConnected(RED, true);
  assert.deepEqual(room.setConnected(RED, false, "left").othersEvents, []);
});

test("start needs everyone ready, unless forced", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  assert.throws(() => room.start(T0, false), /not ready: a/);
  room.setConnected(RED, true);
  room.hello(RED, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "t", T0);
  const stale = room.onMessage(RED, { type: "ready", manifest_hash: "old" }, T0);
  assert.equal(sent(stale, RED, "error")[0].code, "bad_message");
  assert.deepEqual([...stale.manifests], [RED]);
  room.onMessage(RED, { type: "ready", manifest_hash: room.manifestFor(RED).manifest_hash }, T0);
  assert.equal(room.players[RED].ready, true);

  const changes = room.start(T0, false);
  assert.equal(changes.roundStart, true);
  assert.equal(room.state, "countdown");
  assert.equal(room.nextAlarm(), T0 + 5000);
  assert.deepEqual(room.roundStartMessage(T0 + 2000), {
    type: "round_start",
    countdown_ms: 3000,
    starts_at: new Date(T0 + 5000).toISOString(),
    labels: [],
  });
  assert.throws(() => room.start(T0, true), /already started/);
  room.tick(T0 + 4999);
  assert.equal(room.state, "countdown");
  room.tick(T0 + 5000);
  assert.equal(room.state, "running");
  assert.equal(room.nextAlarm(), T0 + 5000 + 15 * MIN);

  const forced = makeRoom();
  forced.addPlayer({ steamid64: RED, name: "a", team: "red" });
  forced.start(T0, true);
  assert.equal(forced.state, "countdown");
});

test("hidden labels come with round_start", () => {
  const room = makeRoom({ hideLabels: true });
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  room.hello(RED, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "t", T0);
  const hidden = room.manifestFor(RED);
  assert.equal(hidden.tiles[0].label, null);
  room.start(T0, true);
  const start = room.roundStartMessage(T0);
  assert.deepEqual(start.labels[0], { tile: "A1", label: "S0" });
  const shown = room.manifestFor(RED);
  assert.equal(shown.tiles[0].label, "S0");
  assert.equal(shown.manifest_hash, hidden.manifest_hash, "revealing labels doesn't make players download again");
});

test("a board is one game, and the manifest says which", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  assert.equal(room.manifestFor(RED).game, "valve", "segments without a game are HL1's");

  const opfor = makeTiles().map((t) => ({ ...t, segment: { ...t.segment, pool: "opfor", game: "gearbox" } }));
  const gearbox = new Room({ id: "g", settings: {}, tiles: opfor, ruleset: scriptless, handicapPresets: presets });
  gearbox.addPlayer({ steamid64: RED, name: "a", team: "red" });
  assert.equal(gearbox.manifestFor(RED).game, "gearbox");

  const mixed = opfor.map((t, i) => (i === 0 ? makeTiles()[0] : t));
  assert.throws(
    () => new Room({ id: "g", settings: {}, tiles: mixed, ruleset: scriptless, handicapPresets: presets }),
    (e) => e instanceof RoomError && /one game/.test(e.message),
  );
});

test("the pages get which segment is on each tile, hidden like the labels", () => {
  const room = makeRoom({ hideLabels: true });
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  assert.deepEqual(room.snapshot(T0).tiles[0], { id: "A1", label: null, segment: null, chapter: null });
  assert.equal(room.tilesMessage().tiles.length, 25);
  const started = room.start(T0, true);
  assert.equal(started.tiles, true, "sent again at the reveal");
  assert.deepEqual(room.tilesMessage(), { type: "tiles", tiles: room.snapshot(T0).tiles });
  assert.deepEqual(room.snapshot(T0).tiles[7], { id: "C2", label: "S7", segment: "seg-7", chapter: "Test" });

  const shown = makeRoom();
  shown.addPlayer({ steamid64: RED, name: "a", team: "red" });
  assert.equal(shown.tileInfo()[0].segment, "seg-0");
  assert.equal(shown.start(T0, true).tiles, false, "nothing to reveal");

  const ended = makeRoom({ hideLabels: true });
  assert.equal(ended.end(T0).tiles, true, "ending in the lobby shows them too");
  assert.equal(ended.tileInfo()[0].label, "S0");
});

test("a capture: ack, event, board", () => {
  const { room, run } = runningRoom({ redoOwnTile: false });
  const { ack, changes } = run(RED, "B3", 9800, 20_000);
  assert.deepEqual(ack, { type: "result_ack", attempt_id: uuid(1), verdict: "captured", flagged: false, detail: null });
  assert.deepEqual(changes.events, ["RED took S11 — 9.800 (red)"]);
  const board = room.boardFor(BLUE, T0 + 20_000);
  const b3 = board.tiles.find((t) => t.id === "B3");
  assert.deepEqual(b3, { id: "B3", owner: "red", time_ms: 9800, holder: "red", playable_for_you: true, contesting: [] });
  assert.equal(room.boardFor(RED, T0 + 20_000).tiles[11].playable_for_you, false, "redo is off");
  assert.equal(board.clock_ms, 20_000);
});

test("a resent result gets the same answer", () => {
  const { room, run } = runningRoom();
  const { attempt_id } = run(RED, "B3", 9800, 20_000);
  const again = room.onMessage(
    RED,
    { type: "attempt_result", attempt_id, tile: "B3", time_ms: 1, server_time_delta_ms: 1, frames: 1, real_ms: 1, load_ms: 0, save_sha256: sha(12), ruleset_ok: true, demo: null },
    T0 + 30_000,
  );
  assert.equal(sent(again, RED, "result_ack")[0].verdict, "captured");
  assert.equal(room.game.holder("B3")?.timeMs, 9800);
});

test("the wrong save is rejected, and stays rejected", () => {
  const { room, run } = runningRoom();
  const { ack, attempt_id } = run(RED, "B3", 9800, 20_000, { save: sha(99) });
  assert.equal(ack.verdict, "rejected");
  assert.match(ack.detail, /save/);
  assert.equal(room.game.holder("B3"), null);
  const again = room.onMessage(
    RED,
    { type: "attempt_result", attempt_id, tile: "B3", time_ms: 9800, server_time_delta_ms: 1, frames: 1, real_ms: 1, load_ms: 0, save_sha256: sha(12), ruleset_ok: true, demo: null },
    T0 + 30_000,
  );
  assert.equal(sent(again, RED, "result_ack")[0].verdict, "rejected");
});

test("suspicious results claim the tile but are flagged", () => {
  const { room, run } = runningRoom();
  const noStart = run(RED, "A1", 9800, 20_000, { started: false });
  assert.equal(noStart.ack.verdict, "captured", "the real verdict, for BXT's sound");
  assert.equal(noStart.ack.flagged, true);
  assert.match(noStart.ack.detail, /held for review: no attempt_started/);
  assert.equal(room.game.holder("A1")?.team, "red");

  const tooFast = run(BLUE, "A2", 5000, 30_000);
  assert.match(tooFast.ack.detail, /97%/);

  // Started 60 s before the end, for a 20 s run: slowmo?
  room.onMessage(RED, { type: "attempt_started", attempt_id: uuid(50), tile: "A3" }, T0 + 40_000);
  const slow = room.onMessage(
    RED,
    { type: "attempt_result", attempt_id: uuid(50), tile: "A3", time_ms: 20_000, server_time_delta_ms: 1, frames: 1, real_ms: 1, load_ms: 0, save_sha256: sha(11), ruleset_ok: true, demo: null },
    T0 + 100_000,
  );
  assert.match(sent(slow, RED, "result_ack")[0].detail, /server's clock/);
  assert.equal(Object.keys(room.reviews).length, 3);
  room.accept(noStart.attempt_id);
  assert.equal(room.reviews[noStart.attempt_id].accepted, true);

  // A resend after the host accepted it isn't flagged any more
  const again = room.onMessage(
    RED,
    { type: "attempt_result", attempt_id: noStart.attempt_id, tile: "A1", time_ms: 9800, server_time_delta_ms: 1, frames: 1, real_ms: 1, load_ms: 0, save_sha256: sha(1), ruleset_ok: true, demo: null },
    T0 + 200_000,
  );
  assert.equal(sent(again, RED, "result_ack")[0].flagged, false);
});

test("contesting: who picked each tile", () => {
  const { room, run } = runningRoom({ redoOwnTile: false });
  const pick = (/** @type {string} */ who, /** @type {string | null} */ tile, at = 1000) =>
    room.onMessage(who, { type: "tile_selected", tile }, T0 + at);
  const on = (/** @type {string} */ tile, /** @type {string | null} */ viewer = RED) =>
    room.boardFor(viewer, T0 + 5000).tiles.find((t) => t.id === tile)?.contesting;

  const changes = pick(BLUE, "C3");
  assert.equal(changes.board, true, "picking a tile updates the board");
  assert.deepEqual(on("C3"), [{ steamid64: BLUE, team: "blue" }]);
  pick(BLUE, "C4");
  assert.deepEqual(on("C3"), [], "picking another tile leaves the first");
  assert.equal(on("C4")?.length, 1);
  pick(BLUE, null);
  assert.deepEqual(on("C4"), []);

  // Capturing ends it, as the team can't play the tile any more
  pick(RED, "A1");
  assert.equal(on("A1")?.length, 1);
  run(RED, "A1", 9800, 20_000);
  assert.deepEqual(on("A1"), []);
  // Until blue steals it, and red is still on it
  run(BLUE, "A1", 9000, 30_000);
  assert.deepEqual(on("A1"), [{ steamid64: RED, team: "red" }]);

  // Disconnected players don't count
  room.setConnected(RED, false);
  assert.deepEqual(on("A1", null), []);
});

test("contesting only while running, and hidden from BXT when off", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: BLUE, name: "b", team: "blue" });
  room.setConnected(BLUE, true);
  room.onMessage(BLUE, { type: "tile_selected", tile: "C3" }, T0);
  assert.deepEqual(room.boardFor(null, T0).tiles[12].contesting, [], "not before the start");

  const hidden = runningRoom({ showContesting: false }).room;
  hidden.onMessage(BLUE, { type: "tile_selected", tile: "C3" }, T0 + 1000);
  assert.deepEqual(hidden.boardFor(RED, T0 + 1000).tiles[12].contesting, [], "BXT doesn't see it");
  assert.equal(hidden.boardFor(null, T0 + 1000).tiles[12].contesting.length, 1, "spectators do");
});

test("attempts keep the server's clock, one per player", () => {
  const { room } = runningRoom();
  room.onMessage(BLUE, { type: "attempt_started", attempt_id: uuid(9), tile: "C3" }, T0 + 1000);
  assert.equal(room.players[BLUE].tile, "C3", "starting a run also picks the tile");
  room.onMessage(BLUE, { type: "attempt_started", attempt_id: uuid(10), tile: "C4" }, T0 + 2000);
  assert.equal(Object.keys(room.running).length, 1);
  room.onMessage(BLUE, { type: "attempt_invalidated", attempt_id: uuid(10), tile: "C4", reason: "x" }, T0 + 3000);
  assert.equal(Object.keys(room.running).length, 0);
  assert.equal(room.players[BLUE].invalidated, 1);
});

test("a run survives a dropped connection", () => {
  const { room } = runningRoom();
  room.onMessage(RED, { type: "attempt_started", attempt_id: uuid(5), tile: "A1" }, T0 + 1000);
  room.setConnected(RED, false);
  room.setConnected(RED, true);
  const changes = room.onMessage(
    RED,
    { type: "attempt_result", attempt_id: uuid(5), tile: "A1", time_ms: 9800, server_time_delta_ms: 9800, frames: 1, real_ms: 9800, load_ms: 0, save_sha256: sha(1), ruleset_ok: true, demo: null },
    T0 + 12_000,
  );
  assert.deepEqual(sent(changes, RED, "result_ack")[0], { type: "result_ack", attempt_id: uuid(5), verdict: "captured", flagged: false, detail: null }, "not flagged");
});

test("which leaderboards a game counts for", () => {
  assert.deepEqual(makeRoom().leaderboards(), { players: "standard", segments: "scriptless" });
  assert.deepEqual(makeRoom({ singleSegment: true }).leaderboards(), { players: "standard", segments: "single_segment" });
  const scripted = new Room({ id: "g2", settings: {}, tiles: makeTiles(), ruleset: { ...scriptless, scripted: true }, handicapPresets: presets });
  assert.deepEqual(scripted.leaderboards(), { players: "standard", segments: "scripted" });

  // Handicaps only count if someone has one when the game starts, or gets one during it
  const room = makeRoom({ singleSegment: true });
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  room.setHandicaps(RED, ["autojump"]);
  room.setHandicaps(RED, []);
  room.start(T0, true);
  assert.equal(room.leaderboards().segments, "single_segment");
  room.setHandicaps(RED, ["no_damage"]);
  assert.deepEqual(room.leaderboards(), { players: "handicapped", segments: "handicapped" });
});

test("attempts outside the running game or on locked tiles", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  const early = room.onMessage(RED, { type: "attempt_started", attempt_id: uuid(1), tile: "A1" }, T0);
  assert.equal(sent(early, RED, "error")[0].code, "not_running");

  const { room: running, run } = runningRoom({ redoOwnTile: false });
  run(RED, "A1", 9800, 1000);
  const locked = running.onMessage(RED, { type: "attempt_started", attempt_id: uuid(99), tile: "A1" }, T0 + 2000);
  assert.equal(sent(locked, RED, "error")[0].code, "tile_not_playable");
});

test("a line ends the game, and voiding it reopens it", () => {
  const { room, run } = runningRoom();
  let last;
  for (const [i, tile] of ["A1", "B1", "C1", "D1", "E1"].entries()) {
    last = run(RED, tile, 9800, 20_000 + i * 20_000);
  }
  assert.equal(room.state, "finished");
  assert.equal(last?.changes.gameOver, true);
  assert.deepEqual(room.gameOverMessage(), { type: "game_over", winner: "red", reason: "line", tiebreaker: null, line: ["A1", "B1", "C1", "D1", "E1"] });
  assert.equal(last?.changes.events.at(-1), "RED wins with A1 B1 C1 D1 E1");
  assert.equal(room.nextAlarm(), null);

  const late = run(BLUE, "C3", 9800, 200_000);
  assert.equal(late.ack.verdict, "game_over");

  // The players stay as they were, so the results do
  const over = (/** @type {any} */ e) => e instanceof RoomError && e.code === "game_over";
  assert.throws(() => room.kick(BLUE, false), over);
  assert.throws(() => room.movePlayer(BLUE, "red", T0 + 205_000), over);
  assert.throws(() => room.setHandicaps(BLUE, []), over);
  assert.throws(() => room.addPlayer({ steamid64: BLUE, name: "b", team: "red" }), over);
  assert.throws(() => room.addPlayer({ steamid64: RED2, name: "c", team: "red" }), over);

  const reopened = room.void(/** @type {string} */ (last?.attempt_id), T0 + 210_000);
  assert.equal(room.state, "running");
  assert.equal(reopened.lobby, true);
  assert.equal(room.game.holder("C3")?.team, "blue", "the late result counts now");
});

test("the time limit ends the game on the alarm", () => {
  const { room, run } = runningRoom({ timeLimitMs: 10 * MIN });
  run(RED, "A1", 9800, 20_000);
  assert.equal(room.nextAlarm(), T0 + 10 * MIN);
  const changes = room.tick(T0 + 10 * MIN);
  assert.equal(changes.gameOver, true);
  assert.equal(room.gameOverMessage().reason, "most_tiles");
  assert.equal(room.boardFor(null, T0 + 20 * MIN).clock_ms, 10 * MIN);
});

test("sudden death is announced and moves the alarm", () => {
  const { room, run } = runningRoom({ timeLimitMs: 10 * MIN, suddenDeathMs: 5 * MIN });
  run(RED, "A1", 9800, 20_000);
  run(BLUE, "A2", 9800, 40_000);
  const changes = room.tick(T0 + 10 * MIN);
  assert.match(changes.events[0], /sudden death for 5:00/);
  assert.equal(room.nextAlarm(), T0 + 15 * MIN);
  const winner = run(BLUE, "C3", 9800, 11 * MIN);
  assert.equal(winner.changes.gameOver, true);
  assert.equal(room.gameOverMessage().reason, "sudden_death");
});

test("redo own tile is on unless turned off", () => {
  assert.equal(makeRoom().settings.redoOwnTile, true);
  assert.equal(makeRoom({ redoOwnTile: false }).settings.redoOwnTile, false);
  const { room, run } = runningRoom();
  run(RED, "B3", 9800, 20_000);
  assert.equal(room.boardFor(RED, T0 + 20_000).tiles[11].playable_for_you, true);
  assert.equal(run(RED, "B3", 9000, 40_000).ack.verdict, "improved");
});

test("sudden death is on for 10 minutes unless turned off", () => {
  assert.equal(makeRoom().settings.suddenDeathMs, 10 * MIN);
  assert.equal(makeRoom({ suddenDeathMs: null }).settings.suddenDeathMs, null);
  assert.equal(makeRoom({ suddenDeathMs: 3 * MIN }).settings.suddenDeathMs, 3 * MIN);
});

test("no time limit", () => {
  const { room } = runningRoom({ timeLimitMs: null });
  assert.equal(room.settings.timeLimitMs, null);
  assert.equal(room.nextAlarm(), null);
});

test("the host ends the game", () => {
  const { room } = runningRoom();
  const changes = room.end(T0 + MIN);
  assert.equal(changes.gameOver, true);
  assert.equal(room.gameOverMessage().reason, "host_ended");
});

test("handicaps change that player's manifest", () => {
  const room = makeRoom();
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  room.hello(RED, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "t", T0);
  const before = room.manifestFor(RED);
  const changes = room.setHandicaps(RED, ["no_attack2", "no_damage", "autojump"]);
  assert.deepEqual([...changes.manifests], [RED]);
  const after = room.manifestFor(RED);
  assert.notEqual(after.manifest_hash, before.manifest_hash);
  assert.equal(after.ruleset.no_damage, true);
  assert.ok(after.ruleset.commands.blocked.includes("+attack2"));
  assert.ok(!after.ruleset.commands.allowed.includes("+attack2"));
  assert.ok(after.ruleset.commands.allowed.includes("+bxt_tas_autojump"));
  assert.equal(after.ruleset.cvars.find((r) => r.name === "bxt_autojump")?.op, "any");
  assert.deepEqual(room.lobbyMessage().players[0].handicaps, ["No +attack2", "No damage%", "Autojump"]);
  assert.throws(() => room.setHandicaps(RED, ["flying"]), /unknown handicap/);
});

test("most handicaps: assists count against the team", () => {
  // Red: No damage% and No +attack2 (+2). Blue: No damage% and Autojump (0)
  const { room } = runningRoom({ timeLimitMs: 10 * MIN, suddenDeathMs: null, tiebreakers: ["most_handicaps"] });
  room.setHandicaps(RED, ["no_damage", "no_attack2"]);
  room.setHandicaps(BLUE, ["no_damage", "autojump"]);
  room.tick(T0 + 10 * MIN);
  assert.deepEqual(room.gameOverMessage(), { type: "game_over", winner: "red", reason: "tiebreaker", tiebreaker: "most_handicaps", line: null });

  // Two assists lose to none
  const assisted = runningRoom({ timeLimitMs: 10 * MIN, suddenDeathMs: null, tiebreakers: ["most_handicaps"] }).room;
  assisted.setHandicaps(RED, ["autojump", "ducktap"]);
  assisted.tick(T0 + 10 * MIN);
  assert.equal(assisted.gameOverMessage().winner, "blue");
});

test("applyHandicaps doesn't change its input", () => {
  const out = applyHandicaps(scriptless, [presets.no_attack2]);
  assert.ok(scriptless.commands.allowed.includes("+attack2"));
  assert.ok(!out.commands.allowed.includes("+attack2"));
  assert.throws(() => checkHandicapPresets({ x: { name: "X", kind: "assist", fly: true } }), /unknown field/);
  assert.throws(() => checkHandicapPresets({ x: { name: "X" } }), /kind must be/);
  assert.equal(presets.ducktap.kind, "assist");
});

test("the other handicaps", () => {
  const out = applyHandicaps(scriptless, [presets.duckless, presets.pacifist, presets.bloodthirsty, presets.single_segment, presets.jupiter]);
  assert.ok(out.commands.blocked.includes("+duck") && out.commands.blocked.includes("+attack"));
  assert.ok(!out.commands.allowed.includes("+duck"));
  assert.equal(out.require_kill, true);
  assert.equal(out.single_segment, true);
  assert.deepEqual(out.cvars.filter((r) => r.name === "sv_gravity"), [{ name: "sv_gravity", op: "set", value: "2021.61" }]);
  assert.equal(scriptless.require_kill, undefined);

  // The later one wins when two set the same cvar
  const both = applyHandicaps(scriptless, [presets.reverse, presets.cs16]);
  assert.deepEqual(both.cvars.filter((r) => r.name === "sv_accelerate"), [{ name: "sv_accelerate", op: "set", value: "5" }]);
  assert.equal(both.cvars.find((r) => r.name === "sv_airaccelerate")?.value, "-1");

  for (const [id, h] of Object.entries(presets)) {
    if (!["autojump", "ducktap"].includes(id)) {
      assert.equal(h.kind, "handicap", id);
    }
  }
  assert.throws(() => checkHandicapPresets({ x: { name: "X", kind: "handicap", set_cvars: { name: "cheater" } } }), /only set sv_ cvars/);
  assert.throws(() => checkHandicapPresets({ x: { name: "X", kind: "handicap", set_cvars: { sv_gravity: "1; quit" } } }), /only set sv_ cvars/);
  assert.throws(() => checkHandicapPresets({ x: { name: "X", kind: "handicap", require_kill: "yes" } }), /true or false/);
});

test("a stored room comes back the same", () => {
  const { room, run } = runningRoom({ timeLimitMs: 10 * MIN, suddenDeathMs: null, lockout: true });
  const first = run(RED, "A1", 9800, 20_000, { started: false });
  run(BLUE, "B2", 9800, 30_000);
  room.onMessage(BLUE, { type: "attempt_started", attempt_id: uuid(77), tile: "C3" }, T0 + 40_000);

  const stored = JSON.parse(JSON.stringify(room));
  const log = JSON.parse(JSON.stringify(room.game.log));
  const back = Room.restore(stored, log);
  assert.deepEqual(back.boardFor(RED, T0 + 50_000), room.boardFor(RED, T0 + 50_000));
  assert.deepEqual(back.lobbyMessage(), room.lobbyMessage());
  assert.equal(back.nextAlarm(), room.nextAlarm());
  assert.equal(back.reviews[first.attempt_id].flags.length, 1);
  assert.equal(back.settings.lockout, true);
  back.tick(T0 + 10 * MIN);
  assert.equal(back.gameOverMessage().reason, "draw", "1 tile each, no tiebreakers");
});

test("snapshot for the web pages", () => {
  const { room, run } = runningRoom();
  run(RED, "A1", 9800, 20_000);
  const snap = room.snapshot(T0 + 30_000);
  assert.equal(snap.results.length, 1);
  assert.equal(snap.results[0].segment, "seg-0");
  assert.equal(snap.lobby.state, "running");
});

test("extra files: safe paths, in the manifest, and the ones in files/ match their list", () => {
  for (const good of ["sound/bingo/firework.wav", "sound/a-b_c.wav"]) {
    assert.equal(isSafeExtraPath(good), true, good);
  }
  for (const bad of ["../hl.exe", "sound/../../x.wav", "/sound/x.wav", "sound\\x.wav", "Sound/X.wav", "sound/x.dll", "x.wav", "sound//x.wav", "sound/./x.wav"]) {
    assert.equal(isSafeExtraPath(bad), false, bad);
  }

  const list = JSON.parse(readFileSync(new URL("../rules/extra-files.json", import.meta.url), "utf8"));
  for (const file of list) {
    const bytes = readFileSync(new URL(`../files/${file.path}`, import.meta.url));
    assert.equal(bytes.length, file.size, file.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
  }

  const room = new Room({ id: "g", settings: {}, tiles: makeTiles(), ruleset: scriptless, handicapPresets: presets, extraFiles: list });
  room.addPlayer({ steamid64: RED, name: "a", team: "red" });
  room.hello(RED, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "t", T0);
  assert.deepEqual(room.manifestFor(RED).extra_files, list);
  assert.equal(room.manifestFor(RED).files_url, "/files/");
  room.filesUrl = "https://assets.example/files/";
  assert.equal(room.manifestFor(RED).files_url, "https://assets.example/files/");
  assert.ok(!("filesUrl" in room.toJSON()), "the Worker sets it, so it isn't stored");
  const plain = makeRoom();
  plain.addPlayer({ steamid64: RED, name: "a", team: "red" });
  plain.hello(RED, { type: "hello", protocol: 1, bxt_version: "t", engine_build: "won", dll_sha256: null, steamid64: null }, "t", T0);
  assert.deepEqual(plain.manifestFor(RED).extra_files, []);
  assert.notEqual(room.manifestFor(RED).manifest_hash, plain.manifestFor(RED).manifest_hash, "a new extra file means downloading again");
  assert.throws(() => new Room({ id: "g", settings: {}, tiles: makeTiles(), ruleset: scriptless, handicapPresets: presets, extraFiles: [{ path: "../x.wav", sha256: "0".repeat(64), size: 1 }] }), /bad extra file/);
});
