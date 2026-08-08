# biscuit-board-autorouter

A fixed-via autorouter for prefabricated tscircuit biscuit boards.

**[Open the live Cosmos solver debugger](https://biscuit-board-autorouter.vercel.app)**

The solver is deliberately unable to create arbitrary vias. It generates
cross-layer hyperedges only for multi-layer Simple Route JSON obstacles marked
`netIsAssignable: true`; the output stage independently rejects any via that
does not match one of those obstacle coordinates and layer pairs.

## Usage

```tsx
import { createBiscuitBoardAutorouter } from "@tscircuit/biscuit-board-autorouter"

<board
  width="75mm"
  height="55mm"
  autorouter={createBiscuitBoardAutorouter()}
>
  {/* components and traces */}
</board>
```

The exported `BiscuitBoardAutorouter` also implements tscircuit's
`GenericLocalAutorouter` interface for direct use and testing.

## Pipeline

1. `GenerateBiscuitBoardHypergraphSolver` builds a sparse rectilinear routing
   hypergraph from terminals, expanded obstacle boundaries, board bounds, and
   prefabricated via coordinates. Trace-edge conflicts are computed once and
   stored as compact incidence lists.
2. `RipUpRubberBandSolver` performs A* routing with distinct blocker state,
   negotiated rip-and-replace, and history costs.
3. `BuildBiscuitBoardTracesSolver` removes redundant collinear vertices,
   creates tscircuit traces, and validates the fixed-via invariant again.
4. `PostProcessBiscuitBoardTracesSolver` enforces 0.2 mm copper clearance and
   greedily replaces whole stair-step runs with clearance-safe Manhattan/45°
   shortcuts. Its visualization overlays the original routes, obstacle/pad
   geometry, clearance envelopes, prefabricated vias, and simplified traces.

This split is intentional: graph generation is independently visualizable and
testable because it is the highest-risk part of the solver. See
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Development

```sh
bun install
bun run dev
bun run build
bun run test
bun run format:check
```

Cosmos exposes the generated hypergraph and every live pipeline stage through
`GenericSolverDebugger`:

- `examples/exampleXX.page.tsx` contains small synthetic inputs that isolate
  one solver behavior.
- `repros/reproXX.page.tsx` contains exact, checked-in autorouter inputs
  captured from real projects. Repro 01 is the complete BiscuitBoard
  STM32C071FBP6 routing problem.

Tests include SVG matching, forced layer transitions, the
no-prefabricated-via failure case, negotiated rip-and-replace, and the complete
STM32 real-project repro.
