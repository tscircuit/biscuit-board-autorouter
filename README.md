# biscuit-board-autorouter

Pipeline7 autorouting followed by collision-aware prefabricated-via attraction
for tscircuit biscuit boards.

**[Open the live Cosmos solver debugger](https://biscuit-board-autorouter.vercel.app)**

## Usage

```tsx
import { createBiscuitBoardAutorouter } from "@tscircuit/biscuit-board-autorouter"

<board
  width="75mm"
  height="55mm"
  autorouter={createBiscuitBoardAutorouter()}
>
  {/* components, assignable prefabricated vias, and traces */}
</board>
```

The exported `BiscuitBoardAutorouter` implements tscircuit's
`GenericLocalAutorouter` interface for direct use and testing.

## Pipeline

1. `Pipeline7Solver` runs `AutoroutingPipelineSolver7_MultiGraph` from
   [`@tscircuit/capacity-autorouter`](https://github.com/tscircuit/tscircuit-autorouter).
2. `PrefabricatedViaPostprocessingSolver` assigns every Pipeline7 via to an
   unused compatible Simple Route JSON obstacle marked `netIsAssignable`.
3. Each via is attracted to its assigned prefabricated coordinate. Its two
   adjacent trace legs behave like rubber bands; a visibility graph uses
   expanded pad corners and perpendicular trace-repulsion sites to push the
   copper around obstacles and foreign traces.
4. The output validator rejects any via that does not land on an assigned
   prefabricated coordinate.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the algorithm and invariants.

## Development

```sh
bun install
bun run dev
bun run build
bun run test
bun run format:check
bun run build:site
```

The repository follows the
[`tscircuit/handbook` solver bootstrap](https://github.com/tscircuit/handbook/blob/main/guides/bootstrapping-repos.md):
Cosmos, `GenericSolverDebugger`, `graphics-debug`, SVG matching, a staged
solver-utils pipeline, and CI for tests, types, and formatting.
