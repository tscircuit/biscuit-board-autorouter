# Biscuit-board autorouter performance findings v4

Date: 2026-08-20

## Executive summary

This speed-first pass reduces mean end-to-end runtime on every meaningful
ladder rung while also reducing mean peak heap and RSS. The final comparison is
against commit `9d8e91fd046925dabfecfbba55acf2e8a0b94374`, the v3 packed-conflict
checkpoint committed before this work.

The largest gains come from doing less routing work, not from adding threads:

- adaptive weighted A* cuts expanded states by 50.0% on ladder 3, 45.9% on
  ladder 4, and 25.9% on ladder 5;
- a medium-board negotiation policy cuts rips from 195 to 119 on ladder 4 and
  from 245 to 207 on ladder 5;
- numeric internal route ownership removes string IDs from occupancy and
  blocker handling;
- repeated owned-node and protected-corridor copies are replaced by persistent
  or demand-scoped caches; and
- the solver quantum rises from 300 to 3,000 expansions, reducing pipeline
  bookkeeping without increasing retained route state.

Large topologies remain on exact A*. Every tested weighted setting made the
RP2040 case substantially worse or fail its runtime guard. With that fallback,
RP2040 performs exactly the same 26,510,022 expansions, 1,535 rips, and 81
negotiation passes as v3, but packed ownership reduces its balanced four-run
mean by 1.2% and peak heap by 3.5%.

| Ladder | Prev mean | Now mean | Runtime | Prev heap | Now heap | Heap | Prev RSS | Now RSS | RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 8 ms | 8 ms | 0.0% | 1.2 MiB | 1.2 MiB | 0.0% | 67.0 MiB | 66.6 MiB | -0.7% |
| 2 | 13 ms | 13 ms | 0.0% | 1.2 MiB | 1.2 MiB | 0.0% | 74.4 MiB | 74.3 MiB | -0.1% |
| 3 | 353 ms | 309 ms | -12.5% | 56.6 MiB | 51.8 MiB | -8.3% | 314.1 MiB | 303.4 MiB | -3.4% |
| 4 | 2,646 ms | 1,790 ms | -32.4% | 201.1 MiB | 168.0 MiB | -16.5% | 635.4 MiB | 590.3 MiB | -7.1% |
| 5 | 3,131 ms | 2,347 ms | -25.0% | 226.3 MiB | 199.9 MiB | -11.7% | 694.1 MiB | 676.3 MiB | -2.6% |
| 6 | 38,317 ms | 37,842 ms | -1.2% | 707.2 MiB | 682.6 MiB | -3.5% | 1,799.8 MiB | 1,769.8 MiB | -1.7% |

Ladders 1 and 2 are startup dominated. Their equal millisecond means should be
read as “no measurable change.”

## Measurement protocol

- **Prev:** detached worktree at `9d8e91f`, using the same dependencies.
- **Now:** the final v4 working tree.
- Runtime: Bun 1.3.14 on the same machine and power state.
- Every sample runs in a fresh child process.
- Ladders 1–5 use five samples per implementation.
- Ladder 6 uses four samples per implementation and a 120,000 ms per-process
  guard.
- Prev/now order alternates. The fourth RP2040 pair is intentionally reversed,
  so each implementation runs first twice and second twice.
- Memory is sampled every 50 ms and once after completion.
- Means include every sample; no outliers were removed.

Each passing sample must satisfy all of these validity gates:

1. the pipeline reports solved and not failed;
2. output trace count equals prepared demand count;
3. no synthetic via is manufactured;
4. no final trace-clearance violation is found; and
5. no route point lies outside board bounds.

Output topology is not required to match v3. Three SVG snapshots were updated
for intentional valid route changes. The explicit `routeOrder: "input"`
redundant-GND regression keeps exact A* and continues to assert that the
redundant branch is absent.

## Fix plan and implementation order

The order was chosen to reduce search work before spending effort on
parallelizing expensive work.

1. **Instrument search and stage memory.** Added search/failure counts,
   maximum heuristic weight, stage-attributed heap/RSS, and output-bound checks.
2. **Reduce A* work.** Added adaptive weighted A* with conservative topology
   gates and exact fallbacks.
3. **Reduce negotiation amplification.** Tuned the immediate-rip window on
   medium boards, then rejected aggressive history and static route-order
   alternatives that harmed validity or stress runtime.
4. **Reduce per-state representation cost.** Replaced string ownership in hot
   maps and blocker arrays with numeric route IDs and typed metadata.
5. **Remove repeated copying and recomputation.** Persisted owned-node sets,
   cached demand-invariant protected corridors, and increased step quantum.
6. **Evaluate heuristic-field retention.** Implemented and measured bounded
   target-topology caches, then removed them because memory and runtime did not
   improve together.
7. **Evaluate parallel seams.** Kept the existing standard worker-thread graph
   collector opt-in; rejected speculative demand workers for the synchronous
   single-board path because shared negotiation state and merge repair erase
   the likely gain.
8. **Run the repeated ladder and low-memory lane.** Froze the algorithm only
   after the final balanced stress comparison passed runtime and memory gates.

## Implemented changes

### 1. Adaptive weighted A*

Two public options are added:

- `heuristicWeight`, default `1.25`;
- `maxHeuristicWeight`, default `1.5`.

Adaptive routing starts at the base weight and may add `0.05` per negotiation
pass, capped by the maximum. This intentionally trades shortest-path
optimality for fewer expansions; final geometric and electrical validity still
goes through the normal pipeline checks.

Two exact fallbacks are mandatory:

- explicit non-adaptive route orders use weight `1.0`; and
- boards with at least 64 demands use weight `1.0`.

The first preserves deterministic-order contracts. The second is empirical:
even a mild RP2040 weight of `1.05` expanded roughly 69 million states and hit
the runtime guard; the initial adaptive policy exceeded 114 million states and
600 passes before timeout.

### 2. Negotiation policy

The immediate-rip budget was previously two times demand count on every board.
For boards with 20–63 demands it is now one times demand count. Tiny and large
boards retain the previous multiplier of two.

This topology gate matters. Multiplier one lowers medium-board rerouting, but
made RP2040 exceed 120 million states in the experiment. A global policy would
therefore be both slower and less reliable.

### 3. Numeric internal ownership

Public route and net IDs remain strings. Internally, the routing solver now
assigns lexically ordered numeric route indexes and uses them in:

- edge-owner and node-owner sets;
- conflict occupancy maps;
- blocker arrays and sorted blocker merging;
- rip-count typed arrays; and
- route-indexed net and width typed arrays.

Conversion back to strings occurs only at diagnostics, dependency, and final
route boundaries. The lossy blocker state hashes packed route indexes directly;
it no longer walks every character of every blocker ID in the A* loop.

### 4. Copy and retention fixes

- `ownedNodesByNet` is maintained with ownership counts, replacing a fresh
  `new Set(map.keys())` on every priority and search query.
- Protected corridors are immutable per demand and are cached in a `WeakMap`,
  replacing repeated `demands.flatMap(...)` scans and temporary arrays after
  every rip/retry.
- A routing step now performs 3,000 expansions instead of 300. This reduces
  stage dispatch, progress, and stats bookkeeping while leaving the active A*
  node/open structures unchanged.
- Benchmark output traversal uses loops rather than `flatMap` intermediates.

The v1–v3 work had already removed the high-impact spread copies in graph and
route hot paths. Remaining spreads in output construction, visualization, and
small setup collections are not responsible for the measured routing cost.

### 5. Non-perturbing instrumentation

An intermediate build counted every heap pop and every stale pop. RP2040 has
about 28.2 million heap pops; the diagnostic increments caused a measured
10.6% runtime regression even though expanded states were unchanged. Those
counters were removed before final measurement.

This is an important profiling result: counters inside this loop must be
sampled, compile-time gated, or collected in a dedicated profiling build. The
production benchmark cannot pay one mutable property update per heap pop.

## Ladder results

### Ladder 1 — tiny unobstructed route

- Prev: 8 ms mean; raw `[8, 8, 8, 8, 8]`.
- Now: 8 ms mean; raw `[8, 8, 8, 8, 8]`.
- Work: 7 states, 0 rips, 0 negotiation passes on both sides.
- Memory: 1.2 MiB heap / 67.0 MiB RSS to 1.2 MiB / 66.6 MiB.

### Ladder 2 — fixed prefabricated-via route

- Prev: 13 ms mean; raw `[13, 14, 13, 13, 14]`.
- Now: 13 ms mean; raw `[13, 14, 13, 14, 13]`.
- States: 277 to 206; both use exactly one fixed-via transition.
- Memory: 1.2 MiB heap / 74.4 MiB RSS to 1.2 MiB / 74.3 MiB.

### Ladder 3 — BiscuitBoard STM32C071FBP6

- Prev: 353 ms mean, 3 ms standard deviation, 635 ms process CPU.
- Now: 309 ms mean, 3 ms standard deviation, 598 ms process CPU.
- Runtime: **12.5% lower**; process CPU: 5.8% lower.
- Raw: prev `[354, 350, 349, 357, 357]`; now
  `[305, 308, 312, 308, 312]` ms.
- States: 152,996 to 76,486 (-50.0%).
- Rips: 29 to 24; negotiation passes remain 0.
- Heap: 56.6 to 51.8 MiB (-8.3%); RSS: 314.1 to 303.4 MiB (-3.4%).

### Ladder 4 — STM32C071 display board

- Prev: 2,646 ms mean, 11 ms standard deviation, 3,354 ms process CPU.
- Now: 1,790 ms mean, 12 ms standard deviation, 2,502 ms process CPU.
- Runtime: **32.4% lower**; process CPU: 25.4% lower.
- Raw: prev `[2643, 2656, 2633, 2660, 2636]`; now
  `[1792, 1793, 1786, 1807, 1771]` ms.
- States: 2,279,913 to 1,233,201 (-45.9%).
- Rips: 195 to 119; passes: 23 to 13.
- Heap: 201.1 to 168.0 MiB (-16.5%); RSS: 635.4 to 590.3 MiB (-7.1%).

### Ladder 5 — STM32 display BoosterPack

- Prev: 3,131 ms mean, 329 ms standard deviation, 3,886 ms process CPU.
- Now: 2,347 ms mean, 84 ms standard deviation, 3,037 ms process CPU.
- Runtime: **25.0% lower**; process CPU: 21.8% lower.
- Raw: prev `[2835, 2937, 2873, 3315, 3694]`; now
  `[2302, 2301, 2319, 2298, 2515]` ms.
- States: 2,475,394 to 1,834,271 (-25.9%).
- Rips: 245 to 207; passes: 13 to 12.
- Heap: 226.3 to 199.9 MiB (-11.7%); RSS: 694.1 to 676.3 MiB (-2.6%).

### Ladder 6 — BiscuitBoard RP2040 stress case

- Prev: 38,317 ms mean, 40,509 ms process CPU.
- Now: 37,842 ms mean, 40,008 ms process CPU.
- Runtime: **1.2% lower**; process CPU: 1.2% lower.
- Balanced raw samples: prev `[37295, 38110, 37168, 40694]`; now
  `[36848, 38530, 39498, 36493]` ms.
- States/rips/passes remain exactly 26,510,022 / 1,535 / 81.
- Heap: 707.2 to 682.6 MiB (-3.5%); RSS: 1,799.8 to 1,769.8 MiB
  (-1.7%).

RP2040's improvement is intentionally modest. The medium-board approximation
is disabled here because all tested weighted or more aggressive negotiation
policies were dramatically worse.

## Stage timing

Mean wall milliseconds. Small stage totals may differ from total elapsed due
to rounding and process/harness overhead.

| Ladder | Version | Graph | Route/rip | Post | Beautify | Expand | Total |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | Prev | 148 | 128 | 13 | 14 | 48 | 353 |
| 3 | Now | 148 | 84 | 14 | 13 | 48 | 309 |
| 4 | Prev | 336 | 1,893 | 43 | 46 | 320 | 2,646 |
| 4 | Now | 334 | 1,037 | 40 | 49 | 323 | 1,790 |
| 5 | Prev | 483 | 2,233 | 58 | 102 | 250 | 3,131 |
| 5 | Now | 486 | 1,480 | 53 | 82 | 243 | 2,347 |
| 6 | Prev | 4,133 | 27,801 | 556 | 4,259 | 1,546 | 38,317 |
| 6 | Now | 4,299 | 27,507 | 542 | 4,138 | 1,338 | 37,842 |

The graph generator is already the packed v3 implementation, so v4 leaves its
work essentially unchanged. Ladders 3–5 improve almost entirely in routing.

## Memory footprint

The headline table reports arithmetic mean peak heap and RSS for every ladder.
External and ArrayBuffer memory overlap with RSS and must not be added to it.

| Ladder | Prev external | Now external | Prev ArrayBuffers | Now ArrayBuffers |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.3 MiB | 0.3 MiB | <0.1 MiB | <0.1 MiB |
| 2 | 0.4 MiB | 0.4 MiB | 0.1 MiB | 0.1 MiB |
| 3 | 15.6 MiB | 14.9 MiB | 6.0 MiB | 6.0 MiB |
| 4 | 30.7 MiB | 37.0 MiB | 18.8 MiB | 24.9 MiB |
| 5 | 37.0 MiB | 37.5 MiB | 23.8 MiB | 24.1 MiB |
| 6 | 108.1 MiB | 123.9 MiB | 90.3 MiB | 104.2 MiB |

External high-water marks rise on ladders 4 and 6, while total RSS and heap
fall. This is acceptable for the current release gate but should remain
observable: typed-array/external allocator timing can shift memory between
categories even when total resident memory improves.

### Low-memory production lane

Three current samples per realistic medium rung with
`retainIntermediateStages: false`:

| Ladder | Mean | Std dev | CPU | Peak heap | Peak RSS | Retained outputs | Raw |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 3 | 317 ms | 7 ms | 609 ms | 51.5 MiB | 303.9 MiB | 1 | `[325, 308, 317]` |
| 4 | 2,087 ms | 161 ms | 2,906 ms | 167.5 MiB | 595.4 MiB | 1 | `[2015, 2310, 1937]` |
| 5 | 2,377 ms | 21 ms | 3,056 ms | 213.9 MiB | 684.1 MiB | 1 | `[2390, 2348, 2393]` |

All nine samples pass and retain one pipeline stage output. Peak memory still
occurs while graph and active-search state are live; low-memory mode controls
post-stage retention rather than the live working set.

## Parallelism findings

`node:worker_threads` remains the appropriate JavaScript primitive for
CPU-bound in-process work. `exec` and `fork` would add process startup and clone
large graph heaps. The v3 implementation already uses shared packed buffers
and transferable results for conflict collection.

Parallelism helps in two places:

1. **Independent boards or parameter candidates.** A persistent pool can route
   separate boards concurrently with no shared solver state. This is the best
   production parallel seam for throughput.
2. **Very large graph conflict collection.** Four workers improved isolated
   RP2040 graph collection in v3, but full synchronous pipeline runtime
   regressed 4.0% and RSS rose 2.9%. It therefore remains opt-in.

Parallel demand routing was not enabled. Search results depend on mutable edge
owners, node owners, conflict occupancy, history penalties, fixed-via
reservations, same-net topology, and pending order. Speculative workers would
need snapshots plus a serial collision/repair merge. The experiments in this
pass show how sensitive RP2040 is to small policy changes; duplicated searches
would also threaten the reduced heap target. For one board, reducing search
work is faster than parallelizing stale work.

## Rejected experiments

- **Weighted RP2040 search:** weight 1.05 reached roughly 69 million states and
  timed out; the original adaptive rule exceeded 114 million states and 600
  passes. Large boards now force weight 1.0.
- **More aggressive immediate ripping:** improved medium cases but exceeded
  120 million RP2040 states. It is now topology-gated.
- **No immediate ripping:** generally worsened medium cases.
- **Aggressive history escalation:** one schedule failed with a disconnected
  net; a milder schedule exhausted a route after roughly 82 million states.
- **Static RP2040 order:** shortest-first solved in about 65.7 seconds with
  54.9 million states and 430 passes; longest-first timed out after about 79.1
  million states and 583 passes. Adaptive ordering remains the default.
- **Target-topology heuristic cache:** a 16-slot cache reduced misses from
  22.3 million to 13.5 million but took about 39.4 seconds and raised heap to
  about 879 MiB. Four slots worsened medium cases. The cache was removed.
- **Linear and generation-stamped owner deduplication:** both were slower than
  `Set<number>` in the measured foreign-owner loop.
- **Hot-loop diagnostic counters:** counting 28.2 million heap pops caused a
  10.6% stress regression. Removed from production instrumentation.
- **Default graph workers:** isolated graph speedup did not survive end-to-end
  measurement. Existing workers remain explicit/opt-in.

## Correctness and verification

- Final ladders 1–5: 50/50 prev/now samples pass all validity gates.
- Final RP2040: 8/8 balanced prev/now samples pass all validity gates.
- Low-memory lane: 9/9 samples pass and retain one stage output.
- TypeScript type-check: passed.
- Full Bun test suite: 35 passed, 0 failed.
- Browser/Cosmos production build: passed.
- Formatting and `git diff --check`: passed.

## Reproduction

Create the previous worktree:

```sh
git worktree add --detach /tmp/biscuit-v4-prev 9d8e91f
ln -s "$PWD/node_modules" /tmp/biscuit-v4-prev/node_modules
```

Run ladders 1–5:

```sh
bun scripts/perf-ladder.ts \
  --runs=5 \
  --max-ms=60000 \
  --case=tiny \
  --case=fixed-via \
  --case=stm32 \
  --case=stm32-display \
  --case=boosterpack \
  --compare=/tmp/biscuit-v4-prev/lib/index.ts
```

Run the stress rung with at least four balanced samples, reversing one pair if
needed so each implementation runs first equally often:

```sh
bun scripts/perf-ladder.ts \
  --runs=4 \
  --max-ms=120000 \
  --case=rp2040 \
  --compare=/tmp/biscuit-v4-prev/lib/index.ts
```

Run the low-memory lane:

```sh
bun scripts/perf-ladder.ts \
  --runs=3 \
  --low-memory \
  --max-ms=60000 \
  --case=stm32 \
  --case=stm32-display \
  --case=boosterpack
```

## Recommended next course

For lower single-board latency, the next algorithmic work should remain
serial and reduce RP2040's 26.51-million-state exact search:

1. prototype bounded beam search or focal search behind an option;
2. use a coarse graph to seed corridors, then refine only near obstacles and
   terminals;
3. add a validity-preserving fallback to exact A* when an approximate search
   stalls;
4. profile a decrease-key/indexed heap only in a non-perturbing build; and
5. consider a native/WASM geometry and heap kernel only after state reduction
   stops paying.

For throughput across multiple boards, add an asynchronous batch API backed by
a persistent worker pool. Do not make per-demand speculative workers the next
single-board optimization: current evidence says they duplicate mutable work
and memory rather than shorten the critical path.

## Bottom line

V4 gets the medium real-board ladder 12–32% faster and 8–17% lower in peak heap
by reducing the number of states and rips. It does not sacrifice the RP2040
stress case: that rung remains exact, becomes 1.2% faster, and uses 3.5% less
heap. The fastest measured production configuration is still serial routing
with packed graph collection; workers are best reserved for independent boards
or explicitly requested large-graph collection.
