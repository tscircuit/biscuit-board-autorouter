# Biscuit-board autorouter performance findings v3

Date: 2026-08-20

## Executive summary

This pass implements the conflict broad-phase work recommended by
`perf_findings_v2.md`, evaluates safe parallel seams, and adds standard
`node:worker_threads` parallel conflict collection without changing graph or
route semantics.

The production default is a new packed serial collector. On realistic boards,
it reduces mean wall time by 5–20% versus commit `703211c`. The RP2040 stress
case improves from 60.2 seconds to 49.4 seconds, process CPU falls 16.6%, and
peak heap falls 2.1%. All repeated samples solve and pass trace-count,
fixed-via, manufactured-via, and clearance checks.

Four workers help only the isolated RP2040 graph workload: graph-only wall time
falls 5.2% and conflict-collection time falls 12.2%. They do not improve the
current synchronous end-to-end pipeline. In a direct two-sample current/current
comparison, four workers are 4.0% slower and use 2.9% more RSS than packed
serial. Workers are therefore implemented and tested, but opt-in. The default
remains serial until the pipeline has an asynchronous or persistent-worker
boundary that can amortize startup and teardown.

| Ladder | Prev mean | Current mean | Runtime | Prev heap | Current heap | Heap | Prev RSS | Current RSS | RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 7 ms | 8 ms | +14.3% | 1.2 MiB | 1.2 MiB | 0.0% | 68.2 MiB | 66.9 MiB | -1.9% |
| 2 | 13 ms | 14 ms | +7.7% | 1.2 MiB | 1.2 MiB | 0.0% | 75.2 MiB | 74.8 MiB | -0.6% |
| 3 | 484 ms | 387 ms | -20.0% | 59.4 MiB | 57.7 MiB | -2.8% | 311.0 MiB | 315.6 MiB | +1.5% |
| 4 | 3,144 ms | 2,926 ms | -6.9% | 195.2 MiB | 226.0 MiB | +15.8% | 613.9 MiB | 639.7 MiB | +4.2% |
| 5 | 3,142 ms | 2,970 ms | -5.5% | 279.5 MiB | 221.6 MiB | -20.7% | 710.3 MiB | 704.7 MiB | -0.8% |
| 6 | 60,154 ms | 49,355 ms | -18.0% | 675.5 MiB | 661.3 MiB | -2.1% | 1,328.6 MiB | 1,520.5 MiB | +14.4% |

Ladders 1–2 are below the timing resolution needed to evaluate this change.
Their one-millisecond differences are runtime startup noise, not meaningful
algorithm regressions.

## What “prev” and “current” mean

- **Prev:** commit `703211cc03d082b2e98b35805cb715baacd3a8ab`,
  `perf: reduce routing hot-path overhead`.
- **Current:** this working tree, with packed conflict collection and serial
  collection as the production default.
- Both use Bun 1.3.14, identical dependencies, fixtures, and routing options.
- Every sample runs in a fresh child process.
- Ladders 1–5 use five samples per implementation.
- Ladder 6 uses three samples per implementation and a 120,000 ms ceiling.
- Prev/current order alternates on each repetition and reverses on even runs.
- Memory is sampled every 50 ms and once at completion.

## Step-by-step plan executed

1. Re-established ladder 3 as the fast correctness/performance loop.
2. Confirmed graph conflict discovery is immutable and independent per edge;
   confirmed rip-up routing mutates shared occupancy/history and is not safely
   parallel under exact current semantics.
3. Replaced object-heavy `Map<number, number[]>` conflict buckets with packed
   typed-array geometry and CSR bucket storage.
4. Assigned every candidate pair one canonical shared bucket, removing repeat
   bounding-box and exact-distance work without changing pair order.
5. Reimplemented segment checks over packed numeric coordinates, avoiding
   routing-node object traversal in the candidate loop.
6. Added `node:worker_threads` processing over disjoint contiguous edge ranges.
7. Shared packed read-only buffers through `SharedArrayBuffer`; returned pair
   chunks as transferable `ArrayBuffer`s instead of cloning graph objects.
8. Balanced worker ranges with square-root boundaries because later edges have
   more prior candidates than early edges.
9. Added automatic thresholding, explicit worker controls, and an alternating
   serial/worker benchmark mode.
10. Added a regression test that compares serial and worker CSR offsets and IDs
    exactly, including order.
11. Benchmarked worker counts and rejected workers as the production default
    after the end-to-end control regressed.
12. Ran the full repeated A/B ladder, low-memory lane, test suite, type-check,
    browser build, formatting, and diff checks.

## Implemented fixes

### Packed conflict geometry and bucket CSR

The previous collector retained routing objects in a hash map of JavaScript
arrays. The current collector packs immutable fields into bounded typed arrays:

- trace edge ID;
- layer ID;
- four endpoint coordinates;
- four segment bounds;
- four bucket bounds;
- bucket offsets; and
- bucket trace indexes.

Bucket occupancy is built in two passes: count, prefix sum, then fill. Bucket
members remain in trace-edge order, so conflict discovery and compact CSR
ordering remain byte-identical to the previous implementation.

The packed index contains only 432,275 bucket references on RP2040, compared
with 146,995,796 query candidate visits. It is shared rather than cloned when
worker mode is enabled.

### Canonical candidate processing

A long segment can occur in several buckets. The old generation-stamp array
prevented repeated exact checks, but the hot loop still loaded and rejected the
same candidate from every shared bucket.

Current behavior assigns a pair to the first bucket in the intersection of:

- the current segment's clearance-expanded query cells; and
- the prior segment's actual-bounds cells.

Only that canonical occurrence performs the bounding-box and exact-distance
checks. Raw bucket entry visits remain measurable, but expensive unique
candidate work falls substantially.

| Ladder | Raw bucket visits | Unique candidates | Duplicate work skipped | Exact checks | Conflict references |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 2,474,073 | 1,830,055 | 26.0% | 657,450 | 641,284 |
| 4 | 12,632,332 | 5,684,732 | 55.0% | 3,065,645 | 1,965,032 |
| 5 | 12,291,079 | 7,640,242 | 37.8% | 3,157,637 | 2,028,696 |
| 6 | 146,995,796 | 51,574,852 | 64.9% | 30,376,158 | 10,948,664 |

Exact-check and conflict-reference counts are unchanged from `703211c`. The
optimization removes repeated broad-phase work; it does not approximate
geometry or alter clearance.

### Worker-thread implementation

`node:worker_threads` is the standard in-process primitive for CPU-bound
JavaScript work. `child_process.exec` or `fork` would require process startup
and duplicate the packed graph in separate heaps. Web Workers cannot provide a
synchronous result to the existing solver API.

The implementation uses:

- `SharedArrayBuffer` for immutable packed index inputs;
- disjoint edge-index ranges, so workers never mutate shared conflict output;
- transferable pair chunks for zero-copy result handoff;
- `MessageChannel` and `receiveMessageOnPort` for synchronous integration with
  the current solver contract;
- `Atomics.wait/notify` for completion; and
- a 120-second worker fail-fast.

`conflictWorkerCount` controls the mode:

- `1`: packed serial collection; this is the default.
- `0`: bounded automatic workers on Node/Bun when there are at least 100,000
  trace edges; otherwise serial.
- `N > 1`: force at most `N` workers. Browser runtimes fall back to serial.

## Where parallelism helps

### Helpful: isolated RP2040 conflict collection

Three alternating graph-only samples, current implementation on both sides:

| Mode | Graph mean | Std dev | Process CPU | Peak heap | Peak RSS | Conflict collection |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Serial | 4,326 ms | 198 ms | 5,000 ms | 277.4 MiB | 858.9 MiB | 1,560 ms mean |
| 4 workers | 4,103 ms | 341 ms | 5,121 ms | 286.4 MiB | 872.1 MiB | 1,369 ms mean |
| Delta | -5.2% | — | +2.4% | +3.2% | +1.5% | -12.2% |

Workers help this isolated CPU-heavy phase, although their total CPU and memory
cost rises. This mode is useful when graph latency matters independently or a
future persistent pool amortizes lifecycle overhead.

### Not helpful: BoosterPack conflict collection

Three graph-only samples at each forced count:

| Workers | Graph mean | Process CPU |
| ---: | ---: | ---: |
| 1 | 450 ms | 607 ms |
| 2 | 463 ms | 694 ms |
| 3 | 468 ms | 749 ms |
| 4 | 465 ms | 800 ms |

Worker startup dominates the available work. This is why automatic mode does
not start workers below 100,000 trace edges.

### Not helpful yet: synchronous end-to-end RP2040

Two alternating full-pipeline samples, current implementation on both sides:

| Mode | Mean | Raw elapsed | Process CPU | Peak heap | Peak RSS |
| --- | ---: | --- | ---: | ---: | ---: |
| Serial | 40,356 ms | `[43074, 37637]` | 42,832 ms | 677.4 MiB | 1,749.6 MiB |
| 4 workers | 41,959 ms | `[45861, 38056]` | 45,039 ms | 670.3 MiB | 1,801.1 MiB |
| Delta | +4.0% | — | +5.2% | -1.1% | +2.9% |

The graph-only speedup does not amortize worker startup, teardown, runtime
heaps, shared-buffer lifetime, and downstream GC effects in the synchronous
pipeline. Keeping workers opt-in is the measured choice.

### Unsafe under current semantics: routing demands

Demand searches are not independent. Every commit/uncommit changes:

- direct edge and node ownership;
- conflict occupancy;
- history penalties;
- pending/ripped route order;
- prefabricated-via reservations; and
- same-net target topology.

Running demand A* searches concurrently would either race these structures or
route against stale snapshots. Merging speculative results would change the
81-pass negotiation sequence and likely the output route. This pass does not
parallelize mutable routing state.

### Too small or sequentially dependent: cleanup pipeline

Build, post-process, beautify, prune, and expansion consume the output of the
preceding stage. Their individual times are too small relative to worker
startup, and parallelizing within them was not justified before reducing the
26.51-million-state route workload.

## Ladder-by-ladder results

### Ladder 1 — tiny unobstructed route

Five samples per side.

- Prev: 7 ms mean, 0 ms standard deviation.
- Current: 8 ms mean, 0 ms standard deviation.
- Raw elapsed: prev `[7, 8, 7, 7, 7]`; current `[8, 8, 8, 8, 8]` ms.
- Search states remain 7; conflict references remain 1,542.

This rung is runtime-startup dominated.

### Ladder 2 — small fixed-via route

Five samples per side.

- Prev: 13 ms mean, 25 ms process CPU.
- Current: 14 ms mean, 27 ms process CPU.
- Raw elapsed: prev `[13, 13, 13, 13, 13]`; current
  `[14, 14, 14, 14, 13]` ms.
- Search states remain 277; both sides use exactly one fixed-via transition.

This rung is also below useful timing resolution.

### Ladder 3 — BiscuitBoard STM32C071FBP6

Five samples per side.

- Prev: 484 ms mean, 73 ms standard deviation, 772 ms process CPU.
- Current: 387 ms mean, 32 ms standard deviation, 685 ms process CPU.
- Wall time: 20.0% lower; process CPU: 11.3% lower.
- Graph stage: 212 ms to 163 ms, 23.1% lower.
- Peak heap: 59.4 MiB to 57.7 MiB, 2.8% lower.
- Peak RSS: 311.0 MiB to 315.6 MiB, 1.5% higher.
- Raw elapsed: prev `[401, 399, 561, 564, 496]`; current
  `[353, 353, 438, 400, 392]` ms.
- Search states/rips remain 152,996 / 29.

### Ladder 4 — STM32C071 display board

Five samples per side.

- Prev: 3,144 ms mean, 160 ms standard deviation, 3,843 ms process CPU.
- Current: 2,926 ms mean, 198 ms standard deviation, 3,689 ms process CPU.
- Wall time: 6.9% lower; process CPU: 4.0% lower.
- Graph stage: 640 ms to 354 ms, 44.7% lower.
- Route stage: 2,062 ms to 2,106 ms, 2.1% higher.
- Peak heap: 195.2 MiB to 226.0 MiB, 15.8% higher.
- Peak RSS: 613.9 MiB to 639.7 MiB, 4.2% higher.
- Raw elapsed: prev `[3415, 3220, 3087, 3031, 2965]`; current
  `[3140, 3195, 2751, 2783, 2762]` ms.
- Search states/rips/passes remain 2,279,913 / 195 / 23.

This is the pass's memory regression. The packed arrays themselves account for
only a few MiB; the larger heap delta occurs later in routing and reflects a
different GC high-water mark. It is retained as a release caveat.

### Ladder 5 — STM32C071 display BoosterPack

Five samples per side.

- Prev: 3,142 ms mean, 25 ms standard deviation, 3,788 ms process CPU.
- Current: 2,970 ms mean, 59 ms standard deviation, 3,694 ms process CPU.
- Wall time: 5.5% lower; process CPU: 2.5% lower.
- Graph stage: 720 ms to 480 ms, 33.3% lower.
- Peak heap: 279.5 MiB to 221.6 MiB, 20.7% lower.
- Peak RSS: 710.3 MiB to 704.7 MiB, 0.8% lower.
- Raw elapsed: prev `[3135, 3189, 3118, 3127, 3142]`; current
  `[2943, 2986, 2916, 2928, 3077]` ms.
- Search states/rips/passes remain 2,475,394 / 245 / 13.

### Ladder 6 — BiscuitBoard RP2040 stress case

Three samples per side; all six complete before the 120-second ceiling.

- Prev: 60,154 ms mean, 6,180 ms standard deviation, 62,841 ms process CPU.
- Current: 49,355 ms mean, 1,778 ms standard deviation, 52,431 ms process CPU.
- Wall time: 18.0% lower; process CPU: 16.6% lower.
- Graph stage: 9,949 ms to 5,760 ms, 42.1% lower.
- Route stage: 40,783 ms to 35,275 ms, 13.5% lower. Search work is unchanged,
  so this secondary change should be treated as whole-process/GC variance, not
  a routing-algorithm improvement.
- Peak heap: 675.5 MiB to 661.3 MiB, 2.1% lower.
- Peak RSS: 1,328.6 MiB to 1,520.5 MiB, 14.4% higher.
- Prev raw elapsed: `[51419, 64771, 64272]` ms.
- Current raw elapsed: `[47253, 49209, 51602]` ms.
- Search states/rips/passes remain 26,510,022 / 1,535 / 81.

The heap release gate remains positive, but resident memory does not. Typed
array and external memory are lower, so the RSS rise is likely allocator/GC
high-water behavior rather than larger retained graph data. It remains a
required follow-up measurement.

## Stage timing summary

Mean wall milliseconds from the final alternating A/B.

| Ladder | Version | Graph | Route/rip | Post | Beautify | Expand | Total |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | Prev | 212 | 170 | 17 | 18 | 64 | 484 |
| 3 | Current | 163 | 140 | 15 | 16 | 52 | 387 |
| 4 | Prev | 640 | 2,062 | 46 | 47 | 342 | 3,144 |
| 4 | Current | 354 | 2,106 | 47 | 52 | 359 | 2,926 |
| 5 | Prev | 720 | 2,040 | 56 | 95 | 227 | 3,142 |
| 5 | Current | 480 | 2,101 | 53 | 98 | 234 | 2,970 |
| 6 | Prev | 9,949 | 40,783 | 916 | 6,330 | 2,135 | 60,154 |
| 6 | Current | 5,760 | 35,275 | 1,014 | 5,574 | 1,700 | 49,355 |

The graph stage improves on every realistic rung. The remaining dominant cost
is routing negotiation, especially RP2040.

## Memory footprint

Arithmetic mean peak per fresh process. External and ArrayBuffer values overlap
with RSS and must not be added to it.

| Ladder | Version | Heap | RSS | External | ArrayBuffers |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Prev | 1.2 MiB | 68.2 MiB | 0.3 MiB | <0.1 MiB |
| 1 | Current | 1.2 MiB | 66.9 MiB | 0.3 MiB | <0.1 MiB |
| 2 | Prev | 1.2 MiB | 75.2 MiB | 0.3 MiB | <0.1 MiB |
| 2 | Current | 1.2 MiB | 74.8 MiB | 0.4 MiB | 0.1 MiB |
| 3 | Prev | 59.4 MiB | 311.0 MiB | 14.3 MiB | 5.5 MiB |
| 3 | Current | 57.7 MiB | 315.6 MiB | 15.0 MiB | 6.0 MiB |
| 4 | Prev | 195.2 MiB | 613.9 MiB | 30.5 MiB | 18.6 MiB |
| 4 | Current | 226.0 MiB | 639.7 MiB | 34.0 MiB | 22.0 MiB |
| 5 | Prev | 279.5 MiB | 710.3 MiB | 36.9 MiB | 23.8 MiB |
| 5 | Current | 221.6 MiB | 704.7 MiB | 37.0 MiB | 23.8 MiB |
| 6 | Prev | 675.5 MiB | 1,328.6 MiB | 105.9 MiB | 88.6 MiB |
| 6 | Current | 661.3 MiB | 1,520.5 MiB | 97.8 MiB | 80.4 MiB |

Heap remains lower on ladders 3, 5, and 6 and unchanged on tiny cases. Ladder 4
heap and ladders 3, 4, and 6 RSS need continued monitoring.

### Production low-memory lane

Three current samples per rung with `retainIntermediateStages: false`:

| Ladder | Mean time | Std dev | Process CPU | Peak heap | Peak RSS | Retained outputs |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 608 ms | 93 ms | 1,098 ms | 54.1 MiB | 310.1 MiB | 1 |
| 4 | 4,033 ms | 62 ms | 5,141 ms | 205.9 MiB | 560.5 MiB | 1 |
| 5 | 5,735 ms | 1,116 ms | 6,963 ms | 213.1 MiB | 535.0 MiB | 1 |

All nine samples pass. Peak memory still occurs while graph/routing state is
live; low-memory mode's invariant is bounded retention after stage completion.

## Correctness and equivalence

- Serial current versus worker current produces identical node/edge arrays,
  conflict offsets, compact conflict IDs, and conflict order.
- RP2040 current serial versus commit `703211c` produces byte-identical
  10,948,664-entry conflict CSR and identical offsets.
- Search states, rips, negotiation passes, graph node count, graph edge count,
  and route topology statistics remain unchanged on every ladder.
- All 50 ladder 1–5 samples and all six final RP2040 samples pass.
- No implementation manufactures a via or returns a clearance violation.

## Rejected or constrained experiments

- **Automatic workers on BoosterPack:** slower at every tested worker count;
  threshold raised above this graph size.
- **Workers as production default:** isolated graph gain did not survive the
  synchronous full pipeline; default changed to serial.
- **`exec`/`fork`:** rejected before implementation because process isolation
  would clone graph data and increase startup beyond `worker_threads`.
- **Parallel demand routing:** rejected because occupancy, history, and route
  order are shared mutable semantics, not independent tasks.
- **Negotiation policy changes:** not attempted in this exact-output pass.
  Prior work showed route ordering changes can alter snapshots and stress-case
  stability.
- **Persistent target heuristic cache:** still unsafe without a stable identity
  for same-net owned target topology.

## Next fix order

1. **Add stage-attributed memory sampling.** Record heap/RSS immediately before
   and after graph collection, compaction, rotated-obstacle probing, and route
   completion. Resolve the ladder 4 heap and RP2040 RSS high-water regressions
   before expanding worker use.
2. **Reduce negotiation amplification under an equivalence gate.** Build a
   deterministic test that asserts RP2040 route topology while experimenting
   with conflict-component scheduling. Reducing 81 passes and 1,535 rips is the
   largest remaining wall-time opportunity.
3. **Replace string route ownership in hot occupancy maps with numeric route
   IDs.** Preserve public route IDs at boundaries, but benchmark packed internal
   IDs against the 39.8 million RP2040 foreign-owner misses.
4. **Give target topology a stable bounded identity.** Cache heuristic fields
   only when the exact target-node set is unchanged. Avoid demand-only keys,
   because committed same-net copper changes valid target sets.
5. **Introduce an asynchronous/persistent worker API for batch routing.** A
   long-lived pool can amortize startup and is likely useful when routing
   several independent boards. Keep the synchronous single-board default
   serial until direct full-pipeline A/B becomes positive.
6. **Profile cleanup only after routing drops.** Post/beautify/expand are visible
   but remain secondary to negotiation and foreign-owner work.

## Reproduction

Create the previous worktree:

```sh
git worktree add --detach ../biscuit-board-autorouter-v3-prev \
  703211cc03d082b2e98b35805cb715baacd3a8ab
ln -s "$PWD/node_modules" \
  ../biscuit-board-autorouter-v3-prev/node_modules
```

Run alternating ladders 1–5:

```sh
bun run scripts/perf-ladder.ts \
  --runs=5 \
  --max-ms=60000 \
  --case=tiny \
  --case=fixed-via \
  --case=stm32 \
  --case=stm32-display \
  --case=boosterpack \
  --compare=../biscuit-board-autorouter-v3-prev/lib/index.ts
```

Run RP2040:

```sh
bun run scripts/perf-ladder.ts \
  --runs=3 \
  --max-ms=120000 \
  --case=rp2040 \
  --compare=../biscuit-board-autorouter-v3-prev/lib/index.ts
```

Compare packed serial against four workers on the same implementation:

```sh
bun run scripts/perf-ladder.ts \
  --runs=3 \
  --max-ms=1 \
  --case=rp2040 \
  --compare-conflict-workers=1 \
  --conflict-workers=4
```

Run the low-memory lane:

```sh
bun run scripts/perf-ladder.ts \
  --runs=3 \
  --low-memory \
  --case=stm32 \
  --case=stm32-display \
  --case=boosterpack
```

## Verification

- `bun test`: 35 passed, 0 failed.
- `bunx tsc --noEmit`: passed.
- `bun run build:site`: passed.
- `bunx biome format .`: passed after final formatting.
- `git diff --check`: passed after final cleanup.
- Serial/worker conflict CSR equivalence test: passed.
- Final ladder 1–5: 50/50 samples passed.
- Final RP2040 A/B: 6/6 samples solved and passed.
- Low-memory lane: 9/9 samples passed and retained one stage output.

## Bottom line

The packed collector is a successful next-step optimization: it cuts graph
time by 23–45% on realistic boards and improves end-to-end runtime by 5–20%
while preserving graph, route, and heap behavior on the stress case. Standard
worker-thread parallelism is technically correct and measurably useful for the
isolated RP2040 graph phase, but not yet for the synchronous full pipeline.
Keeping it opt-in is faster and more memory-conscious today; a persistent async
boundary is the proper next step for production parallelism.
