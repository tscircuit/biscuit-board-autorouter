# Real-project repros

Files in this directory are complete autorouter inputs captured from real
projects. Unlike the intentionally small synthetic inputs under `examples/`,
they must not be reduced or reconstructed.

## Repro 01 · BiscuitBoard STM32C071FBP6

- Source: `tscircuit/biscuit-boards` at
  `5d7d4db9b63bd780168d290cf345b2fbb37b51d3`
- Circuit: `examples/stm32c071.tsx`
- Capture point: the `SimpleRouteJson` passed to `BiscuitBoard`'s
  `autorouter.algorithmFn`
- Input: 9 merged connections, 100 obstacles, 2 layers, and 54 assignable
  prefabricated vias

The checked-in `.srj.json` file is the exact captured value, including source
IDs and connectivity metadata.

## Repro 02 · BiscuitBoard RP2040

- Source: `tscircuit/biscuit-boards` RP2040 example
- Circuit: the complete `RP2040` design from `@tscircuit/common`
- Capture point: the `SimpleRouteJson` passed to `BiscuitBoard`'s
  `autorouter.algorithmFn`
- Input: 35 connections, 215 obstacles, 2 layers, 97 routing demands, and 54
  assignable prefabricated vias

Open `repros/repro02.page.tsx` in Cosmos for the `GenericSolverDebugger`, or
run `./benchmark.sh --case=rp2040` for this headless benchmark case.

## Repro 03 · STM32 display board R_USER_LED traces

- Source: `tscircuit/biscuit-boards` at
  `78dbe6523daadc0d8fc88e4c20cac893ecbe76b7`, with the display-header pin-map
  correction from the source worktree applied
- Circuit: `examples/stm32c071-display.tsx`
- Capture point: the normalized `SimpleRouteJson` passed to `BiscuitBoard`'s
  `autorouter.algorithmFn`
- Input: 17 merged connections, 119 obstacles, 2 layers, and 33 routing demands

The SVG regression test runs the complete routing pipeline, then snapshots the
10 mm square centered on `R_USER_LED`. This makes the requested 5 mm region on
every side of the resistor visible while preserving the currently irregular
trace geometry.

## Repro 04 · STM32 display board BTN1/BTN2 traces

- Source: `tscircuit/biscuit-boards` at
  `78dbe6523daadc0d8fc88e4c20cac893ecbe76b7`, with the display-header pin-map
  correction from the source worktree applied
- Circuit: `examples/stm32c071-display.tsx`
- Capture point: the normalized `SimpleRouteJson` passed to `BiscuitBoard`'s
  `autorouter.algorithmFn`
- Input: 17 merged connections, 119 obstacles, 2 layers, and 33 routing demands

The SVG regression test runs the complete routing pipeline, then snapshots the
combined BTN1/BTN2 center bounds with a 5 mm margin on every side. The crop
keeps both buttons and the irregular traces between them visible.

Repro 04 contains the same complete Simple Route JSON input as Repro 03; only
the visual regression crop differs. The benchmark therefore runs that routing
problem once as `stm32-display` instead of double-counting it.

## Repro 05 · STM32 display redundant GND branch

- Source: `tscircuit/biscuit-boards` at
  `02aa0f8685883f3251572ab422d448b65681f064`
- Autorouter revision used by that source: `199bc1be13f7daa3fb3f8164dd5fb607f69bdf0f`
- Circuit: `examples/stm32c071-display.tsx`
- Capture point: the normalized `SimpleRouteJson` passed to
  `BiscuitBoardAutorouter`
- Input: 17 merged connections, 119 obstacles, 2 layers, and 33 routing
  demands

`C_MCU.pin2` (`pcb_port_199`), `C_NRST.pin2` (`pcb_port_201`), and
`D_PWR.cathode` (`pcb_port_207`) are all on the merged GND connection
`source_net_0`. The prefabricated via at `(12.75, 19.5)` is assigned to the
same net while routing.

The current output creates three relevant branches:

1. `C_MCU` to `C_NRST`;
2. `C_NRST` to `D_PWR`; and
3. `C_MCU` to the prefabricated via.

Branch 3 crosses branch 2 before reaching the via. Copper from `C_MCU` to that
crossing is redundant because `C_MCU` is already connected to `C_NRST` by
branch 1. The via branch should begin at the crossing with the
`C_NRST`–`D_PWR` trace instead of continuing back to `C_MCU` and forming a
same-net loop.

The SVG regression test snapshots the complete local topology from `C_MCU`
through `C_NRST` and `D_PWR` to the via. Its red overlay marks the redundant
portion and its green overlay marks the portion still needed to reach the via.

## Repro 06 · STM32 display BoosterPack

- Source: `tscircuit/biscuit-boards` at
  `8092271c9a6bf7d82f27630eed6e47497b534429`
- Circuit: `examples/stm32c071-display-boosterpack.tsx`
- Capture point: the normalized `SimpleRouteJson` passed to the BoosterPack
  `BiscuitBoard` autorouter
- Input: 15 merged connections, 157 obstacles, 2 layers, 34 routing demands,
  and 51 assignable prefabricated vias

## Repro 07 · RP2040 C_FLASH route underneath U_FLASH

- Source: `tscircuit/biscuit-boards` at
  `c54d58c602344c2b0c3cd739417b7364081bd39c`
- Circuit: `examples/rp2040-photodiode-crystal-buttons.tsx`
- Capture point: the normalized `SimpleRouteJson` passed to the board's
  `autorouter.algorithmFn`
- Input: 28 merged connections, 209 obstacles, 2 layers, and 82 routing
  demands

The GND route between `C_FLASH` and `U_FLASH` crosses the flash chip's body
area. The full routing pipeline completes and its trace-clearance check reports
no violations. The SVG regression test overlays the `U_FLASH` body outline and
snapshots an exact 10 mm square centered on `C_FLASH`, providing 5 mm of
context on every side.

## Headless benchmark suite

`./benchmark.sh` runs Repros 01, 02, 03, and 06. Every case intentionally
omits `routeOrder`, so the effective order comes from the autorouter default.
The suite exits successfully only when every original demand is electrically
connected, all emitted traces route with no manufactured vias, and no
clearance violations remain. A failed or timed-out case does not prevent the
remaining cases from running. Use `--debug` to include conflict and
connectivity state in the JSON report.
