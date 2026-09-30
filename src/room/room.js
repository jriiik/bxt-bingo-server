// One bingo game: players, lobby, manifests, attempts and results, around the rules in src/game
//
// Pure logic with no I/O, like src/game: the Durable Object (worker/game-room.js) owns the
// sockets, storage and alarms, calls in here, and sends what the returned Changes say
// Time comes in as unix ms (`now`), the match clock is derived from it

import { Game } from "../game/game.js";
import { ALL_TILES, isTeam, tileIndex } from "../protocol/ids.js";
import { PROTOCOL_VERSION } from "../protocol/messages.js";
import { DEFAULT_GAME, isSafeExtraPath } from "../protocol/segment.js";
import { applyHandicaps } from "../rules/handicaps.js";
import { cleanName, endingText, formatClock, joinText, kickText, leaveText, resultText } from "./format.js";

/**
 * @typedef {import("../protocol/ids.js").Team} Team
 * @typedef {import("../protocol/ids.js").TileId} TileId
 * @typedef {import("../protocol/segment.js").Segment} Segment
 * @typedef {import("../protocol/segment.js").Ruleset} Ruleset
 * @typedef {import("../protocol/messages.js").ClientMessage} ClientMessage
 * @typedef {import("../protocol/messages.js").ServerMessage} ServerMessage
 * @typedef {import("../protocol/messages.js").LobbyState} LobbyState
 * @typedef {import("../protocol/messages.js").Verdict} Verdict
 * @typedef {import("../protocol/messages.js").ErrorCode} ErrorCode
 * @typedef {import("../rules/handicaps.js").Handicap} Handicap
 * @typedef {import("../game/game.js").Settings} GameSettings
 */

/**
 * The lobby creator's choices (BINGO.md §10), on top of the game's rules
 * @typedef {GameSettings & {
 *   singleSegment?: boolean,
 *   showContesting?: boolean,
 *   hideLabels?: boolean,
 *   countdownMs?: number,
 *   maxPlayers?: number,
 *   teamColors?: Partial<Record<Team, string>>,
 * }} RoomSettings
 */

/**
 * @typedef {object} Player
 * @property {string} steamid64
 * @property {string} name
 * @property {Team | null} team
 * @property {string[]} handicaps Preset ids from rules/handicaps.json
 * @property {boolean} ready
 * @property {boolean} connected
 * @property {TileId | null} tile
 * @property {{ done: number, total: number } | null} download
 * @property {string | null} engineBuild From `hello`
 * @property {string | null} bxtVersion
 * @property {string | null} reportedSteamid The SteamID BXT reported, when it isn't this player's
 * @property {number} invalidated Runs BXT reported as invalid
 */

/**
 * @typedef {object} RunningAttempt
 * @property {string} player
 * @property {TileId} tile
 * @property {number} startedAt Unix ms, on the server's clock
 */

/**
 * Something the caller got wrong, with the code to answer with
 * `game_full`, `game_locked`, `game_over`, `banned` refuse a join
 * `not_ready`, `bad_state`, `game_over`, `unknown_player`, `unknown_attempt`, `bad_request` refuse a host action
 */
export class RoomError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** What the caller has to send after a call */
export class Changes {
  /** Send `lobby` to everyone */
  lobby = false;
  /** Send `board` to everyone, each their own */
  board = false;
  /** Send `round_start` to everyone */
  roundStart = false;
  /** Send `game_over` to everyone */
  gameOver = false;
  /** Send `tiles` to the pages, e.g. when hidden labels are revealed */
  tiles = false;
  /**
   * Players who need their `manifest` again
   * @type {Set<string>}
   */
  manifests = new Set();
  /**
   * Texts for `event`, to everyone
   * @type {string[]}
   */
  events = [];
  /**
   * Texts for `event`, to everyone but one player, e.g. that they joined
   * @type {{ text: string, except: string }[]}
   */
  othersEvents = [];
  /**
   * Messages for one player's BXT
   * @type {{ steamid64: string, message: ServerMessage }[]}
   */
  send = [];
  /**
   * BXT sockets to close
   * @type {{ steamid64: string, code: number, reason: string }[]}
   */
  close = [];
  /** The alarm may have moved, ask nextAlarm() again */
  alarm = false;
  /** Something changed that has to be stored */
  save = false;
}

// A result may take this much longer on the server's clock than its game time plus loads
// before it's flagged, e.g. for slowmo
const CLOCK_TOLERANCE_MS = 2000;
const CLOCK_TOLERANCE_RATIO = 0.05;

// Times under this share of the segment's reference are flagged
const REFERENCE_RATIO = 0.97;

// Files are downloaded from the server BXT connected to, unless the Worker says otherwise
export const DEFAULT_FILES_URL = "/files/";

/** @param {number} unixMs */
const iso = (unixMs) => new Date(unixMs).toISOString();

/**
 * A short, stable hash of a JSON value, to version manifests. Not for security
 * @param {unknown} value
 */
function hashJson(value) {
  const text = JSON.stringify(value);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

export class Room {
  /**
   * @param {object} init
   * @param {string} init.id
   * @param {RoomSettings} init.settings
   * @param {{ id: TileId, segment: Segment }[]} init.tiles All 25, one per tile
   * @param {Ruleset} init.ruleset The standard ruleset the game uses, e.g. rules/won-scriptless.json
   * @param {Record<string, Handicap>} init.handicapPresets
   * @param {import("../protocol/segment.js").ExtraFile[]} [init.extraFiles] e.g. rules/extra-files.json
   */
  constructor({ id, settings, tiles, ruleset, handicapPresets, extraFiles = [] }) {
    for (const file of extraFiles) {
      if (!isSafeExtraPath(file.path) || !/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new RoomError("bad_request", `bad extra file ${JSON.stringify(file.path)}`);
      }
    }
    if (tiles.length !== ALL_TILES.length || new Set(tiles.map((t) => tileIndex(t.id))).size !== ALL_TILES.length) {
      throw new RoomError("bad_request", `the board needs each of the ${ALL_TILES.length} tiles once`);
    }
    // Nobody can switch games in the middle of a match
    const games = [...new Set(tiles.map((t) => t.segment.game ?? DEFAULT_GAME))];
    if (games.length > 1) {
      throw new RoomError("bad_request", `a board is one game, this one has segments from ${games.join(", ")}`);
    }
    this.id = id;
    /** The game folder the board is played in, e.g. `valve` */
    this.gameFolder = games[0];
    this.settings = Object.freeze({
      // On unless it's given
      redoOwnTile: settings.redoOwnTile ?? true,
      lockout: settings.lockout ?? false,
      // 15 minutes unless it's given, and null turns it off
      timeLimitMs: settings.timeLimitMs === undefined ? 15 * 60_000 : settings.timeLimitMs,
      // On for 10 minutes unless it's given, and null turns it off
      suddenDeathMs: settings.suddenDeathMs === undefined ? 10 * 60_000 : settings.suddenDeathMs,
      tiebreakers: [...(settings.tiebreakers ?? [])],
      singleSegment: settings.singleSegment ?? false,
      showContesting: settings.showContesting ?? true,
      hideLabels: settings.hideLabels ?? false,
      countdownMs: settings.countdownMs ?? 5000,
      maxPlayers: settings.maxPlayers ?? 16,
      teamColors: { ...settings.teamColors },
    });
    /** @type {Record<TileId, Segment>} */
    this.tiles = Object.fromEntries(tiles.map((t) => [t.id, t.segment]));
    this.ruleset = ruleset;
    this.handicapPresets = handicapPresets;
    this.extraFiles = extraFiles;
    /** Where BXT downloads files, from the Worker's FILES_URL. Not stored */
    this.filesUrl = DEFAULT_FILES_URL;

    /** @type {LobbyState} */
    this.state = "lobby";
    this.locked = false;
    this.seq = 0;
    /** @type {number | null} When the countdown ends and the clock starts, unix ms */
    this.startsAt = null;
    /** @type {Record<string, Player>} */
    this.players = {};
    /** @type {string[]} */
    this.banned = [];
    /** @type {Record<string, RunningAttempt>} */
    this.running = {};
    /**
     * Results refused before the rules, so a resent one gets the same answer
     * @type {Record<string, string>}
     */
    this.rejected = {};
    /**
     * Flagged results waiting for the host
     * @type {Record<string, { player: string, tile: TileId, timeMs: number, flags: string[], accepted: boolean }>}
     */
    this.reviews = {};
    this.game = new Game(this.settings);
    this.suddenDeathAnnounced = false;
    /** Someone played with a handicap, so the times go on the handicapped leaderboards */
    this.handicapsUsed = false;
  }

  /** Everything to store, apart from the game's log */
  toJSON() {
    const { game, filesUrl, ...rest } = this;
    return { ...rest, gameNow: game.now, gameTeamStats: game.teamStats };
  }

  /**
   * @param {ReturnType<Room["toJSON"]>} stored
   * @param {import("../game/game.js").Entry[]} log
   */
  static restore(stored, log) {
    const { gameNow, gameTeamStats, ...fields } = structuredClone(stored);
    const tiles = Object.entries(fields.tiles).map(([id, segment]) => ({ id, segment }));
    const room = new Room({ ...fields, tiles });
    Object.assign(room, fields);
    room.game = Game.restore(room.settings, { log, now: gameNow, teamStats: gameTeamStats });
    return room;
  }

  // Players

  /**
   * Adds a player, or updates their name and team if they're in already
   * The caller has checked who they are (Steam login)
   * @param {{ steamid64: string, name: string, team: Team | null }} who
   */
  addPlayer({ steamid64, name, team }) {
    const changes = new Changes();
    if (!/^\d{17}$/.test(steamid64)) {
      throw new RoomError("bad_request", "steamid64 must be 17 digits");
    }
    if (team !== null && !isTeam(team)) {
      throw new RoomError("bad_request", "team must be red, blue or null");
    }
    // Also for players already in, so the teams in the results stay as they were
    this.#notFinished();
    if (this.banned.includes(steamid64)) {
      throw new RoomError("banned", "banned from this game");
    }
    const existing = this.players[steamid64];
    if (!existing) {
      if (this.locked) {
        throw new RoomError("game_locked", "the game is locked");
      }
      if (Object.keys(this.players).length >= this.settings.maxPlayers) {
        throw new RoomError("game_full", "the game is full");
      }
      this.players[steamid64] = {
        steamid64,
        name: cleanName(name),
        team,
        handicaps: [],
        ready: false,
        connected: false,
        tile: null,
        download: null,
        engineBuild: null,
        bxtVersion: null,
        reportedSteamid: null,
        invalidated: 0,
      };
    } else {
      existing.name = cleanName(name);
      this.#setTeam(existing, team, changes);
    }
    changes.lobby = changes.save = true;
    return changes;
  }

  /**
   * @param {string} steamid64
   * @param {Team | null} team
   * @param {number} now
   */
  movePlayer(steamid64, team, now) {
    const changes = new Changes();
    if (team !== null && !isTeam(team)) {
      throw new RoomError("bad_request", "team must be red, blue or null");
    }
    this.#notFinished();
    this.#setTeam(this.#player(steamid64), team, changes);
    this.#advance(now, changes);
    return changes;
  }

  /**
   * @param {Player} player
   * @param {Team | null} team
   * @param {Changes} changes
   */
  #setTeam(player, team, changes) {
    if (player.team === team) {
      return;
    }
    player.team = team;
    this.#stopAttempts(player.steamid64);
    changes.lobby = changes.save = true;
    this.#boardChanged(changes);
  }

  /**
   * @param {string} steamid64
   * @param {string[]} handicaps Preset ids
   */
  setHandicaps(steamid64, handicaps) {
    this.#notFinished();
    const player = this.#player(steamid64);
    for (const id of handicaps) {
      if (!Object.hasOwn(this.handicapPresets, id)) {
        throw new RoomError("bad_request", `unknown handicap ${id}`);
      }
    }
    const changes = new Changes();
    player.handicaps = [...new Set(handicaps)];
    if (this.state !== "lobby" && player.team && player.handicaps.length > 0) {
      this.handicapsUsed = true;
    }
    // Their rules changed, so they have to confirm the new manifest
    player.ready = false;
    changes.manifests.add(steamid64);
    changes.lobby = changes.save = true;
    return changes;
  }

  /**
   * @param {string} steamid64
   * @param {boolean} ban Also refuse them joining again
   */
  kick(steamid64, ban) {
    this.#notFinished();
    const player = this.#player(steamid64);
    const changes = new Changes();
    delete this.players[player.steamid64];
    if (ban) {
      this.banned.push(steamid64);
    }
    this.#stopAttempts(steamid64);
    changes.close.push({ steamid64, code: ban ? 4004 : 4001, reason: ban ? "banned" : "kicked" });
    changes.events.push(kickText(player.name, ban));
    changes.lobby = changes.save = true;
    this.#boardChanged(changes);
    return changes;
  }

  /**
   * Lets a banned player join again
   * They come back like a new player: the host adds them and gives them a join code
   * @param {string} steamid64
   */
  unban(steamid64) {
    if (!this.banned.includes(steamid64)) {
      throw new RoomError("unknown_player", `${steamid64} isn't banned from this game`);
    }
    this.banned = this.banned.filter((id) => id !== steamid64);
    const changes = new Changes();
    changes.save = true;
    return changes;
  }

  /** @param {boolean} locked */
  lock(locked) {
    this.locked = locked;
    const changes = new Changes();
    changes.lobby = changes.save = true;
    return changes;
  }

  /**
   * The BXT socket of a player opened or closed
   * @param {string} steamid64
   * @param {boolean} connected
   * @param {"left" | "lost" | null} [how] How it closed, for telling the others, `null` tells nobody
   */
  setConnected(steamid64, connected, how = null) {
    const changes = new Changes();
    const player = this.players[steamid64];
    if (player && player.connected !== connected) {
      // A run in progress is kept: BXT sends its result after reconnecting,
      // and the server's clock check still needs when it started
      player.connected = connected;
      this.#boardChanged(changes);
      changes.lobby = changes.save = true;
      // Like joins, not once the game is over
      if (!connected && how && this.state !== "finished") {
        changes.othersEvents.push({ text: leaveText(player.name, how), except: steamid64 });
      }
    }
    return changes;
  }

  /**
   * Refuses changing the players once the game is over, so the results stay as they were
   * Voiding and accepting results still work
   */
  #notFinished() {
    if (this.state === "finished") {
      throw new RoomError("game_over", "the game is over");
    }
  }

  /** @param {string} steamid64 */
  #player(steamid64) {
    const player = this.players[steamid64];
    if (!player) {
      throw new RoomError("unknown_player", `no player ${steamid64} in this game`);
    }
    return player;
  }

  // The round

  /**
   * The host starts the countdown
   * @param {number} now
   * @param {boolean} force Start even if not everyone is ready
   */
  start(now, force) {
    if (this.state !== "lobby") {
      throw new RoomError("bad_state", "the game has already started");
    }
    const playing = Object.values(this.players).filter((p) => p.team);
    if (playing.length === 0) {
      throw new RoomError("not_ready", "nobody is on a team");
    }
    const waiting = playing.filter((p) => !p.connected || !p.ready);
    if (waiting.length > 0 && !force) {
      throw new RoomError("not_ready", `not ready: ${waiting.map((p) => p.name).join(", ")}`);
    }
    const changes = new Changes();
    this.state = "countdown";
    this.handicapsUsed = playing.some((p) => p.handicaps.length > 0);
    this.startsAt = now + this.settings.countdownMs;
    // The labels come with round_start, and are in the manifest for anyone who connects later
    changes.roundStart = changes.lobby = changes.alarm = changes.save = true;
    changes.tiles = this.settings.hideLabels;
    this.#boardChanged(changes);
    return changes;
  }

  /**
   * The host ends the game early, with no winner
   * @param {number} now
   */
  end(now) {
    const changes = new Changes();
    if (this.state === "finished") {
      return changes;
    }
    if (this.state === "running") {
      this.game.endByHost(this.#clock(now));
    } else {
      this.game.endByHost(0);
    }
    // Ended in the lobby: hidden labels are shown now
    changes.tiles = this.settings.hideLabels && this.state === "lobby";
    this.#finish(changes);
    return changes;
  }

  /** When the caller has to call tick() next, unix ms, or null */
  nextAlarm() {
    if (this.state === "countdown") {
      return this.startsAt;
    }
    const deadline = this.state === "running" ? this.game.nextDeadlineMs() : null;
    return deadline === null || this.startsAt === null ? null : this.startsAt + deadline;
  }

  /**
   * The alarm went off
   * @param {number} now
   */
  tick(now) {
    const changes = new Changes();
    if (this.state === "countdown" && this.startsAt !== null && now >= this.startsAt) {
      this.state = "running";
      changes.lobby = changes.alarm = changes.save = true;
      this.#boardChanged(changes);
    }
    this.#advance(now, changes);
    return changes;
  }

  /**
   * Moves the game's clock, which may end it
   * @param {number} now
   * @param {Changes} changes
   */
  #advance(now, changes) {
    if (this.state !== "running") {
      return;
    }
    const ending = this.game.advance(this.#clock(now), this.#teamStats());
    changes.save = true;
    if (ending) {
      this.#finish(changes);
    } else if (this.game.suddenDeath && !this.suddenDeathAnnounced) {
      this.suddenDeathAnnounced = true;
      changes.events.push(`Time's up with even tiles: sudden death for ${formatClock(this.settings.suddenDeathMs ?? 0)}`);
      changes.alarm = true;
      this.#boardChanged(changes);
    }
  }

  /** @param {Changes} changes */
  #finish(changes) {
    const ending = this.game.ending;
    if (!ending) {
      return;
    }
    this.state = "finished";
    this.running = {};
    changes.gameOver = changes.lobby = changes.alarm = changes.save = true;
    changes.events.push(endingText(ending));
    this.#boardChanged(changes);
  }

  /**
   * The match clock, never going back
   * @param {number} now
   */
  #clock(now) {
    return Math.max(this.game.now, now - (this.startsAt ?? now));
  }

  #teamStats() {
    /** @type {import("../game/game.js").TeamStats} */
    const stats = { red: { players: 0, handicaps: 0 }, blue: { players: 0, handicaps: 0 } };
    for (const p of Object.values(this.players)) {
      if (p.team) {
        stats[p.team].players++;
        // Assists count against the team
        for (const id of p.handicaps) {
          stats[p.team].handicaps += this.handicapPresets[id]?.kind === "assist" ? -1 : 1;
        }
      }
    }
    return stats;
  }

  // Moderation

  /**
   * Removes a result, which can change the board, the winner, or reopen the game
   * @param {string} attemptId
   * @param {number} now
   */
  void(attemptId, now) {
    if (this.game.verdictOf(attemptId) === null) {
      throw new RoomError("unknown_attempt", `no counting result ${attemptId}`);
    }
    const changes = new Changes();
    const before = this.game.ending;
    this.game.void(attemptId);
    delete this.reviews[attemptId];
    const after = this.game.ending;
    if (!after && this.state === "finished") {
      // Voiding the winning result reopens the game
      this.state = "running";
      changes.events.push("A result was voided, the game goes on");
      changes.lobby = changes.alarm = true;
      this.#advance(now, changes);
    } else if (after && JSON.stringify(after) !== JSON.stringify(before)) {
      this.#finish(changes);
    }
    changes.save = true;
    this.#boardChanged(changes);
    return changes;
  }

  /**
   * The host accepts a flagged result, so it counts for the leaderboards too
   * @param {string} attemptId
   */
  accept(attemptId) {
    const review = this.reviews[attemptId];
    if (!review) {
      throw new RoomError("unknown_attempt", `no flagged result ${attemptId}`);
    }
    review.accepted = true;
    const changes = new Changes();
    changes.save = true;
    return changes;
  }

  // BXT

  /**
   * The first message on a BXT socket
   * Returns an error code instead when the connection can't go on
   * @param {string} steamid64
   * @param {import("../protocol/messages.js").Hello} hello
   * @param {string} sessionToken For the welcome message
   * @param {number} now
   * @returns {{ changes: Changes } | { error: ErrorCode, detail: string }}
   */
  hello(steamid64, hello, sessionToken, now) {
    const player = this.#player(steamid64);
    if (hello.protocol !== PROTOCOL_VERSION) {
      return { error: "protocol_unsupported", detail: `the server speaks protocol ${PROTOCOL_VERSION}, update BXT` };
    }
    const missing = Object.entries(this.tiles).filter(([, s]) => !s.saves[hello.engine_build]);
    if (missing.length > 0) {
      return { error: "engine_build_unsupported", detail: `no saves for the ${hello.engine_build} build of the game` };
    }

    const changes = new Changes();
    // The others are told, but not once the game is over
    // engineBuild is only null before the player's first hello
    if (this.state !== "finished") {
      changes.othersEvents.push({ text: joinText(player.name, player.team, player.engineBuild !== null), except: steamid64 });
    }
    if (player.engineBuild !== hello.engine_build) {
      player.ready = false;
    }
    player.engineBuild = hello.engine_build;
    player.bxtVersion = hello.bxt_version;
    player.reportedSteamid = hello.steamid64 !== null && hello.steamid64 !== steamid64 ? hello.steamid64 : null;
    changes.save = changes.lobby = true;

    /** @param {ServerMessage} message */
    const send = (message) => changes.send.push({ steamid64, message });
    send({
      type: "welcome",
      session_token: sessionToken,
      server_time: iso(now),
      player: { steamid64, name: player.name, team: player.team },
    });
    send(this.lobbyMessage());
    send(this.manifestFor(steamid64));
    if (this.state === "countdown") {
      send(this.roundStartMessage(now));
    }
    send(this.boardFor(steamid64, now));
    if (this.state === "finished") {
      send(this.gameOverMessage());
    }
    return { changes };
  }

  /**
   * Any message from BXT after `hello`
   * @param {string} steamid64
   * @param {ClientMessage} message Already checked by parseClientMessage
   * @param {number} now
   */
  onMessage(steamid64, message, now) {
    const player = this.#player(steamid64);
    const changes = new Changes();
    /**
     * @param {ErrorCode} code
     * @param {string} detail
     */
    const error = (code, detail) => changes.send.push({ steamid64, message: { type: "error", code, detail } });

    switch (message.type) {
      case "hello":
        error("bad_message", "hello was already sent");
        break;
      case "ping":
        changes.send.push({ steamid64, message: { type: "pong" } });
        break;
      case "tile_selected":
        // Contesting starts here, when the player picks the tile (BINGO.md §10)
        player.tile = message.tile;
        changes.lobby = changes.save = true;
        this.#boardChanged(changes);
        break;
      case "download_progress":
        player.download = { done: message.done, total: message.total };
        changes.lobby = true;
        break;
      case "ready":
        if (message.manifest_hash !== this.#manifestHash(player)) {
          error("bad_message", "ready for an older manifest");
          changes.manifests.add(steamid64);
        } else {
          player.ready = true;
          player.download = null;
          changes.lobby = changes.save = true;
        }
        break;
      case "attempt_started":
        if (this.state !== "running") {
          error("not_running", "the game isn't running");
        } else if (!player.team || !this.game.isPlayable(player.team, message.tile)) {
          error("tile_not_playable", `${message.tile} isn't playable for your team`);
        } else {
          this.#stopAttempts(steamid64);
          this.running[message.attempt_id] = { player: steamid64, tile: message.tile, startedAt: now };
          changes.save = true;
          if (player.tile !== message.tile) {
            player.tile = message.tile;
            changes.lobby = true;
            this.#boardChanged(changes);
          }
        }
        break;
      case "attempt_result":
        this.#result(player, message, now, changes);
        break;
      case "attempt_invalidated": {
        if (this.running[message.attempt_id]?.player === steamid64) {
          delete this.running[message.attempt_id];
        }
        player.invalidated++;
        changes.save = true;
        break;
      }
      case "demo_uploaded":
        // Demos come with evidence (BINGO.md §9 step 7)
        break;
    }
    return changes;
  }

  /**
   * @param {Player} player
   * @param {import("../protocol/messages.js").AttemptResult} r
   * @param {number} now
   * @param {Changes} changes
   */
  #result(player, r, now, changes) {
    /**
     * @param {Verdict} verdict
     * @param {string | null} detail
     * @param {boolean} [flagged]
     */
    const ack = (verdict, detail, flagged = false) =>
      changes.send.push({
        steamid64: player.steamid64,
        message: { type: "result_ack", attempt_id: r.attempt_id, verdict, flagged, detail },
      });

    // BXT resends until acked, so a known attempt gets its answer again
    const known = this.game.verdictOf(r.attempt_id);
    if (known !== null) {
      const review = this.reviews[r.attempt_id];
      const waiting = Boolean(review && !review.accepted);
      ack(known, waiting ? `held for review: ${review.flags.join("; ")}` : null, waiting);
      return;
    }
    if (Object.hasOwn(this.rejected, r.attempt_id)) {
      ack("rejected", this.rejected[r.attempt_id]);
      return;
    }

    const attempt = this.running[r.attempt_id];
    const segment = this.tiles[r.tile];
    const save = player.engineBuild ? segment.saves[player.engineBuild] : undefined;
    /** @type {string | null} */
    let refusal = null;
    if (this.state === "lobby" || this.state === "countdown") {
      refusal = "the game isn't running";
    } else if (!player.team) {
      refusal = "you're not on a team";
    } else if (!save || r.save_sha256 !== save.sha256) {
      refusal = "the run didn't start from the tile's save";
    } else if (!r.ruleset_ok) {
      refusal = "the run broke the rules";
    } else if (attempt && attempt.tile !== r.tile) {
      refusal = "the run started on another tile";
    }
    if (refusal !== null || !player.team) {
      this.rejected[r.attempt_id] = refusal ?? "";
      ack("rejected", refusal);
      changes.save = true;
      return;
    }

    // Flags don't stop the result, the host reviews them (BINGO.md §5.2)
    const flags = [];
    if (!attempt) {
      flags.push("no attempt_started for this run");
    } else {
      const gap = now - attempt.startedAt;
      const allowed = r.time_ms + r.load_ms + Math.max(CLOCK_TOLERANCE_MS, r.time_ms * CLOCK_TOLERANCE_RATIO);
      if (gap > allowed) {
        flags.push(`took ${(gap / 1000).toFixed(1)} s on the server's clock for a ${(r.time_ms / 1000).toFixed(1)} s run`);
      }
    }
    if (segment.reference_time_ms && r.time_ms < segment.reference_time_ms * REFERENCE_RATIO) {
      flags.push("faster than 97% of the reference time");
    }
    if (player.reportedSteamid) {
      flags.push(`BXT reported SteamID ${player.reportedSteamid}`);
    }

    delete this.running[r.attempt_id];
    const clock = this.state === "running" ? this.#clock(now) : this.game.now;
    const outcome = this.game.submit({
      attemptId: r.attempt_id,
      player: player.steamid64,
      team: player.team,
      tile: r.tile,
      timeMs: r.time_ms,
      atMs: clock,
    });
    changes.save = true;
    this.#boardChanged(changes);

    const { verdict } = outcome;
    if (verdict === "captured" || verdict === "stolen" || verdict === "improved") {
      changes.events.push(resultText(verdict, player.team, segment.label, r.time_ms, player.name));
      if (flags.length > 0) {
        this.reviews[r.attempt_id] = { player: player.steamid64, tile: r.tile, timeMs: r.time_ms, flags, accepted: false };
        ack(verdict, `held for review: ${flags.join("; ")}`, true);
      } else {
        ack(verdict, null);
      }
    } else {
      ack(verdict, null);
    }
    if (outcome.ending) {
      this.#finish(changes);
    } else if (this.state === "running") {
      this.#advance(now, changes);
    }
  }

  /**
   * Drops the running attempts of a player
   * @param {string} steamid64
   */
  #stopAttempts(steamid64) {
    for (const [id, attempt] of Object.entries(this.running)) {
      if (attempt.player === steamid64) {
        delete this.running[id];
      }
    }
  }

  /** @param {Changes} changes */
  #boardChanged(changes) {
    if (!changes.board) {
      this.seq++;
    }
    changes.board = true;
  }

  // Messages

  /** @returns {import("../protocol/messages.js").Lobby} */
  lobbyMessage() {
    return {
      type: "lobby",
      state: this.state,
      locked: this.locked,
      players: Object.values(this.players).map((p) => ({
        steamid64: p.steamid64,
        name: p.name,
        team: p.team,
        ready: p.ready,
        connected: p.connected,
        tile: p.tile,
        handicaps: p.handicaps.map((id) => this.handicapPresets[id]?.name ?? id),
        download: p.download,
      })),
      teams: Object.entries(this.settings.teamColors).map(([team, color]) => ({
        team: /** @type {Team} */ (team),
        color: color ?? null,
      })),
    };
  }

  /**
   * This player's rules: the game's ruleset, single-segment, and their handicaps
   * @param {Player} player
   */
  #rulesetFor(player) {
    const base = { ...structuredClone(this.ruleset), single_segment: this.settings.singleSegment };
    return applyHandicaps(
      base,
      player.handicaps.map((id) => this.handicapPresets[id]),
    );
  }

  /** With hideLabels, nobody sees which segment is where until the start */
  #labelsHidden() {
    return this.settings.hideLabels && this.state === "lobby";
  }

  /**
   * Which segment is on each tile, for the pages. All null while the labels are hidden
   * @returns {import("../protocol/messages.js").TileInfo[]}
   */
  tileInfo() {
    const hidden = this.#labelsHidden();
    return ALL_TILES.map((id) => {
      const s = this.tiles[id];
      return { id, label: hidden ? null : s.label, segment: hidden ? null : s.id, chapter: hidden ? null : s.chapter };
    });
  }

  /** @returns {import("../protocol/messages.js").TilesMessage} */
  tilesMessage() {
    return { type: "tiles", tiles: this.tileInfo() };
  }

  /** @param {Player} player */
  #manifestTiles(player) {
    const build = player.engineBuild ?? "won";
    const hidden = this.#labelsHidden();
    return ALL_TILES.map((id) => {
      const s = this.tiles[id];
      return { id, label: hidden ? null : s.label, save: s.saves[build], start: s.start, end: s.end };
    });
  }

  /**
   * Labels don't count, so revealing them doesn't make players download again
   * @param {Player} player
   */
  #manifestHash(player) {
    const tiles = this.#manifestTiles(player).map(({ label, ...rest }) => rest);
    return hashJson({ ruleset: this.#rulesetFor(player), tiles, extraFiles: this.extraFiles });
  }

  /**
   * @param {string} steamid64
   * @returns {import("../protocol/messages.js").Manifest}
   */
  manifestFor(steamid64) {
    const player = this.#player(steamid64);
    return {
      type: "manifest",
      manifest_hash: this.#manifestHash(player),
      ruleset: this.#rulesetFor(player),
      tiles: this.#manifestTiles(player),
      extra_files: this.extraFiles,
      files_url: this.filesUrl,
      game: this.gameFolder,
    };
  }

  /**
   * @param {number} now
   * @returns {import("../protocol/messages.js").RoundStart}
   */
  roundStartMessage(now) {
    const startsAt = this.startsAt ?? now;
    return {
      type: "round_start",
      countdown_ms: Math.max(0, startsAt - now),
      starts_at: iso(startsAt),
      labels: this.settings.hideLabels ? ALL_TILES.map((tile) => ({ tile, label: this.tiles[tile].label })) : [],
    };
  }

  /**
   * The board as one player sees it, or as a spectator with `null`
   * @param {string | null} steamid64
   * @param {number} now
   * @returns {import("../protocol/messages.js").Board}
   */
  boardFor(steamid64, now) {
    const player = steamid64 === null ? null : this.players[steamid64];
    const team = player?.team ?? null;
    const showContesting = player ? this.settings.showContesting : true;
    const clock =
      this.state === "running" ? this.#clock(now) : this.state === "finished" ? (this.game.ending?.atMs ?? this.game.now) : 0;

    return {
      type: "board",
      seq: this.seq,
      clock_ms: clock,
      time_limit_ms: this.settings.timeLimitMs,
      sudden_death_ms: this.settings.suddenDeathMs,
      tiles: ALL_TILES.map((id) => {
        const holder = this.game.holder(id);
        return {
          id,
          owner: holder?.team ?? null,
          time_ms: holder?.timeMs ?? null,
          holder: holder ? (this.players[holder.player]?.name ?? "former player") : null,
          playable_for_you: this.state === "running" && team !== null && this.game.isPlayable(team, id),
          contesting: showContesting ? this.#contesting(id) : [],
        };
      }),
    };
  }

  /**
   * The players on a tile: they picked it, are connected, and their team may play it
   * A capture ends it (unless redo is on), and a steal back starts it again
   * @param {TileId} tile
   * @returns {import("../protocol/messages.js").ContestingPlayer[]}
   */
  #contesting(tile) {
    if (this.state !== "running") {
      return [];
    }
    return Object.values(this.players).flatMap((p) =>
      p.tile === tile && p.connected && p.team && this.game.isPlayable(p.team, tile) ? [{ steamid64: p.steamid64, team: p.team }] : [],
    );
  }

  /**
   * Which leaderboards this game counts for (BINGO.md §11)
   * Players (wins, rating): both teams play under the same rules, so only handicaps matter
   * Segments (times): the rules change what a time means, so each kind of game has its own
   * Any handicap in the game puts it on the handicapped ones, whatever the other settings
   * @returns {{ players: "standard" | "handicapped", segments: "scriptless" | "scripted" | "single_segment" | "handicapped" }}
   */
  leaderboards() {
    if (this.handicapsUsed) {
      return { players: "handicapped", segments: "handicapped" };
    }
    const segments = this.settings.singleSegment ? "single_segment" : this.ruleset.scripted ? "scripted" : "scriptless";
    return { players: "standard", segments };
  }

  /** @returns {import("../protocol/messages.js").GameOver} */
  gameOverMessage() {
    const e = this.game.ending;
    return {
      type: "game_over",
      winner: e?.winner ?? null,
      reason: e?.reason ?? "host_ended",
      tiebreaker: e?.tiebreaker ?? null,
      line: e?.line ?? null,
    };
  }

  /**
   * Everything for a page that isn't connected: GET /api/games/<id>
   * @param {number} now
   */
  snapshot(now) {
    return {
      id: this.id,
      settings: this.settings,
      tiles: this.tileInfo(),
      leaderboards: this.leaderboards(),
      lobby: this.lobbyMessage(),
      // For the host page's unban buttons
      banned: this.banned,
      board: this.boardFor(null, now),
      game_over: this.state === "finished" ? this.gameOverMessage() : null,
      results: this.game.log.flatMap((e) =>
        e.kind === "result"
          ? [
              {
                attempt_id: e.submission.attemptId,
                steamid64: e.submission.player,
                team: e.submission.team,
                tile: e.submission.tile,
                segment: this.tiles[e.submission.tile].id,
                time_ms: e.submission.timeMs,
                at_ms: e.submission.atMs,
                verdict: e.verdict,
                voided: e.voided,
                review: this.reviews[e.submission.attemptId] ?? null,
              },
            ]
          : [],
      ),
    };
  }
}
