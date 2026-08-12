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
