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
4. `PostProcessBiscuitBoardTracesSolver` enforces the configured copper clearance and
   greedily replaces whole stair-step runs with clearance-safe Manhattan/45°
   shortcuts. Its visualization overlays the original routes, obstacle/pad
   geometry, clearance envelopes, prefabricated vias, and simplified traces.
5. `BeautifyBiscuitBoardTracesSolver` opportunistically increases the spacing
   between foreign nets, pulls unobstructed parallel same-net spans onto shared
   copper, and replaces each remaining Manhattan corner with the largest
   clearance-safe 45° chamfer.
6. `PruneRedundantSameNetCopperSolver` planarizes same-net intersections and
   removes cycles while retaining an existing-copper path between every routed
   trace attachment and every required prefabricated via transition.
7. `ExpandBiscuitBoardTracesSolver` uses
   `@tscircuit/power-trace-expander` to widen the cleaned routes toward each
   connection's `nominalTraceWidth`. It may shove narrower traces or detour
   around obstacles, but disables new vias, revalidates clearance and the
   fixed-via invariant, and removes redundant collinear probe points.

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
bun run perf:ladder
./benchmark.sh --debug
```

`perf:ladder` runs six isolated cases from a tiny route through the RP2040
stress board. It reports wall time, process CPU time, stage timings, peak heap
and RSS, external and ArrayBuffer memory, cache hit rates, graph subphase work,
route count, manufactured-via count, and final clearance violations. Use
`--case=stm32 --runs=3` to isolate a rung or `--max-ms=90000` to give the stress
case a longer budget. `--low-memory` measures result-only stage retention.
`--compare=/path/to/previous/lib/index.ts` alternates previous and current
workers on every repetition to reduce host-load drift in A/B measurements.

Direct `BiscuitBoardRoutingPipelineSolver` instances retain completed stages
for debugger visualization by default. Set `retainIntermediateStages: false`
for a result-only pipeline. `BiscuitBoardAutorouter` uses this low-memory mode
unless explicitly overridden.

Cosmos exposes the generated hypergraph and every live pipeline stage through
`GenericSolverDebugger`:

- `examples/exampleXX.page.tsx` contains small synthetic inputs that isolate
  one solver behavior.
- `repros/reproXX.page.tsx` contains exact, checked-in autorouter inputs
  captured from real projects. `benchmark.sh` runs the four unique complete
  board problems: STM32C071FBP6, RP2040, the STM32 display board, and the STM32
  display BoosterPack.

The benchmark cases deliberately omit `routeOrder`. This makes the suite
measure the autorouter's default selection while retaining each board's other
problem-specific tuning. Run `./benchmark.sh --list` to see case IDs or
`./benchmark.sh --case=stm32` to isolate one case. Each case has a default
three-minute timeout so dense inputs such as RP2040 can make meaningful
progress without blocking the suite indefinitely.

The default route order is adaptive. Before each search, the router reprioritizes
pending demands from endpoint constraints, current occupancy, congestion
history, and net topology. Negotiated reroutes retain their conflict-derived
queue order. The router does not infer behavior from connection or route names.
Supplying `routeOrder` still provides a backwards-compatible static ordering
override.

Tests include SVG matching, forced layer transitions, the
no-prefabricated-via failure case, negotiated rip-and-replace, and the complete
STM32 real-project repro.
