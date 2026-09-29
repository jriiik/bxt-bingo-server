// One Durable Object per game: the sockets, storage and alarms around src/room
//
// Sockets use hibernation: a quiet game sleeps with its sockets open, and wakes up
// with the room rebuilt from storage (the constructor)
// Each socket has a tag, `bxt:<steamid64>` or `web`, and an attachment saying who it is

import { DurableObject } from "cloudflare:workers";

import { CLOSE, PING_TEXT, PONG_TEXT, parseClientMessage } from "../src/protocol/index.js";
import { DEFAULT_FILES_URL, Room, RoomError } from "../src/room/index.js";
import { gameRecord, writeGameRecord } from "./records.js";
import { sha256Hex } from "./secrets.js";

/**
 * @typedef {import("../src/room/room.js").Changes} Changes
 * @typedef {import("../src/protocol/messages.js").ServerMessage} ServerMessage
 * @typedef {{ kind: "bxt", steamid64: string, token: string, hello: boolean, bad: number } | { kind: "web" }} Attachment
 */

// Sockets sending this many bad messages are closed
const MAX_BAD_MESSAGES = 5;

// Log entries per storage write, under the limit of 128 keys
const LOG_BATCH = 100;

/**
 * @param {number} status
 * @param {unknown} body
 */
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export class GameRoom extends DurableObject {
  /** @type {Room | null} */
  room = null;
  /**
   * Session token hash -> steamid64
   * @type {Record<string, string>}
   */
  sessions = {};
  /** Log entries already stored */
  storedLog = 0;
  /** A void changed old log entries, so the whole log is written again */
  rewriteLog = false;
  /** The game's record last written to D1, so changes that don't alter it write nothing */
  recorded = "";
  /** D1 writes, one after another, so an older record never lands after a newer one */
  recording = Promise.resolve();

  /**
   * @param {DurableObjectState} ctx
   * @param {any} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    // Answered without waking the game
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get("room");
      if (!stored) {
        return;
      }
      const entries = await ctx.storage.list({ prefix: "log:" });
      const log = [...entries.values()];
      this.room = Room.restore(/** @type {any} */ (stored), /** @type {any} */ (log));
      this.room.filesUrl = this.#filesUrl();
      this.storedLog = log.length;
      this.sessions = (await ctx.storage.get("sessions")) ?? {};
      // Sockets that closed while the object was gone never told us
      for (const player of Object.values(this.room.players)) {
        player.connected = ctx.getWebSockets(`bxt:${player.steamid64}`).length > 0;
      }
    });
  }

  /** The FILES_URL variable, e.g. `https://assets.jrik.dev/bingo/files/` in production */
  #filesUrl() {
    return /** @type {{ FILES_URL?: string }} */ (this.env).FILES_URL || DEFAULT_FILES_URL;
  }

  // RPC from the Worker

  /**
   * Sets the game up. Called once, when it's created
   * @param {ConstructorParameters<typeof Room>[0]} init
   */
  async create(init) {
    if (this.room) {
      return { error: "bad_state", message: "the game already exists" };
    }
    try {
      this.room = new Room(init);
      this.room.filesUrl = this.#filesUrl();
    } catch (e) {
      return this.#refusal(e);
    }
    await this.#save(true);
    return { ok: true };
  }

  /**
   * A host action or a player joining, already allowed by the Worker
   * `add_player`, `move`, `handicaps`, `kick`, `unban`, `lock`, `start`, `end`, `void`, `accept`
   * @param {string} name
   * @param {any} args
   */
  async action(name, args) {
    const room = this.room;
    if (!room) {
      return { error: "not_found", message: "no such game" };
    }
    const now = Date.now();
    /** @type {Record<string, () => Changes>} */
    const actions = {
      add_player: () => room.addPlayer(args),
      move: () => room.movePlayer(args.steamid64, args.team, now),
      handicaps: () => room.setHandicaps(args.steamid64, args.handicaps),
      kick: () => room.kick(args.steamid64, Boolean(args.ban)),
      unban: () => room.unban(args.steamid64),
      lock: () => room.lock(Boolean(args.locked)),
      start: () => room.start(now, Boolean(args.force)),
      end: () => room.end(now),
      void: () => {
        const changes = room.void(args.attempt_id, now);
        this.rewriteLog = true;
        return changes;
      },
      accept: () => room.accept(args.attempt_id),
    };
    const run = Object.hasOwn(actions, name) ? actions[name] : undefined;
    if (!run) {
      return { error: "bad_request", message: `unknown action ${name}` };
    }
    try {
      await this.#apply(run(), now);
    } catch (e) {
      return this.#refusal(e);
    }
    return { ok: true };
  }

  /** @param {number} now */
  snapshot(now = Date.now()) {
    return this.room ? this.room.snapshot(now) : null;
  }

  /** @param {unknown} e */
  #refusal(e) {
    if (e instanceof RoomError) {
      return { error: e.code, message: e.message };
    }
    if (e instanceof RangeError || e instanceof TypeError) {
      return { error: "bad_request", message: e.message };
    }
    throw e;
  }

  // Sockets

  /**
   * WebSocket upgrades, handed over by the Worker
   * `/bxt` with `X-Bingo-Player` (a redeemed join code) and `X-Bingo-Token` (the new session),
   * or with only `X-Bingo-Token` (a reconnect). `/web` for pages and spectators
   * @param {Request} request
   */
  async fetch(request) {
    const room = this.room;
    if (!room) {
      return json(404, { error: "not_found" });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const path = new URL(request.url).pathname;

    if (path === "/web") {
      this.ctx.acceptWebSocket(server, ["web"]);
      server.serializeAttachment(/** @type {Attachment} */ ({ kind: "web" }));
      const now = Date.now();
      server.send(JSON.stringify(room.lobbyMessage()));
      server.send(JSON.stringify(room.boardFor(null, now)));
      if (room.state === "finished") {
        server.send(JSON.stringify(room.gameOverMessage()));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    const token = request.headers.get("X-Bingo-Token") ?? "";
    const tokenHash = await sha256Hex(token);
    let steamid64 = request.headers.get("X-Bingo-Player");
    if (steamid64) {
      // A new join: the code was checked by the Worker
      if (!room.players[steamid64]) {
        return json(403, { error: "bad_code" });
      }
      if (room.state === "finished") {
        return json(403, { error: "game_over" });
      }
      this.sessions[tokenHash] = steamid64;
      await this.ctx.storage.put("sessions", this.sessions);
    } else {
      steamid64 = this.sessions[tokenHash] ?? null;
      if (!steamid64 || !room.players[steamid64]) {
        return json(403, { error: room.banned.includes(steamid64 ?? "") ? "banned" : "bad_session" });
      }
    }

    // One BXT socket per player
    for (const old of this.ctx.getWebSockets(`bxt:${steamid64}`)) {
      old.close(CLOSE.REPLACED, "connected again elsewhere");
    }
    this.ctx.acceptWebSocket(server, [`bxt:${steamid64}`]);
    server.serializeAttachment(/** @type {Attachment} */ ({ kind: "bxt", steamid64, token, hello: false, bad: 0 }));
    await this.#apply(room.setConnected(steamid64, true), Date.now());
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * @param {WebSocket} ws
   * @param {string | ArrayBuffer} data
   */
  async webSocketMessage(ws, data) {
    const room = this.room;
    /** @type {Attachment} */
    const who = ws.deserializeAttachment();
    if (!room || who.kind !== "bxt") {
      // Pages only listen, their actions go through the Worker's routes
      return;
    }
    const now = Date.now();
    const parsed = parseClientMessage(typeof data === "string" ? data : "");

    if (!parsed.ok || (!who.hello && parsed.message.type !== "hello")) {
      who.bad++;
      ws.serializeAttachment(who);
      const detail = parsed.ok ? "hello first" : parsed.detail;
      ws.send(JSON.stringify({ type: "error", code: "bad_message", detail }));
      if (who.bad >= MAX_BAD_MESSAGES) {
        ws.close(1008, "too many bad messages");
      }
      return;
    }

    try {
      if (parsed.message.type === "hello" && !who.hello) {
        const result = room.hello(who.steamid64, parsed.message, who.token, now);
        if ("error" in result) {
          ws.send(JSON.stringify({ type: "error", code: result.error, detail: result.detail }));
          ws.close(1008, result.error);
          return;
        }
        who.hello = true;
        ws.serializeAttachment(who);
        await this.#apply(result.changes, now);
      } else {
        await this.#apply(room.onMessage(who.steamid64, parsed.message, now), now);
      }
    } catch (e) {
      if (e instanceof RoomError && e.code === "unknown_player") {
        ws.close(CLOSE.KICKED, "not in this game");
        return;
      }
      throw e;
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {number} code
   */
  async webSocketClose(ws, code) {
    try {
      // Completes the closing handshake
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed
    }
    /** @type {Attachment} */
    const who = ws.deserializeAttachment();
    if (!this.room || who.kind !== "bxt") {
      return;
    }
    // A replaced socket closes after the new one is in, so only the last one counts
    const others = this.ctx.getWebSockets(`bxt:${who.steamid64}`).filter((s) => s !== ws && s.readyState === WebSocket.OPEN);
    if (others.length === 0) {
      await this.#apply(this.room.setConnected(who.steamid64, false), Date.now());
    }
  }

  /** @param {WebSocket} ws */
  async webSocketError(ws) {
    await this.webSocketClose(ws, 1006);
  }

  async alarm() {
    if (this.room) {
      await this.#apply(this.room.tick(Date.now()), Date.now());
    }
  }

  // Sending and storing

  /**
   * Sends and stores what the room says changed
   * @param {Changes} changes
   * @param {number} now
   */
  async #apply(changes, now) {
    const room = /** @type {Room} */ (this.room);
    if (changes.save) {
      await this.#save(false);
    }

    /** @type {{ ws: WebSocket, steamid64: string | null }[]} */
    const listeners = [];
    for (const ws of this.ctx.getWebSockets()) {
      /** @type {Attachment} */
      const who = ws.deserializeAttachment();
      if (who.kind === "web") {
        listeners.push({ ws, steamid64: null });
      } else if (who.hello && room.players[who.steamid64]) {
        listeners.push({ ws, steamid64: who.steamid64 });
      }
    }
    /**
     * @param {WebSocket} ws
     * @param {ServerMessage} message
     */
    const send = (ws, message) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // Closing already
      }
    };
    /** @param {ServerMessage} message */
    const everyone = (message) => listeners.forEach((l) => send(l.ws, message));

    for (const { steamid64, message } of changes.send) {
      this.ctx.getWebSockets(`bxt:${steamid64}`).forEach((ws) => send(ws, message));
    }
    if (changes.lobby) {
      everyone(room.lobbyMessage());
    }
    for (const steamid64 of changes.manifests) {
      if (room.players[steamid64]?.engineBuild) {
        const manifest = room.manifestFor(steamid64);
        listeners.filter((l) => l.steamid64 === steamid64).forEach((l) => send(l.ws, manifest));
      }
    }
    if (changes.roundStart) {
      everyone(room.roundStartMessage(now));
    }
    if (changes.board) {
      listeners.forEach((l) => send(l.ws, room.boardFor(l.steamid64, now)));
    }
    for (const text of changes.events) {
      everyone({ type: "event", text });
    }
    if (changes.gameOver && room.state === "finished") {
      everyone(room.gameOverMessage());
    }
    for (const { steamid64, code, reason } of changes.close) {
      this.ctx.getWebSockets(`bxt:${steamid64}`).forEach((ws) => ws.close(code, reason));
    }

    if (changes.alarm) {
      const at = room.nextAlarm();
      if (at === null) {
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(at);
      }
    }
    await this.#record(now);
  }

  /**
   * Keeps the game's row, its players and, once it's finished, its results up to date in D1
   * (records.js), for the players' game lists and the leaderboards. Writes only when the record
   * changed since the last write, unless forced. A failed write is tried again at the next
   * change; nothing here ever stops the game
   * @param {number} now
   * @param {boolean} [force]
   * @returns {Promise<boolean>} Whether it wrote
   */
  async #record(now, force = false) {
    const db = /** @type {{ DB?: D1Database }} */ (this.env).DB;
    if (!db || !this.room) {
      return false;
    }
    let wrote = false;
    try {
      const record = gameRecord(this.room, now);
      const key = JSON.stringify(record);
      if (key === this.recorded && !force) {
        return false;
      }
      this.recorded = key;
      this.recording = this.recording.then(async () => {
        try {
          await writeGameRecord(db, record);
          wrote = true;
        } catch (e) {
          if (this.recorded === key) {
            this.recorded = "";
          }
          console.error("the game's record wasn't written to D1", e);
        }
      });
      await this.recording;
    } catch (e) {
      console.error("the game's record couldn't be made", e);
    }
    return wrote;
  }

  /**
   * The Worker's game lists call this for a game D1 has as not finished: a game whose last change
   * came before records existed, or whose write failed, is written again. When D1's state isn't
   * the game's, the record is written whatever was written last
   * @param {string} stateInD1
   * @returns {Promise<boolean>} Whether it wrote
   */
  async refreshRecord(stateInD1) {
    return this.#record(Date.now(), this.room !== null && this.room.state !== stateInD1);
  }

  /**
   * Stores the room, and the log entries that are new
   * @param {boolean} all Write the whole log
   */
  async #save(all) {
    const room = /** @type {Room} */ (this.room);
    const log = room.game.log;
    const from = all || this.rewriteLog ? 0 : this.storedLog;
    this.rewriteLog = false;
    await this.ctx.storage.put("room", JSON.parse(JSON.stringify(room)));
    for (let i = from; i < log.length; i += LOG_BATCH) {
      /** @type {Record<string, unknown>} */
      const batch = {};
      log.slice(i, i + LOG_BATCH).forEach((entry, j) => {
        batch[`log:${String(i + j).padStart(8, "0")}`] = entry;
      });
      await this.ctx.storage.put(batch);
    }
    this.storedLog = log.length;
  }
}
