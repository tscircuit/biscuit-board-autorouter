# Biscuit-board autorouter performance findings v5

Date: 2026-08-20

## Executive summary

V5 implements and measures the next steps proposed by v4 against the v4
checkpoint, commit `12af2f1c1e843972553c7a8bbcbbd6eebcd1f73e`.

The production single-board win is a conservatively gated coarse routing
corridor with an automatic exact-A* fallback. On the STM32 display board it
cuts expanded states from 1,233,201 to 587,504 (-52.4%), average end-to-end
runtime from 2,085 ms to 1,480 ms (-29.0%), average peak heap from 172.2 MiB to
149.0 MiB (-13.4%), and average peak RSS from 588.9 MiB to 548.7 MiB (-6.8%).
The route/rip stage itself falls from 1,228 ms to 629 ms (-48.8%).

The approximation is not applied globally. Small boards remain exact, the
larger BoosterPack remains exact, explicit non-adaptive route orders remain
exact, and the RP2040 stress board remains exact. This is important because
local beam and corridor policies made RP2040 dramatically slower or timed out.

For independent-board throughput, v5 adds a persistent `worker_threads` pool
behind the separate `./worker-pool` package export. Four STM32 boards complete
in 642 ms with two workers versus 1,076 ms sequentially (1.68x throughput), or
562 ms with four workers versus 1,529 ms sequentially (2.72x throughput).

| Ladder | Prev mean | Now mean | Runtime | Prev heap | Now heap | Heap | Prev RSS | Now RSS | RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 8 ms | 8 ms | 0.0% | 1.2 MiB | 1.2 MiB | 0.0% | 67.9 MiB | 67.1 MiB | -1.1% |
| 2 | 13 ms | 13 ms | 0.0% | 1.2 MiB | 1.2 MiB | 0.0% | 74.5 MiB | 74.9 MiB | +0.6% |
| 3 | 475 ms | 442 ms | -6.9% | 52.7 MiB | 51.1 MiB | -3.1% | 303.4 MiB | 305.4 MiB | +0.7% |
| 4 | 2,085 ms | 1,480 ms | **-29.0%** | 172.2 MiB | 149.0 MiB | **-13.4%** | 588.9 MiB | 548.7 MiB | **-6.8%** |
| 5 | 2,436 ms | 2,456 ms | +0.8% | 209.1 MiB | 207.6 MiB | -0.7% | 676.6 MiB | 669.6 MiB | -1.0% |
| 6 | 46,298 ms | 48,513 ms | +4.8% mean / -2.3% median | 653.4 MiB | 669.2 MiB | +2.4% | 1,509.4 MiB | 1,139.6 MiB | -24.5% |

Levels 1 and 2 are startup dominated. Level 3 does identical search work and
its apparent gain is run variance. Level 5 is neutral. Level 6 also does
identical work and has unusually high host variance; its mean and median move
in opposite directions, so v5 does not claim an RP2040 runtime improvement.

## Measurement protocol

- Runtime: Bun 1.3.14, arm64, Apple M5.
- Previous implementation: detached worktree at `12af2f1` with the same
  dependency tree.
- Current implementation: final v5 working tree.
- Every sample runs in a fresh child process.
- Previous/current execution order alternates within each ladder.
- Ladders 1-5 use five samples per implementation.
- Ladder 6 uses three samples per implementation and a 120,000 ms per-process
  timeout.
- The low-memory lane uses three samples per implementation on ladders 3-5.
- Memory is sampled every 50 ms and once after completion.
- Means include every sample; no outliers are removed.

Every ladder sample must report solved and not failed, return the expected
trace count, manufacture no vias, stay inside board bounds, and contain no
final trace-clearance violation. Output geometry may differ from v4 as allowed
by the speed-first requirement, but it must pass those validity gates.

## Implementation plan and completed order

The v4 recommendations were implemented in risk order so that every lossy
optimization had an exact escape path before becoming a default.

1. **Add benchmark controls and observability.** The ladder accepts beam width
   and corridor stretch overrides and reports approximate searches, fallbacks,
   and beam trimming.
2. **Implement bounded beam search behind an option.** `MinHeap.trimToSize`
   retains the lowest-priority frontier entries. Beam trimming is disabled by
   default because tuning did not produce a safe cross-ladder win.
3. **Implement a coarse first-pass corridor.** Eligible two-terminal routes
   first search a source/target bounding corridor with proportional padding.
4. **Add exact fallback.** An exhausted corridor/beam search or state-limit hit
   marks that demand exact-only and restarts unrestricted A*.
5. **Gate approximation by measured topology.** The default applies only to
   adaptive boards with 20-63 demands and at most 30,000 graph nodes. This
   selects the display board while excluding the BoosterPack and RP2040.
6. **Evaluate an indexed decrease-key heap.** The implementation was measured,
   regressed both work and memory, and was removed.
7. **Protect the exact hot path.** Exact and corridor adjacency expansion use
   separate loops. Approximation fields and counters are allocated lazily, so
   exact-only solver/search objects do not carry corridor state.
8. **Implement independent-board parallelism.** Added a persistent standard
   worker-thread pool with bounded size, task dispatch, ordered batch results,
   close semantics, and worker replacement after errors.
9. **Repeat the full ladder and low-memory lane.** The final defaults were
   frozen only after the exact controls and fallback test passed.

The conditional v4 suggestion to move the hot kernel to native code/WASM was
not taken: state reduction is still paying substantially on the selected
medium topology, while the indexed-heap experiment showed that changing a hot
representation without reducing work can regress badly. Adding a native
toolchain and cross-boundary memory ownership is not justified by the current
evidence.

## Implemented changes

### Coarse corridor with exact fallback

The new public routing options are:

- `coarseCorridorStretch`, default `1.5`; zero disables corridors;
- `approximateSearchMinDemandCount`, default `20`;
- `approximateSearchMaxDemandCount`, default `63`;
- `approximateSearchMaxGraphNodeCount`, default `30_000`; and
- `beamWidth`, default `0`, which leaves beam trimming disabled.

For an eligible two-terminal demand with no already-owned same-net topology,
the first search is constrained to the source/target bounding box. Padding is
the larger of two grid pitches or half of the extra distance implied by the
stretch. Existing multi-terminal growth remains unrestricted because a local
source/target box can exclude the already-built same-net tree.

Fallback order is validity preserving:

1. approximate search without blockers;
2. approximate search with blockers;
3. unrestricted exact search without blockers; and
4. the existing exact blocker/rip-and-replace behavior.

The fallback regression fixture intentionally puts the only valid path outside
the corridor and confirms that unrestricted A* recovers it.

### Exact-path isolation

An intermediate implementation checked corridor bounds in the shared edge hot
loop. Even when RP2040 was ineligible, that added a branch to tens of millions
of expansions and produced a clear regression. The final implementation uses
separate exact and corridor expansion methods and selects the method once per
3,000-expansion solver quantum.

The final version also omits approximation properties and counter storage from
exact-only object instances. This avoids perturbing the runtime layout of the
v4 exact path. This matters in a JavaScript hot loop: logically dormant fields
and diagnostics can still affect generated code and memory layout.

### Optional beam search

`MinHeap.trimToSize(maxSize)` sorts the active frontier by priority and retains
the best entries. Trimming happens at most once per solver quantum and only
when the heap exceeds twice the requested width. The implementation and unit
test remain available for controlled experiments, but `beamWidth: 0` is the
production default.

### Persistent worker pool

`BiscuitBoardWorkerPool` uses `node:worker_threads`, the normal in-process
primitive for CPU-bound JavaScript. It exposes `route`, ordered `routeMany`,
and `close`. A default pool is bounded by available CPU count and capped at
four workers. Worker failure rejects the active task and replaces the worker
while the pool remains open.

The pool is exported from `./worker-pool`, not the browser-oriented main entry,
so browser bundling does not pull in Node worker APIs. Each worker owns one
board's solver state; no mutable negotiation state or graph heap is shared
between boards.

## Ladder results

### Ladder 1 - tiny unobstructed route

- Previous: 8 ms mean; raw `[8, 8, 8, 8, 8]`.
- Current: 8 ms mean; raw `[8, 8, 8, 8, 8]`.
- Work: 7 states, 0 rips, 0 passes on both sides.
- Memory: 1.2 MiB heap / 67.9 MiB RSS to 1.2 MiB / 67.1 MiB.
- Interpretation: no measurable change; approximation is disabled.

### Ladder 2 - small fixed-via route

- Previous: 13 ms mean; raw `[13, 13, 14, 14, 13]`.
- Current: 13 ms mean; raw `[13, 13, 13, 14, 13]`.
- Work: 206 states, 0 rips, 0 passes on both sides.
- Memory: 1.2 MiB heap / 74.5 MiB RSS to 1.2 MiB / 74.9 MiB.
- Interpretation: no measurable change; fixed-via behavior remains exact.

### Ladder 3 - BiscuitBoard STM32C071FBP6

- Previous: 475 ms mean, 489 ms median; raw
  `[315, 489, 607, 507, 457]`.
- Current: 442 ms mean, 479 ms median; raw
  `[326, 381, 511, 479, 512]`.
- CPU: 922 ms to 856 ms.
- Work is identical: 76,486 states, 24 rips, 0 passes.
- Memory: 52.7 to 51.1 MiB heap; 303.4 to 305.4 MiB RSS.
- Interpretation: timing is neutral-to-faster but not algorithmic;
  approximation is disabled and the raw samples overlap.

### Ladder 4 - STM32C071 display board

- Previous: 2,085 ms mean, 1,928 ms median; raw
  `[2686, 1919, 1928, 1967, 1925]`.
- Current: 1,480 ms mean, 1,481 ms median; raw
  `[1521, 1481, 1500, 1470, 1426]`.
- Runtime: **29.0% lower**; CPU: 2,902 to 2,260 ms (-22.1%).
- States: 1,233,201 to 587,504 (-52.4%).
- Rips: 119 to 114; negotiation passes: 13 to 11.
- Current performs 178 approximate searches and zero exact fallbacks.
- Heap: 172.2 to 149.0 MiB (-13.4%).
- RSS: 588.9 to 548.7 MiB (-6.8%).
- External memory: 37.0 to 35.2 MiB; ArrayBuffers: 24.9 to 22.5 MiB.

This is the production single-board gain. Every current sample is faster than
four of five previous samples, and the search-work reduction explains the
timing separation.

### Ladder 5 - STM32 display BoosterPack

- Previous: 2,436 ms mean, 2,391 ms median; raw
  `[2391, 2422, 2388, 2354, 2624]`.
- Current: 2,456 ms mean, 2,381 ms median; raw
  `[2381, 2426, 2379, 2737, 2358]`.
- CPU: 3,140 to 3,170 ms.
- Work is identical: 1,834,271 states, 207 rips, 12 passes.
- Approximate searches: zero because the graph exceeds 30,000 nodes.
- Heap: 209.1 to 207.6 MiB (-0.7%); RSS: 676.6 to 669.6 MiB (-1.0%).
- Interpretation: runtime is neutral; one current outlier moves the mean while
  the median is 10 ms faster.

### Ladder 6 - BiscuitBoard RP2040 stress case

- Previous: 46,298 ms mean, 49,525 ms median, 6,797 ms standard deviation;
  raw `[36843, 52526, 49525]`.
- Current: 48,513 ms mean, 48,364 ms median, 415 ms standard deviation;
  raw `[48364, 49079, 48097]`.
- Mean runtime is 4.8% higher, but median runtime is 2.3% lower.
- CPU: 48,877 to 50,669 ms (+3.7%).
- Work is exactly identical: 26,510,022 states, 1,535 rips, 81 passes.
- Approximate searches: zero.
- Heap: 653.4 to 669.2 MiB (+2.4%).
- RSS: 1,509.4 to 1,139.6 MiB (-24.5%).
- External memory: 112.7 to 137.6 MiB; ArrayBuffers: 94.2 to 119.2 MiB.

The previous samples span 15.7 seconds, while current samples span less than
one second. With identical work and opposing mean/median directions, this is
classified as runtime-neutral/inconclusive. The RSS reduction is large, but
allocator timing also shifts about 25 MiB into the external/ArrayBuffer
high-water marks, so the categories should be read together rather than added.

## Stage timing

Mean wall milliseconds. Rounded stage totals can differ from end-to-end time.

| Ladder | Version | Graph | Route/rip | Post | Beautify | Expand | Total |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | Prev | 228 | 129 | 21 | 21 | 73 | 475 |
| 3 | Now | 210 | 121 | 20 | 19 | 69 | 442 |
| 4 | Prev | 400 | 1,228 | 42 | 53 | 354 | 2,085 |
| 4 | Now | 389 | 629 | 46 | 50 | 359 | 1,480 |
| 5 | Prev | 526 | 1,523 | 52 | 82 | 247 | 2,436 |
| 5 | Now | 499 | 1,565 | 54 | 83 | 250 | 2,456 |
| 6 | Prev | 5,261 | 33,407 | 693 | 5,097 | 1,814 | 46,298 |
| 6 | Now | 4,747 | 34,947 | 896 | 6,001 | 1,890 | 48,513 |

Level 4's improvement is isolated to routing, as intended. Graph generation
and final geometry stages remain approximately unchanged. Exact Levels 5 and 6
also show no search-work change.

## Memory footprint

The headline table contains average peak heap and RSS for every ladder.
External and ArrayBuffer values overlap RSS and must not be added to RSS.

| Ladder | Prev external | Now external | Prev ArrayBuffers | Now ArrayBuffers |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 0.3 MiB | 0.3 MiB | <0.1 MiB | <0.1 MiB |
| 2 | 0.4 MiB | 0.4 MiB | 0.1 MiB | 0.1 MiB |
| 3 | 14.3 MiB | 14.6 MiB | 6.0 MiB | 6.0 MiB |
| 4 | 37.0 MiB | 35.2 MiB | 24.9 MiB | 22.5 MiB |
| 5 | 37.6 MiB | 37.6 MiB | 24.1 MiB | 24.1 MiB |
| 6 | 112.7 MiB | 137.6 MiB | 94.2 MiB | 119.2 MiB |

### Low-memory production lane

`retainIntermediateStages: false`; three samples per implementation. Every
sample retains one stage output.

| Ladder | Prev mean | Now mean | Runtime | Prev heap | Now heap | Heap | Prev RSS | Now RSS | RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 442 ms | 472 ms | +6.8% | 52.2 MiB | 51.2 MiB | -1.9% | 303.9 MiB | 301.9 MiB | -0.7% |
| 4 | 2,067 ms | 1,666 ms | **-19.4%** | 172.1 MiB | 141.1 MiB | **-18.0%** | 553.2 MiB | 524.0 MiB | **-5.3%** |
| 5 | 2,365 ms | 2,412 ms | +2.0% | 211.8 MiB | 220.7 MiB | +4.2% | 654.7 MiB | 676.7 MiB | +3.4% |

Raw runtime samples:

- Ladder 3: previous `[364, 496, 467]`; current `[452, 493, 470]`.
- Ladder 4: previous `[2473, 1846, 1883]`; current `[1996, 1580, 1422]`.
- Ladder 5: previous `[2343, 2410, 2341]`; current `[2401, 2424, 2411]`.

The corridor's Level 4 memory reduction survives low-memory mode. Level 5's
three-sample memory movement is unfavorable but small relative to run-to-run
allocator variance and has no algorithmic or retained-output change.

## Parallel throughput

The throughput benchmark routes four independent STM32 boards. Each mode runs
three times, alternates order, validates all output trace counts, and reuses the
same persistent pool after warm-up.

| Workers | Sequential mean | Pooled mean | Throughput | Sequential raw | Pooled raw |
| ---: | ---: | ---: | ---: | --- | --- |
| 2 | 1,076 ms | 642 ms | **1.68x** | `[1063, 1168, 996]` | `[619, 680, 626]` |
| 4 | 1,529 ms | 562 ms | **2.72x** | `[1352, 1383, 1851]` | `[464, 443, 780]` |

This improves aggregate throughput, not the latency of one board. A worker
pool duplicates per-board live heaps by design, so callers should keep pool
size bounded by both CPU and memory. Per-demand workers remain inappropriate:
demand searches mutate shared ownership, congestion history, same-net trees,
pending priority, and rip state, making speculative results stale and costly
to merge.

## Rejected and constrained experiments

### Beam search

Beam-only display tuning did not produce a stable improvement:

| Width | Runtime | States | Rips | Passes | Fallbacks |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 256 | 4.411 s | 2,213,901 | 172 | 9 | 4 |
| 512 | 3.514 s | 1,205,022 | 134 | 7 | 1 |
| 1,024 | 4.953 s | 1,321,837 | 120 | 18 | 0 |
| 2,048 | 4.300 s | 1,234,175 | 119 | 13 | 0 |

Beam width 512 on RP2040 timed out the validity harness after 121.8 seconds,
50.8 million states, 2,734 rips, and 104 passes. Beam support remains opt-in,
but no production default is justified.

### Corridor scope

Display-board corridor tuning selected stretch 1.5:

| Stretch | Runtime | States | Rips | Passes | Fallbacks |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1.0 | 2.468 s | 714,596 | 121 | 13 | 1 |
| 1.25 | 2.719 s | 756,008 | 153 | 13 | 1 |
| 1.5 | 2.052 s | 587,504 | 114 | 11 | 0 |
| 2.0 | 2.413 s | 795,446 | 120 | 6 | 0 |
| 3.0 | 3.341 s | 1,499,583 | 180 | 24 | 0 |

The same stretch on RP2040 timed out after 120 seconds with 88.7 million
states, 6,258 rips, and 286 passes. BoosterPack preferred a much wider local
corridor, but no one stretch improved both medium fixtures. The graph-node gate
therefore excludes both BoosterPack and RP2040 instead of applying a brittle
global default.

### Indexed decrease-key heap

The indexed heap was removed after a two-run display comparison:

- duplicate-entry heap: 1,745 ms mean, 1,233,201 states, 119 rips, 13 passes,
  about 181 MiB heap;
- indexed heap: 3,862 ms mean, 3,126,623 states, 215 rips, 51 passes, about
  283 MiB heap.

The replacement changed tie/order behavior enough to amplify negotiation and
was worse on every target metric. Avoiding stale entries is not useful when it
causes more route searches and larger retained state.

### Native/WASM kernel

Deferred. The best current opportunity still comes from reducing state count,
and a native boundary would add serialization/shared-memory ownership and a
second implementation of validity-sensitive search rules. Reconsider only
after a hierarchical global route plan reduces RP2040 work or a sampling
profile identifies one stable geometry/heap kernel with enough arithmetic
intensity to amortize the boundary.

## Correctness and verification

- Main ladder: 50/50 previous/current samples pass validity gates.
- RP2040 ladder: 6/6 previous/current samples pass validity gates.
- Low-memory lane: 18/18 previous/current samples pass validity gates and
  retain one output.
- Approximate fallback regression: passed.
- Worker-pool ordering/output test: passed.
- Heap trimming test: passed.
- TypeScript typecheck: passed.
- Full Bun test suite: passed.
- Browser/Cosmos production build: passed.
- Formatting and `git diff --check`: passed.

The display-board route geometry changes intentionally under the speed-first
policy. Repro03 and repro04 snapshots were updated; the resulting routes pass
the normal bounds, trace-count, fixed-via, and clearance checks. The explicit
non-adaptive redundant-GND fixture remains exact.

## Reproduction

Create the previous worktree:

```sh
git worktree add --detach /tmp/biscuit-v5-prev 12af2f1
ln -s "$PWD/node_modules" /tmp/biscuit-v5-prev/node_modules
```

Run ladders 1-5:

```sh
bun scripts/perf-ladder.ts \
  --runs=5 \
  --max-ms=60000 \
  --case=tiny \
  --case=fixed-via \
  --case=stm32 \
  --case=stm32-display \
  --case=boosterpack \
  --compare=/tmp/biscuit-v5-prev/lib/index.ts
```

Run the stress rung:

```sh
bun scripts/perf-ladder.ts \
  --runs=3 \
  --max-ms=120000 \
  --case=rp2040 \
  --compare=/tmp/biscuit-v5-prev/lib/index.ts
```

Run the low-memory lane:

```sh
bun scripts/perf-ladder.ts \
  --runs=3 \
  --low-memory \
  --max-ms=60000 \
  --case=stm32 \
  --case=stm32-display \
  --case=boosterpack \
  --compare=/tmp/biscuit-v5-prev/lib/index.ts
```

Run the worker throughput benchmark:

```sh
bun scripts/perf-worker-pool.ts --runs=3 --boards=4 --pool-size=2
bun scripts/perf-worker-pool.ts --runs=3 --boards=4 --pool-size=4
```

## Recommended next course

For lower single-board latency, stop tuning a per-demand local corridor for the
large board. The RP2040 experiments show that local approximations can route
each demand cheaply while creating globally expensive rip/negotiation cycles.
The next useful algorithmic step is a hierarchical board-level plan:

1. partition the graph into coarse regions and capacity-aware portals;
2. assign all demands coarse corridors before detailed routing;
3. reserve scarce portals and fixed-via transitions globally;
4. refine routes inside those corridors with the current exact solver;
5. widen or discard only the failed corridor, then fall back to unrestricted
   exact A*; and
6. benchmark state count, rips, passes, heap, and RSS before considering a
   native/WASM inner kernel.

For batch services, use `BiscuitBoardWorkerPool` now and bound pool size by the
worst board's live RSS. Do not nest graph-conflict workers inside a fully loaded
board pool without a separate CPU/memory admission limit.

## Bottom line

V5 successfully converts one v4 recommendation into a production default:
the selected display topology is 29.0% faster with 13.4% less peak heap and
6.8% less RSS, while exact controls preserve their work and validity. Beam and
indexed-heap approaches are retained only where useful or removed where
harmful. Independent-board worker threads provide 1.68x-2.72x throughput. The
remaining hard target is RP2040, and the evidence now points to a coordinated
hierarchical route plan rather than more local search truncation.
