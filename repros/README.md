# Real-project repros

Files in this directory are complete autorouter inputs captured from real
projects. Unlike the intentionally small synthetic inputs under `examples/`,
they must not be reduced or reconstructed.

## Repro 01 · BiscuitBoard STM32C071FBP6

- Source: `tscircuit/biscuit-boards` at
  `5818f983a591eb6905e7021bc440d6f33aabc55c`
- Circuit: `examples/stm32c071.tsx`
- Capture point: the `SimpleRouteJson` passed to `BiscuitBoard`'s
  `autorouter.algorithmFn`
- Input: 9 merged connections, 97 obstacles, 2 layers, and 51 assignable
  prefabricated vias

The checked-in `.srj.json` file is the exact captured value, including source
IDs and connectivity metadata.
