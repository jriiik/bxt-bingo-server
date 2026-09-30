// Reads the Half-Life Practice Kit's segment cfgs (PracticeCfgs/*.cfg)
//
// A cfg loads a save and adds BXT triggers, e.g. oar-2-0.cfg:
//   bxt_triggers_add <6 numbers>  +  bxt_triggers_setcommand "bxt_timer_reset;bxt_timer_start"
//   bxt_triggers_add <6 numbers>  +  bxt_triggers_setcommand "bxt_timer_stop"
//   load oar2start
// The name says which: <chapter>-<map>-<section>. Section 0 is the whole segment, 1 its first half
// (from the start save) and 2 its second half (from the half save)

/**
 * The kit's chapters, in the game's order. The prefix is the start of the cfg names
 * @type {{ prefix: string, name: string }[]}
 */
export const CHAPTERS = [
  { prefix: "am", name: "Anomalous Materials" },
  { prefix: "uc", name: "Unforeseen Consequences" },
  { prefix: "oc", name: "Office Complex" },
  { prefix: "wgh", name: "We've Got Hostiles" },
  { prefix: "bp", name: "Blast Pit" },
  { prefix: "pu", name: "Power Up" },
  { prefix: "oar", name: "On A Rail" },
  { prefix: "app", name: "Apprehension" },
  { prefix: "rp", name: "Residue Processing" },
  { prefix: "qe", name: "Questionable Ethics" },
  { prefix: "st", name: "Surface Tension" },
  { prefix: "faf", name: "Forget About Freeman!" },
  { prefix: "lc", name: "Lambda Core" },
  { prefix: "xen", name: "Xen" },
  { prefix: "gon", name: "Gonarch's Lair" },
  { prefix: "int", name: "Interloper" },
  { prefix: "nihi", name: "Nihilanth" },
];

/**
 * What a cfg says, before its save is hashed
 * @typedef {object} KitSegment
 * @property {string} id The cfg's name, e.g. `oar-2-1`
 * @property {string} label e.g. `OAR2` for a whole segment, `OAR2.1` and `OAR2.2` for its halves
 * @property {string} chapter
 * @property {string} save The save it loads, without `.sav`
 * @property {import("../../src/protocol/segment.js").StartCondition} start
 * @property {import("../../src/protocol/segment.js").EndCondition} end
 */

/** @typedef {[[number, number, number], [number, number, number]]} Corners */

/**
 * The words of a cfg line, with quotes removed and a `//` comment cut off
 * @param {string} line
 */
function words(line) {
  const out = [];
  const re = /"([^"]*)"?|(\S+)/g;
  const text = line.replace(/\/\/.*$/, "");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push(m[1] ?? m[2]);
  }
  return out;
}

/**
 * The segment a cfg sets up, or why it isn't one bingo can use
 * @param {string} name The cfg's file name without `.cfg`
 * @param {string} text
 * @returns {{ segment: KitSegment, notes: string[] } | { skip: string }}
 */
export function parseCfg(name, text) {
  const match = /^([a-z]+)-(\d+)-(\d+)$/.exec(name);
  const chapter = match && CHAPTERS.find((c) => c.prefix === match[1]);
  if (!match || !chapter) {
    return { skip: "not a segment" };
  }

  /** @type {{ corners: Corners, command: string | null }[]} */
  const triggers = [];
  /** @type {string | null} */
  let save = null;
  // The timer started by the cfg itself, after the load
  let startedByCfg = false;
  /** @type {string[]} */
  const notes = [];

  for (const line of text.split(/\r?\n/)) {
    const [command, ...args] = words(line.trim());
    if (command === "bxt_triggers_add") {
      const numbers = args.map(Number);
      if (numbers.length !== 6 || numbers.some((n) => !Number.isFinite(n))) {
        return { skip: `a trigger without 6 numbers: ${line.trim()}` };
      }
      const [x1, y1, z1, x2, y2, z2] = numbers;
      triggers.push({ corners: [[x1, y1, z1], [x2, y2, z2]], command: null });
    } else if (command === "bxt_triggers_setcommand") {
      if (triggers.length === 0) {
        return { skip: "a trigger command before any trigger" };
      }
      triggers[triggers.length - 1].command = args.join(" ");
    } else if (command === "load") {
      save = args[0] ?? null;
    } else if (command === "bxt_timer_start") {
      startedByCfg = true;
    }
  }

  const has = (/** @type {string} */ cmd, /** @type {string | null} */ commands) =>
    (commands ?? "").split(";").some((c) => c.trim() === cmd);
  const starts = triggers.filter((t) => has("bxt_timer_start", t.command));
  const ends = triggers.filter((t) => has("bxt_timer_stop", t.command));
  const unused = triggers.length - starts.length - ends.length;
  if (unused > 0) {
    notes.push(`${unused} trigger(s) without a timer command, left out`);
  }

  if (!save) {
    return { skip: "loads no save (it starts from the map itself)" };
  }
  if (starts.length > 1 || ends.length > 1) {
    return { skip: `${starts.length} start and ${ends.length} end triggers` };
  }

  /** @type {KitSegment["start"]} */
  let start;
  if (starts.length === 1) {
    start = { type: "trigger", corners: starts[0].corners };
  } else if (startedByCfg) {
    // The cfg starts the timer right after loading
    start = { type: "on_load" };
  } else {
    return { skip: "nothing starts the timer" };
  }

  /** @type {KitSegment["end"]} */
  let end;
  if (ends.length === 1) {
    end = { corners: ends[0].corners };
  } else if (chapter.prefix === "nihi") {
    // BXT's timer stops by itself when Nihilanth dies
    end = { type: "game_end" };
  } else {
    return { skip: "nothing stops the timer" };
  }

  const [, , map, section] = match;
  const label = chapter.prefix.toUpperCase() + map + (section === "0" ? "" : `.${section}`);
  return { segment: { id: name, label, chapter: chapter.name, save, start, end }, notes };
}

/**
 * The kit's order: chapters as in the game, then map and section numbers
 * @param {string} a
 * @param {string} b
 */
export function compareIds(a, b) {
  const key = (/** @type {string} */ id) => {
    const [prefix, map, section] = id.split("-");
    return [CHAPTERS.findIndex((c) => c.prefix === prefix), Number(map), Number(section)];
  };
  const [x, y] = [key(a), key(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}
