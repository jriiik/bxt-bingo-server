import assert from "node:assert/strict";
import { test } from "node:test";

import { compareIds, parseCfg } from "../tools/catalog/kit.js";

/**
 * A kit cfg with these triggers and load
 * @param {string[]} lines
 */
const cfg = (lines) => ["//Load a placeholder map to draw triggers", "map c1a0", "bxt_triggers_clear", ...lines, "bxt_hud_timer 1", "w 5"].join("\r\n");

/**
 * The segment, or a failed test with why the cfg was skipped
 * @param {ReturnType<typeof parseCfg>} result
 */
function used(result) {
  if ("skip" in result) {
    throw new Error(result.skip);
  }
  return result;
}

const START = ["bxt_triggers_add 1 2 3 4 5 6", 'bxt_triggers_setcommand "bxt_timer_reset;bxt_timer_start"'];
const END = ["bxt_triggers_add -1.5 -2 -3 7 8 9.25", 'bxt_triggers_setcommand "bxt_timer_stop"'];

test("a whole segment and its halves", () => {
  const whole = parseCfg("oar-2-0", cfg([...START, ...END, "load oar2start"]));
  assert.deepEqual(whole, {
    segment: {
      id: "oar-2-0",
      label: "OAR2",
      chapter: "On A Rail",
      save: "oar2start",
      start: { type: "trigger", corners: [[1, 2, 3], [4, 5, 6]] },
      end: { corners: [[-1.5, -2, -3], [7, 8, 9.25]] },
    },
    notes: [],
  });
  const half = used(parseCfg("oar-2-2", cfg([...START, ...END, "load oar2half"])));
  assert.equal(half.segment.label, "OAR2.2");
  assert.equal(half.segment.save, "oar2half");
});

test("the end trigger listed first, and a start that deletes triggers", () => {
  const result = used(parseCfg("oar-9-0", cfg([...END, "bxt_triggers_add 1 2 3 4 5 6", 'bxt_triggers_setcommand "bxt_timer_reset;bxt_timer_start;bxt_triggers_delete"', "load oar9start"])));
  assert.deepEqual(result.segment.start, { type: "trigger", corners: [[1, 2, 3], [4, 5, 6]] });
  assert.deepEqual(result.segment.end, { corners: [[-1.5, -2, -3], [7, 8, 9.25]] });
});

test("the timer started by the cfg, Nihilanth, and cfgs that aren't segments", () => {
  const onLoad = used(parseCfg("am-5-2", cfg([...END, "load am5half", "bxt_timer_reset", "w 6", "bxt_timer_start"])));
  assert.deepEqual(onLoad.segment.start, { type: "on_load" });

  const nihi = used(parseCfg("nihi-1-0", cfg([...START, "//bxt_triggers_add ", '//bxt_triggers_setcommand "bxt_timer_stop"', "load nihi1start"])));
  assert.deepEqual(nihi.segment.end, { type: "game_end" });

  assert.deepEqual(parseCfg("am-1-0", cfg([...END, "bxt_timer_start"])), { skip: "loads no save (it starts from the map itself)" });
  assert.deepEqual(parseCfg("buffer", "load practiceBuffer"), { skip: "not a segment" });
  assert.deepEqual(parseCfg("st-1-0", cfg([...START, "load st1start"])), { skip: "nothing stops the timer" });
});

test("triggers without a command are left out with a note", () => {
  const result = used(parseCfg("wgh-1-1", cfg([...START, ...END, "bxt_triggers_add 1 1 1 2 2 2", "load wgh1start"])));
  assert.deepEqual(result.notes, ["1 trigger(s) without a timer command, left out"]);
});

test("the kit's order", () => {
  const ids = ["uc-1-0", "am-10-0", "am-2-1", "am-2-0", "nihi-1-0"];
  assert.deepEqual(ids.sort(compareIds), ["am-2-0", "am-2-1", "am-10-0", "uc-1-0", "nihi-1-0"]);
});
