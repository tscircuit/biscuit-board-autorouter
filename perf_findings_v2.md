# Biscuit-board autorouter performance findings v2

Date: 2026-08-20

## Executive summary

This pass restores measurable runtime gains on top of commit `ed69701` without giving back its reduced heap footprint.

The final benchmark alternated prev and current workers on every repetition, reversing their order each time. On realistic boards, current is 9–19% faster by wall time and 10–18% faster by process CPU time. Average peak heap fell by 6–21%, and average peak RSS fell by 3–15%.

| Ladder | Prev mean | Current mean | Runtime | Prev heap | Current heap | Heap | Prev RSS | Current RSS | RSS |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 8 ms | 8 ms | 0.0% | 1.2 MiB | 1.2 MiB | 0.0% | 68.1 MiB | 69.1 MiB | +1.5% |
| 2 | 15 ms | 14 ms | -6.7% | 1.2 MiB | 1.2 MiB | 0.0% | 76.9 MiB | 75.4 MiB | -1.9% |
| 3 | 551 ms | 480 ms | -12.9% | 71.9 MiB | 56.9 MiB | -20.8% | 320.2 MiB | 311.6 MiB | -2.7% |
| 4 | 4,446 ms | 4,051 ms | -8.9% | 224.6 MiB | 211.8 MiB | -5.7% | 638.8 MiB | 590.5 MiB | -7.6% |
| 5 | 5,754 ms | 4,683 ms | -18.6% | 297.8 MiB | 252.3 MiB | -15.3% | 659.0 MiB | 601.4 MiB | -8.7% |
| 6 | 90,043 ms* | 75,994 ms | -15.6%* | 697.3 MiB | 650.5 MiB | -6.7% | 1,676.4 MiB | 1,424.7 MiB | -15.0% |

`*` One of the three prev RP2040 runs hit the 120-second ceiling. All three current runs completed, so the direction is useful but the prev arithmetic mean remains timeout-censored.

All 50 samples in ladders 1–5 and all three current RP2040 samples passed trace-count, fixed-via, manufactured-via, and clearance checks. Search states, rip counts, negotiation passes, graph nodes, graph edges, and output topology remained unchanged between implementations.

## What “prev” and “current” mean

- **Prev:** commit `ed6970177cd23ebdeddc33bc83b73db244408fc9`, `perf: bound routing memory growth`.
- **Current:** the working tree on top of that commit after this runtime pass.
- Both sides used Bun 1.3.14, the same installed dependencies, the same fixtures and options, and a fresh process for every sample.
- Ladders 1–5 used five samples per implementation.
- Ladder 6 used three samples per implementation and a 120,000 ms ceiling.
- Prev/current execution alternated for each sample; odd repetitions ran prev then current, and even repetitions ran current then prev.

This methodology fixes the largest weakness in v1: host workload can still add noise, but it can no longer place the entire prev batch in one load period and the entire current batch in another.

## Step-by-step execution

1. Established ladder 3 as a fast red/green loop with a 450 ms target and a 90 MB heap ceiling.
2. Captured Bun CPU profiles for ladder 3 and BoosterPack.
3. Added cache hit/miss counters and graph-build subphase counters.
4. Fixed conflict spatial bucketing and measured graph time.
5. Added routing fast paths and typed ownership-presence flags, then measured route time.
6. Tested and rejected alternative owner-array and state-key rewrites when they did not prove faster.
7. Added alternating A/B, low-memory, external-memory, and ArrayBuffer reporting to the ladder.
8. Ran all 34 repository tests, type-checking, formatting, and diff checks.
9. Ran the final repeated A/B ladder and a separate low-memory lane.

## Implemented runtime fixes

### Conflict index uses actual insertion bounds

Before, every segment was inserted into buckets using bounds expanded by the clearance radius, while queries were also expanded. Expanding both sides doubled the broad-phase radius and placed each edge into unnecessary buckets.

Current behavior:

- Insert each segment using its actual bounding box.
- Query using the clearance-expanded bounding box.
- Preserve the same exact `segmentDistance` check and conflict set.
- Skip missing buckets without allocating `[]`.
- Avoid redundant `Map.set` calls for existing buckets.

The generated conflict counts are identical. This is a pure broad-phase reduction, not a geometric approximation.

### Conflict-pair chunk addressing avoids division

The chunk size is a power of two. Pair-list reads and writes now use bit shifts and masks instead of `Math.floor(index / size)` and modulo. The flat CSR output and chunked memory bound are unchanged.

### Ordinary nodes and edges bypass demand caches

The profiler showed allowance-cache calls in every A* edge traversal even though most destinations are non-terminal grid nodes and most edges have no blocking obstacle or guide restriction.

Current behavior:

- Call `nodeAllowsDemand` only for terminal nodes.
- Call `edgeAllowsDemand` only for restricted edges, obstacle-blocked edges, or exact-rotation fallback edges.
- Fixed-via transitions and ordinary trace edges skip cache lookup and geometry work entirely.

On BoosterPack, measured node-allowance cache traffic fell from about 9.72 million calls during diagnosis to 96 thousand calls. Edge-allowance cache traffic fell from about 9.66 million to 339 thousand calls. This preserves the bounded caches but removes work they never needed to perform.

### Typed occupancy-presence flags avoid empty map lookups

Foreign-owner discovery previously performed up to four `Map.get` operations on every cache miss, even when neither endpoint nor edge had an owner and no conflicting copper occupied the edge.

Current behavior maintains three bounded typed arrays:

- node has direct owners;
- edge has direct owners;
- edge has conflict occupancy.

If all flags are zero, owner discovery returns the shared empty result before touching the maps. Flags are updated on commit, uncommit, and seeded-route installation. The arrays cost one byte per indexed node/edge and did not increase measured heap or RSS.

### Empty and singleton foreign-owner results avoid extra work

Owner discovery now returns a shared empty array before allocating a `Set` when no ownership is possible. Empty and singleton results avoid sorting and spread copies. The Set remains for actual multi-owner deduplication because an array-based replacement was benchmarked slower and reverted.

### Single-node target trees stop recursion immediately

Nearest-target kd-tree lookup now returns directly for a leaf. Most route searches have one target on a layer, so this removes recursive null-child calls from a function executed millions of times. The heuristic value remains exactly Euclidean and admissible.

## Ladder-by-ladder results

### Ladder 1 — tiny unobstructed route

Five samples per side.

- Prev: 8 ms mean, 0 ms standard deviation.
- Current: 8 ms mean, 0 ms standard deviation.
- Prev/current search states: 7 / 7.
- Current peak RSS is 1 MiB higher; this rung is dominated by runtime startup and sampling granularity.

Raw elapsed: prev `[8, 8, 9, 8, 8]`; current `[8, 8, 8, 8, 8]` ms.

### Ladder 2 — small fixed-via route

Five samples per side.

- Prev: 15 ms mean, 1 ms standard deviation, 31 ms process CPU.
- Current: 14 ms mean, 1 ms standard deviation, 29 ms process CPU.
- Runtime: 6.7% lower.
- RSS: 76.9 MiB to 75.4 MiB.
- Search states: 277 on both sides; one fixed-via transition on both sides.

Raw elapsed: prev `[16, 15, 14, 14, 14]`; current `[14, 16, 14, 14, 14]` ms.

### Ladder 3 — BiscuitBoard STM32C071FBP6

Five samples per side.

- Prev: 551 ms mean, 9 ms standard deviation, 868 ms process CPU.
- Current: 480 ms mean, 7 ms standard deviation, approximately 777 ms process CPU.
- Runtime: 12.9% lower; process CPU: about 10.5% lower.
- Heap: 71.9 MiB to 56.9 MiB, a 20.8% reduction.
- RSS: 320.2 MiB to 311.6 MiB, a 2.7% reduction.
- Search states: 152,996 on both sides.
- Rips: 29 on both sides.
- Graph: 18,477 nodes, 36,324 edges, and 641,284 conflict references on both sides.

Prev raw elapsed: `[554, 540, 544, 549, 566]` ms.

### Ladder 4 — STM32C071 display board

Five samples per side.

- Prev: 4,446 ms mean, 232 ms standard deviation, 5,503 ms process CPU.
- Current: 4,051 ms mean, 393 ms standard deviation, 4,959 ms process CPU.
- Runtime: 8.9% lower; process CPU: 9.9% lower.
- Heap: 224.6 MiB to 211.8 MiB, a 5.7% reduction.
- RSS: 638.8 MiB to 590.5 MiB, a 7.6% reduction.
- Route stage: 3,228 ms to 2,752 ms, a 14.7% reduction.
- Search states/rips/passes: 2,279,913 / 195 / 23 on both sides.

Raw elapsed: prev `[4615, 4422, 4788, 4253, 4153]`; current `[4606, 3839, 4331, 4007, 3470]` ms.

### Ladder 5 — STM32C071 display BoosterPack

Five samples per side.

- Prev: 5,754 ms mean, 598 ms standard deviation, 6,863 ms process CPU.
- Current: 4,683 ms mean, 488 ms standard deviation, 5,597 ms process CPU.
- Runtime: 18.6% lower; process CPU: 18.4% lower.
- Heap: 297.8 MiB to 252.3 MiB, a 15.3% reduction.
- RSS: 659.0 MiB to 601.4 MiB, an 8.7% reduction.
- Route stage: 3,992 ms to 2,972 ms, a 25.6% reduction.
- Graph stage: 1,130 ms to 1,122 ms.
- Search states/rips/passes: 2,475,394 / 245 / 13 on both sides.

Raw elapsed: prev `[4677, 5591, 6357, 5934, 6210]`; current `[3804, 4551, 5189, 4848, 5024]` ms.

### Ladder 6 — BiscuitBoard RP2040 stress case

Three samples per side with a 120-second ceiling.

- Prev elapsed: `[120803 timeout, 71920 solved, 77406 solved]` ms.
- Current elapsed: `[69947 solved, 100552 solved, 57483 solved]` ms.
- Prev completion: 2/3; current completion: 3/3.
- Prev completion/cutoff mean: 90,043 ms; current solved mean: 75,994 ms.
- Process CPU: 92,662 ms to 76,308 ms, 17.6% lower.
- Heap: 697.3 MiB to 650.5 MiB, 6.7% lower.
- RSS: 1,676.4 MiB to 1,424.7 MiB, 15.0% lower.
- Graph stage: 14,216 ms to 9,700 ms, 31.8% lower.
- Route stage: 66,766 ms to 55,917 ms, 16.2% lower.
- Search states/rips/passes: 26,510,022 / 1,535 / 81 on completed runs, unchanged.

The current implementation turns the stress rung from an intermittent timeout into three completions while using less memory. Negotiation amplification is still the dominant remaining problem; this pass reduced the cost per state/pass without changing route scheduling semantics.

## Stage timing summary

Mean wall milliseconds from the final alternating A/B. Ladder 6 prev includes one timeout-censored run.

| Ladder | Version | Graph | Route/rip | Post | Beautify | Expand | Total |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4 | Prev | 699 | 3,228 | 57 | 57 | 396 | 4,446 |
| 4 | Current | 764 | 2,752 | 57 | 55 | 412 | 4,051 |
| 5 | Prev | 1,130 | 3,992 | 84 | 152 | 389 | 5,754 |
| 5 | Current | 1,122 | 2,972 | 79 | 143 | 361 | 4,683 |
| 6 | Prev* | 14,216 | 66,766 | 812 | 6,361 | 1,838 | 90,043 |
| 6 | Current | 9,700 | 55,917 | 1,160 | 6,513 | 2,651 | 75,994 |

The current graph counters add small measurement overhead. Even with those counters, graph time is flat on BoosterPack and sharply lower on RP2040. The route stage supplies most of the end-to-end improvement.

## Memory footprint

Values are arithmetic mean peak per fresh process. External and ArrayBuffer memory are subsets/related categories reported by Bun and must not be added independently to RSS.

| Ladder | Version | Heap | RSS | External | ArrayBuffers |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Prev | 1.2 MiB | 68.1 MiB | 0.3 MiB | <0.1 MiB |
| 1 | Current | 1.2 MiB | 69.1 MiB | 0.3 MiB | <0.1 MiB |
| 2 | Prev | 1.2 MiB | 76.9 MiB | 0.3 MiB | <0.1 MiB |
| 2 | Current | 1.2 MiB | 75.4 MiB | 0.3 MiB | <0.1 MiB |
| 3 | Prev | 71.9 MiB | 320.2 MiB | 13.7 MiB | 5.5 MiB |
| 3 | Current | 56.9 MiB | 311.6 MiB | 14.7 MiB | 5.5 MiB |
| 4 | Prev | 224.6 MiB | 638.8 MiB | 31.4 MiB | 19.7 MiB |
| 4 | Current | 211.8 MiB | 590.5 MiB | 33.1 MiB | 21.0 MiB |
| 5 | Prev | 297.8 MiB | 659.0 MiB | 36.5 MiB | 23.8 MiB |
| 5 | Current | 252.3 MiB | 601.4 MiB | 36.9 MiB | 23.8 MiB |
| 6 | Prev | 697.3 MiB | 1,676.4 MiB | 109.7 MiB | 92.2 MiB |
| 6 | Current | 650.5 MiB | 1,424.7 MiB | 127.6 MiB | 109.9 MiB |

External/ArrayBuffer peaks rose on some current runs, primarily because more bounded topology state is held in typed arrays and because the samples can peak at different GC points. Total heap and resident footprint—the release gates—both decreased on every realistic rung.

### Production low-memory lane

Three current samples were also run with `--low-memory`:

| Ladder | Mean time | Peak heap | Peak RSS | Retained stage outputs |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 697 ms | 56.2 MiB | 304.4 MiB | 1 |
| 4 | 4,328 ms | 205.3 MiB | 605.5 MiB | 1 |
| 5 | 3,367 ms | 260.8 MiB | 706.3 MiB | 1 |

Peak memory still occurs while graph/routing state is live, so low-memory mode is not expected to reduce every peak. Its verified benefit is retention: only the final pipeline output remains after completion instead of every intermediate solver/output.

## New diagnostic findings

### Graph conflict work

Current graph counters from representative final runs:

| Ladder | Bucket candidates | Exact distance checks | Conflict references | Collection time |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 2,474,073 | 657,450 | 641,284 | 107 ms |
| 4 | 12,632,332 | 3,065,645 | 1,965,032 | 589 ms |
| 5 | 12,291,079 | 3,157,637 | 2,028,696 | 543 ms |
| 6 | 146,995,796 | 30,376,158 | 10,948,664 | 4,786 ms |

RP2040 still performs almost 147 million bucket candidate visits. Actual-bound insertion reduces this cost substantially, but a duplicate-free interval or packed spatial index is the next graph-level opportunity.

### Cache effectiveness after fast-path removal

These counters cover only terminal/blocked/restricted edges after ordinary traversals were removed from the cache path.

| Ladder | Node allowance hit | Edge allowance hit | Foreign-owner hit | Target heuristic hit |
| ---: | ---: | ---: | ---: | ---: |
| 3 | 75.1% | 62.3% | 60.9% | 29.5% |
| 4 | 86.5% | 64.4% | 64.2% | 35.1% |
| 5 | 83.2% | 58.8% | 60.7% | 26.9% |
| 6 | 93.0% | 57.5% | 58.8% | 23.9% |

The target heuristic cache has the lowest hit rate because its generation changes with each search target topology. Persisting it by demand would be semantically unsafe when same-net owned target trees change. The leaf fast path reduces miss cost without retaining stale distances.

## Rejected experiments

- Replacing small foreign-owner Sets with arrays increased elapsed time under the test loop and was reverted.
- Inlining packed A* state-key construction did not produce a reliable improvement and was reverted.
- Smaller conflict buckets increased duplicate bucket visits without reducing exact distance checks and were reverted.
- Larger conflict buckets also increased candidate visits and were reverted.
- A per-layer target-array rewrite was too noisy to prove independently; only the safe kd-tree leaf fast path was retained.
- Negotiation policy, history escalation, and route ordering were not changed. Prior experiments altered snapshots or destabilized RP2040. This pass keeps the exact 26.51-million-state route behavior and makes each state cheaper.

## Remaining bottlenecks and next fix order

1. **Negotiation amplification:** RP2040 still uses 81 passes, 1,535 rips, and 26.51 million states. Any scheduling change needs snapshot-level route equivalence or an explicitly approved route-quality tradeoff.
2. **Conflict broad phase:** RP2040 visits 147 million bucket entries. A duplicate-free packed interval index could reduce graph time without touching route behavior.
3. **Foreign-owner cache misses:** RP2040 computes 39.8 million misses. Presence flags make empty misses cheap; non-empty occupancy filtering remains expensive.
4. **Target heuristic misses:** RP2040 computes 22.3 million misses. A safe cache needs a stable target-topology identity, not just a demand ID.
5. **Expansion/cleanup variance:** these stages are smaller than routing but become visible once route time drops. Profile them only after negotiation work is reduced.

## Reproduction

Create the prev worktree:

```sh
git worktree add --detach ../biscuit-board-autorouter-v2-prev \
  ed6970177cd23ebdeddc33bc83b73db244408fc9
ln -s "$PWD/node_modules" ../biscuit-board-autorouter-v2-prev/node_modules
```

Run an alternating five-sample comparison:

```sh
bun run scripts/perf-ladder.ts \
  --runs=5 \
  --max-ms=60000 \
  --case=tiny \
  --case=fixed-via \
  --case=stm32 \
  --case=stm32-display \
  --case=boosterpack \
  --compare=../biscuit-board-autorouter-v2-prev/lib/index.ts
```

Run RP2040:

```sh
bun run scripts/perf-ladder.ts \
  --runs=3 \
  --max-ms=120000 \
  --case=rp2040 \
  --compare=../biscuit-board-autorouter-v2-prev/lib/index.ts
```

Run production-style retention:

```sh
bun run scripts/perf-ladder.ts --runs=3 --low-memory \
  --case=stm32 --case=stm32-display --case=boosterpack
```

## Verification

- `bun test`: 34 passed, 0 failed.
- `bunx tsc --noEmit`: passed.
- `bunx biome format .`: passed without changes.
- `git diff --check`: passed.
- Final current ladder 1–5: 25/25 samples passed.
- Final current RP2040: 3/3 samples solved and passed all correctness checks.

## Bottom line

The runtime-focused pass improves realistic board throughput while further reducing heap and RSS. The largest gain is BoosterPack routing at 19% end-to-end and 26% in the route stage. RP2040 completes all repeated samples with 18% lower process CPU and 15% lower RSS. The next substantial gain will require reducing negotiation work or replacing the duplicate-heavy conflict broad phase; another round of general-purpose copying or pooling changes is unlikely to move the total meaningfully.
