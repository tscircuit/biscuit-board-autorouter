import { expect, test } from "bun:test";
import type { SimpleRouteJson } from "@tscircuit/core";
import { selectDefaultRouteOrder } from "../lib";
import stm32Input from "../repros/fixtures/repro01-biscuit-board-stm32.srj.json";
import rp2040Input from "../repros/fixtures/repro02-biscuit-board-rp2040.srj.json";
import stm32DisplayInput from "../repros/fixtures/repro03-stm32-display-user-led.srj.json";
import stm32DisplayBoosterPackInput from "../repros/fixtures/repro06-stm32-display-boosterpack.srj.json";

test("selects signal-first routing only for the dense RP2040 problem", () => {
  expect(selectDefaultRouteOrder(stm32Input as SimpleRouteJson)).toBe("input");
  expect(selectDefaultRouteOrder(stm32DisplayInput as SimpleRouteJson)).toBe(
    "input",
  );
  expect(
    selectDefaultRouteOrder(stm32DisplayBoosterPackInput as SimpleRouteJson),
  ).toBe("input");
  expect(selectDefaultRouteOrder(rp2040Input as SimpleRouteJson)).toBe(
    "signal_longest_first",
  );
});

test("keeps input order when a dense problem has no signal connections", () => {
  const connections = Array.from({ length: 64 }, (_, index) => ({
    name: `net-${index}`,
    pointsToConnect: [{}, {}],
  })) as SimpleRouteJson["connections"];

  expect(selectDefaultRouteOrder({ connections })).toBe("input");
});
