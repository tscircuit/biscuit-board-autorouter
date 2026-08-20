# Biscuit-board autorouter performance findings

Date: 2026-08-20

## Executive summary

The optimization work substantially reduced memory on every non-trivial board. Average peak RSS fell by 27% on ladder 3, 74% on ladder 4, 30% on ladder 5, and 50% on the RP2040 stress case. Average reported JavaScript heap fell by 35%, 74%, 26%, and 82% respectively.

The timing result is not a clean speedup result. In this run, ladders 1–5 were slower in the optimized worktree, while ladder 6 was effectively tied but timeout-censored. The host was concurrently running unrelated `tsci build`, `tsci dev`, and browser-renderer processes using several CPU cores and multiple gigabytes of memory. The prev and now batches were not simultaneous, and host load increased during the now batch. Wall-clock changes therefore combine implementation behavior with uncontrolled host contention. Process CPU time moved in the same direction on ladders 1–5, so the slowdown must still be treated as a real signal to investigate—not dismissed as pure noise.

The strongest defensible conclusion from this run is:

- Memory improvements are large and consistent on realistic workloads.
- Routing output remained correct for every run that completed.
- Runtime improvement is not demonstrated by this benchmark session.
- `route-with-rip-and-replace` remains the primary runtime bottleneck, especially once negotiation starts.
- RP2040 remains beyond the reliable 90-second envelope under load: prev solved 1/3 runs and now solved 1/3 runs.

## Comparison definition

- **Prev:** clean commit `d7893ebe4c25c9318371d35108d528efc2f3a2ca` (`test: add stepper stray trace repro (#24)`).
- **Now:** the current uncommitted optimization worktree at the time of measurement.
- Both implementations used the same fixture inputs, Bun runtime, dependency installation, options, correctness checks, and fresh-process harness.
- The benchmark calls `BiscuitBoardRoutingPipelineSolver` directly. It retains intermediate stages by default for introspection on both sides. Production `BiscuitBoardAutorouter` now sets `retainIntermediateStages: false`, so production post-stage retention should be lower than this benchmark shows; peak routing-stage memory may not change.

## Methodology

Each sample ran in a fresh Bun process. The parent process loaded either the prev worktree's `lib/index.ts` or the current worktree's `lib/index.ts`. This prevents caches, solver state, and garbage from one sample carrying into the next.

Repetition policy:

- Ladders 1–5: 5 prev samples and 5 now samples each.
- Ladder 6: 3 prev samples and 3 now samples, with a 90,000 ms ceiling per sample.
- Reported central value: arithmetic mean, as requested.
- Variability: population standard deviation for elapsed time, plus raw sample arrays.

Every completed sample was required to satisfy all of the following:

- Solver reports solved and not failed.
- Output trace count equals prepared demand count.
- No manufactured vias are present.
- No trace-clearance violations are present.

Memory definitions:

- **Peak heap:** maximum sampled `process.memoryUsage().heapUsed`; this is logical JavaScript heap and can include paged-out memory.
- **Peak RSS:** maximum sampled resident set size; this is the best single measure here of physical process footprint.
- Samples are taken at most every 50 ms and once at completion. Very short ladders can finish between samples, so RSS is more informative than heap for ladders 1–2.
- Heap and RSS peaks may occur at different instants and must not be added together.

Environment:

- Apple M5, arm64, 16 GiB RAM
- macOS 26.5.1 (25F80)
- Bun 1.3.14
- Node 26.7.0 (recorded for environment completeness; benchmark executed with Bun)

Host-load warning: during measurement, unrelated processes included browser renderers at roughly 1.4–2.8 CPU cores, `tsci build` near one core with up to about 3.7 GB RSS, and another `tsci dev`/build workload. These processes were user-owned and were not terminated.

## Overall ladder results

Times are mean elapsed milliseconds. Memory is mean peak MiB per isolated process. Delta is `(now / prev - 1) × 100`; negative memory deltas are improvements.

| Ladder | Samples/side | Prev time | Now time | Time delta | Prev heap | Now heap | Heap delta | Prev RSS | Now RSS | RSS delta | Completion |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 5 | 8 ms | 20 ms | +150.0% | 1.2 MiB | 1.3 MiB | +9.7% | 69.6 MiB | 67.0 MiB | -3.8% | 5/5 both |
| 2 | 5 | 14 ms | 33 ms | +135.7% | 1.2 MiB | 1.2 MiB | -1.2% | 78.1 MiB | 76.0 MiB | -2.7% | 5/5 both |
| 3 | 5 | 693 ms | 1,216 ms | +75.5% | 108.8 MiB | 71.2 MiB | -34.6% | 391.5 MiB | 287.5 MiB | -26.6% | 5/5 both |
| 4 | 5 | 4,570 ms | 12,235 ms | +167.7% | 915.8 MiB | 234.7 MiB | -74.4% | 1,837.6 MiB | 476.7 MiB | -74.1% | 5/5 both |
| 5 | 5 | 6,217 ms | 10,445 ms | +68.0% | 413.3 MiB | 307.3 MiB | -25.6% | 899.7 MiB | 633.8 MiB | -29.5% | 5/5 both |
| 6 | 3 | 83,674 ms* | 86,667 ms* | +3.6%* | 3,919.4 MiB | 692.0 MiB | -82.3% | 2,837.4 MiB | 1,411.8 MiB | -50.2% | 1/3 both |

`*` Ladder 6 means are right-censored by two 90-second timeouts on each side. They are resource-consumption means up to completion/cutoff, not valid average time-to-solution values.

## Stage-level timing

Stage values are arithmetic mean wall milliseconds. Values are rounded independently, so rows may not sum exactly to total elapsed time.

| Ladder | Version | Graph | Route/rip | Post-process | Beautify | Prune | Expand | Total |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Prev | 4 | 2 | 1 | 0 | 0 | 1 | 8 |
| 1 | Now | 10 | 4 | 2 | 1 | 1 | 2 | 20 |
| 2 | Prev | 6 | 3 | 1 | 1 | 1 | 1 | 14 |
| 2 | Now | 16 | 7 | 4 | 2 | 1 | 3 | 33 |
| 3 | Prev | 374 | 210 | 24 | 25 | 1 | 57 | 693 |
| 3 | Now | 550 | 460 | 37 | 37 | 3 | 126 | 1,216 |
| 4 | Prev | 919 | 2,974 | 77 | 73 | 16 | 507 | 4,570 |
| 4 | Now | 2,201 | 8,502 | 191 | 189 | 18 | 1,116 | 12,235 |
| 5 | Prev | 1,480 | 4,091 | 118 | 184 | 4 | 335 | 6,217 |
| 5 | Now | 1,776 | 7,669 | 130 | 254 | 5 | 599 | 10,445 |
| 6 | Prev* | 14,223 | 63,480 | 681 | 3,950 | 148 | 1,166 | 83,674 |
| 6 | Now* | 12,718 | 69,843 | 508 | 2,848 | 6 | 715 | 86,667 |

For the realistic completed workloads, routing dominates as complexity rises: 38% of now time on ladder 3, 69% on ladder 4, and 73% on ladder 5. Graph generation is the next major contributor. Cleanup spatial indexing has reduced its algorithmic risk, but cleanup is not the main end-to-end limiter in these fixtures.

## Ladder 1 — Tiny unobstructed route

Workload: 1 connection, 2 obstacles, 1 expected trace, single layer.

| Metric | Prev | Now |
| --- | ---: | ---: |
| Mean elapsed | 8 ms | 20 ms |
| Elapsed standard deviation | 0 ms | 3 ms |
| Mean process CPU | 16 ms | 33 ms |
| Mean peak heap | 1.2 MiB | 1.3 MiB |
| Mean peak RSS | 69.6 MiB | 67.0 MiB |
| Search states | 7 | 7 |
| Correct runs | 5/5 | 5/5 |

Interpretation: startup, module loading, JIT, and measurement granularity dominate. The absolute 12 ms difference is not useful for architectural decisions. This rung is primarily a correctness and fixed-overhead guard.

Raw elapsed samples: prev `[8, 8, 8, 8, 8]`; now `[24, 17, 18, 19, 22]` ms.

## Ladder 2 — Small fixed-via route

Workload: 1 connection, 4 obstacles, 1 expected trace, fixed-via transition required.

| Metric | Prev | Now |
| --- | ---: | ---: |
| Mean elapsed | 14 ms | 33 ms |
| Elapsed standard deviation | 0 ms | 2 ms |
| Mean process CPU | 31 ms | 65 ms |
| Mean peak heap | 1.2 MiB | 1.2 MiB |
| Mean peak RSS | 78.1 MiB | 76.0 MiB |
| Search states | 277 | 277 |
| Fixed-via transitions | 1 | 1 |
| Correct runs | 5/5 | 5/5 |

Interpretation: still dominated by fixed process and graph setup cost. The rung confirms that the compact conflict representation and caches preserve fixed-via behavior.

Raw elapsed samples: prev `[14, 14, 13, 14, 14]`; now `[32, 32, 31, 38, 33]` ms.

## Ladder 3 — BiscuitBoard STM32C071FBP6

Workload: 9 connections, 100 obstacles, 17 expected traces, 18,477 graph nodes, 36,324 graph edges.

| Metric | Prev | Now | Delta |
| --- | ---: | ---: | ---: |
| Mean elapsed | 693 ms | 1,216 ms | +75.5% |
| Elapsed standard deviation | 14 ms | 60 ms | — |
| Mean process CPU | 1,155 ms | 1,775 ms | +53.7% |
| Mean peak heap | 108.8 MiB | 71.2 MiB | -34.6% |
| Mean peak RSS | 391.5 MiB | 287.5 MiB | -26.6% |
| Expanded states | 152,996 | 152,996 | unchanged |
| Rips | 29 | 29 | unchanged |
| Correct runs | 5/5 | 5/5 | unchanged |

Interpretation: work-count invariants are identical, so the timing difference is not caused by a changed route or extra search states. Memory reduction is clear. A clean single-purpose host rerun is needed to separate data-structure access cost from host contention.

Raw elapsed samples: prev `[720, 678, 685, 695, 688]`; now `[1166, 1183, 1154, 1303, 1273]` ms.

## Ladder 4 — STM32C071 display board

Workload: 17 connections, 119 obstacles, 33 expected traces, 25,449 graph nodes, 49,149 graph edges.

| Metric | Prev | Now | Delta |
| --- | ---: | ---: | ---: |
| Mean elapsed | 4,570 ms | 12,235 ms | +167.7% |
| Elapsed standard deviation | 241 ms | 2,121 ms | — |
| Mean process CPU | 6,189 ms | 13,205 ms | +113.4% |
| Mean peak heap | 915.8 MiB | 234.7 MiB | -74.4% |
| Mean peak RSS | 1,837.6 MiB | 476.7 MiB | -74.1% |
| Expanded states | 2,279,913 | 2,279,913 | unchanged |
| Rips / negotiation passes | 195 / 23 | 195 / 23 | unchanged |
| Correct runs | 5/5 | 5/5 | unchanged |

Interpretation: this is the clearest memory win. Prev memory was highly unstable—individual RSS peaks ranged from 776.7 MiB to 2,634.9 MiB—while now ranged from 428.2 MiB to 580.3 MiB. The much tighter footprint is consistent with replacing per-edge conflict arrays and unbounded cache retention. Timing variability is also high and the now batch coincided with increased external load.

Raw elapsed samples: prev `[4242, 4859, 4771, 4339, 4641]`; now `[9812, 12552, 15385, 13453, 9975]` ms.

## Ladder 5 — STM32C071 display BoosterPack

Workload: 15 connections, 157 obstacles, 34 expected traces, 38,292 graph nodes, 75,254 graph edges.

| Metric | Prev | Now | Delta |
| --- | ---: | ---: | ---: |
| Mean elapsed | 6,217 ms | 10,445 ms | +68.0% |
| Elapsed standard deviation | 1,879 ms | 3,122 ms | — |
| Mean process CPU | 7,767 ms | 11,417 ms | +47.0% |
| Mean peak heap | 413.3 MiB | 307.3 MiB | -25.6% |
| Mean peak RSS | 899.7 MiB | 633.8 MiB | -29.5% |
| Expanded states | 2,475,394 | 2,475,394 | unchanged |
| Rips / negotiation passes | 245 / 13 | 245 / 13 | unchanged |
| Correct runs | 5/5 | 5/5 | unchanged |

Interpretation: the route path accounts for nearly three-quarters of now elapsed time. Memory improves and search work remains identical, but the measured route traversal cost per expanded state is higher in this session.

Raw elapsed samples: prev `[5171, 5001, 5123, 5865, 9926]`; now `[15946, 10556, 7418, 10882, 7425]` ms.

## Ladder 6 — BiscuitBoard RP2040 stress case

Workload: 35 connections, 215 obstacles, 97 expected traces, 64,862 graph nodes, 123,997 graph edges. Each sample had a 90-second ceiling.

| Metric | Prev | Now | Delta |
| --- | ---: | ---: | ---: |
| Mean elapsed to completion/cutoff | 83,674 ms | 86,667 ms | +3.6% |
| Elapsed standard deviation | 9,351 ms | 4,713 ms | — |
| Mean process CPU | 91,196 ms | 89,580 ms | -1.8% |
| Mean peak heap | 3,919.4 MiB | 692.0 MiB | -82.3% |
| Mean peak RSS | 2,837.4 MiB | 1,411.8 MiB | -50.2% |
| Completed correctly | 1/3 | 1/3 | unchanged |
| Timed out | 2/3 | 2/3 | unchanged |

Interpretation: elapsed means cannot compare solution speed because four runs were capped. Memory is still highly informative: now held reported heap around 688–696 MiB across all samples, whereas prev ranged from 2.0–5.1 GiB. Now RSS ranged from 1.17–1.87 GiB; prev ranged from 1.72–3.99 GiB. The completed now run required 26.51 million expanded states, 1,535 rips, and 81 negotiation passes. That negotiation amplification is the remaining scalability wall.

Raw elapsed samples: prev `[90001 timeout, 90568 timeout, 70454 solved]`; now `[80002 solved, 90000 timeout, 90000 timeout]` ms.

## Per-sample memory footprint

All values are peak MiB for one fresh worker process. This table includes every measured sample rather than only the averages.

| Ladder | Prev heap samples | Now heap samples | Prev RSS samples | Now RSS samples |
| ---: | --- | --- | --- | --- |
| 1 | 1.2, 1.2, 1.2, 1.2, 1.2 | 1.2, 1.8, 1.1, 1.2, 1.2 | 69.5, 68.9, 71.3, 69.2, 69.3 | 67.7, 65.9, 66.9, 67.9, 66.7 |
| 2 | 1.2, 1.2, 1.2, 1.2, 1.2 | 1.2, 1.1, 1.2, 1.2, 1.2 | 78.4, 77.7, 78.2, 77.5, 78.6 | 76.7, 77.0, 75.9, 75.1, 75.5 |
| 3 | 119.8, 103.7, 110.9, 110.8, 98.8 | 75.5, 71.1, 69.7, 69.2, 70.3 | 406.1, 380.1, 400.2, 400.4, 370.6 | 305.2, 295.3, 279.5, 284.3, 273.2 |
| 4 | 297.7, 1255.4, 1273.1, 429.4, 1323.1 | 255.2, 246.6, 243.1, 210.8, 217.8 | 776.7, 2301.1, 2521.5, 953.8, 2634.9 | 428.2, 480.0, 429.3, 465.9, 580.3 |
| 5 | 544.6, 331.9, 390.8, 425.9, 373.3 | 308.0, 294.3, 315.3, 301.7, 317.5 | 1076.9, 876.4, 944.0, 847.9, 753.1 | 483.2, 668.1, 731.4, 662.0, 624.5 |
| 6 | 4659.0, 2006.7, 5092.6 | 696.1, 687.8, 691.9 | 1719.1, 2805.6, 3987.5 | 1874.9, 1165.4, 1195.0 |

The strongest memory behavior is not merely a lower average: the now heap is much more bounded on ladders 4 and 6. That directly addresses stale retained state and workload-proportional object proliferation.

## What changed and what the data says

### 1. Compact conflict graph storage

Per-edge `conflictEdgeIds` arrays were replaced on the hot routing path by compressed sparse row storage: one `Uint32Array` of offsets and one flat `Uint32Array` of conflict edge IDs. Conflict-pair construction is chunked instead of retaining a large nested object graph.

Observed effect: this is the most plausible primary contributor to the 74% heap/RSS reduction on ladder 4 and 82% heap reduction on ladder 6. The report does not isolate this change from the other memory changes, so attribution is architectural rather than a single-variable benchmark.

### 2. Bounded routing caches

Demand allowance caches now use graph-sized direct-mapped typed buffers. Foreign-owner lookups use generation-tagged edge slots rather than stale maps surviving across searches. High-water statistics expose active search nodes, open heap size, and foreign-owner cache occupancy.

Observed effect: now heap remains tightly bounded across repeated dense-board samples. RP2040 now reported a maximum foreign-owner cache occupancy of 113,800 entries rather than allowing cache history to grow with negotiation attempts.

### 3. Spatial indexes for cleanup geometry

Post-processing obstacle, segment-clearance, and trace-segment queries use a static uniform-grid spatial hash with generation-based duplicate suppression. This removes repeated whole-board scans from geometric cleanup.

Observed effect: cleanup is no longer the dominant stage. On ladder 5, post-process plus beautify is 384 ms against 7,669 ms in routing. On ladder 6's partial averages, post-process and beautify are lower now than prev, although timeout censoring prevents a strict comparison.

### 4. Intermediate-stage release

The public autorouter wrapper disables retention of obsolete pipeline stages. Direct pipeline users can opt in with `retainIntermediateStages: false`; the benchmark intentionally retained stages on both sides so it could inspect prepared problems and preserve A/B equivalence.

Observed effect: not directly measured by this ladder configuration. It should reduce post-stage retained memory in production, but it does not eliminate the peak while graph/routing data is actively needed.

### 5. Copy and queue cleanup

Low-value spreads, full-array copies, `shift`, and `unshift` operations were removed from hot loops where semantics allowed. Remaining spread syntax is mostly object construction, intentional deduplication, output cloning, visualization, or cold-path work; eliminating syntax without proving allocation cost would risk correctness for little gain.

Observed effect: not independently measurable in this combined A/B. Ladders 1–2 show that fixed overhead is not improved in the current run.

### 6. Rejected experiments

- Typed A* state storage was measured slower and reverted.
- Object pooling was measured slower and reverted.
- Escalating congestion history changed routing behavior and destabilized RP2040, so it was reverted.

These reversions are important: lower allocation count alone is not sufficient if it worsens locality, adds indirection, or changes search behavior.

## Remaining pitfalls, in fix order

1. **Establish a controlled timing baseline.** Run the same harness on an otherwise idle host, alternate prev/now per sample, and pin Bun and dependencies. Do not claim a speedup until this is green. The present report is suitable for memory conclusions and bottleneck location, not release-grade timing claims.
2. **Profile `route-with-rip-and-replace` per expanded state.** Ladders 3–5 perform identical search work but now take more route time in this session. Compare conflict-neighbor iteration, owner lookup, allowance-cache hit rate, blocker insertion, and heap operations with sampling profiles. This should precede more structural changes.
3. **Reduce negotiation amplification.** RP2040's completed now run expands 26.51 million states over 81 passes and 1,535 rips. Better route selection, conflict-component scheduling, or bounded selective rerouting will matter more than micro-optimizing cleanup.
4. **Measure cache effectiveness, not only size.** Add hit/miss counters for node allowance, edge allowance, target heuristic, and foreign owners. A bounded cache that misses frequently can trade memory for repeated CPU work; current high-water counters do not answer that question.
5. **Separate graph-build subphases.** Instrument coordinate generation, obstacle indexing, edge construction, conflict candidate generation, and CSR compaction. Graph generation regressed in the loaded-host run, but the current aggregate timer cannot identify which subphase is responsible.
6. **Benchmark production low-memory mode separately.** Add a second ladder lane using `BiscuitBoardAutorouter` or `retainIntermediateStages: false`, with correctness validation performed incrementally before prepared state is released. This will quantify retained memory after each stage rather than only process peak.
7. **Add allocation/GC telemetry.** RSS and heap peaks show the outcome but not allocation churn. Collect Bun heap snapshots or runtime GC traces on ladders 4–6, especially around conflict construction and negotiation resets.
8. **Keep spreads evidence-driven.** Continue removing array spreads only where they clone large/hot collections. Object spreads in output construction and small fixed collections are not automatically performance bugs.

## Reproduction

Create the prev worktree and share the existing dependency installation:

```sh
git worktree add --detach ../biscuit-board-autorouter-prev-perf d7893ebe4c25c9318371d35108d528efc2f3a2ca
ln -s "$PWD/node_modules" ../biscuit-board-autorouter-prev-perf/node_modules
```

Run ladders 1–5 five times against prev and now:

```sh
bun run scripts/perf-ladder.ts --runs=5 --max-ms=60000 \
  --case=tiny --case=fixed-via --case=stm32 \
  --case=stm32-display --case=boosterpack \
  --implementation=../biscuit-board-autorouter-prev-perf/lib/index.ts

bun run scripts/perf-ladder.ts --runs=5 --max-ms=60000 \
  --case=tiny --case=fixed-via --case=stm32 \
  --case=stm32-display --case=boosterpack
```

Run the stress case three times:

```sh
bun run scripts/perf-ladder.ts --runs=3 --max-ms=90000 \
  --case=rp2040 \
  --implementation=../biscuit-board-autorouter-prev-perf/lib/index.ts

bun run scripts/perf-ladder.ts --runs=3 --max-ms=90000 --case=rp2040
```

The harness outputs raw samples and arithmetic averages for elapsed time, process CPU, peak heap, peak RSS, heap/RSS growth, and each pipeline stage. A run only passes when its route output also passes the correctness invariants listed above.

## Bottom line

The optimization series has solved the most dangerous memory-growth problem: dense workloads now have much lower and more stable heap/RSS footprints. It has not yet proven an end-to-end speedup. The next performance work should be a controlled profile of route traversal and cache hit rates, followed by reducing RP2040 negotiation passes; more broad allocation rewrites would be premature.
