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
