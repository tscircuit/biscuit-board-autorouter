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
run `./benchmark.sh` for the headless regression benchmark. The benchmark
exits successfully only when every original demand is electrically connected,
all emitted traces route with no manufactured vias, and no clearance
violations remain. It currently exits nonzero because negotiated routing still
cycles on this dense board; use `--debug` to include its conflict and
connectivity state in the JSON report.

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
