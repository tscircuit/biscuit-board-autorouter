# Architecture

## Why graph generation is a pipeline stage

The search problem is only useful if its topology represents the copper that
can actually be fabricated. A generic multilayer autorouter can discover a
good path and then place a via wherever it needs one; a biscuit board cannot.

The generator therefore derives coordinates from:

- connection terminals;
- prefabricated via centers;
- clearance-expanded obstacle sides; and
- the board bounds.

It takes the Cartesian intersections of those coordinates on each copper
layer and connects neighboring visible sites. This makes narrow corridors and
obstacle corners explicit. A coarse regular lattice adds parallel channels in
wide free-space regions without rasterizing at trace-width resolution. Pad
interiors remain net-restricted. Copper-pour obstacles are left to the pour
stage.

Every multi-layer obstacle with `netIsAssignable: true` gets one site per
declared layer. Only those colocated sites receive cross-layer hyperedges. This
is the primary no-new-vias guarantee.

## Relationship to tiny-hypergraph

The architecture follows the same separation used by
[`tscircuit/tiny-hypergraph`](https://github.com/tscircuit/tiny-hypergraph):
immutable topology, compact incidence data, and mutable route ownership.
Tiny-hypergraph's angle-pair cache avoids repeatedly testing geometry inside a
region. Here, the equivalent hot-loop optimization is a precomputed conflict
list on each trace hyperedge. A* checks route owners through those lists rather
than recomputing segment intersections for every candidate.

Simple Route JSON may express one electrical net as several connections that
share a terminal. The generator coalesces those connections before ownership
checks, so branches may meet at that terminal without entering a rip loop.

The package does not feed the raw Simple Route JSON directly into
tiny-hypergraph because that would leave the hard and board-specific topology
generation problem unsolved. The generated topology is exposed as
`PreparedBiscuitRoutingProblem`, so a future region-based backend can replace
the current search without changing the fixed-via contract.

## Rip-and-replace

Each search state records the distinct committed routes it would cross. A
route may accept a bounded set of blockers at a rip cost. When committed, those
routes are removed and requeued; their old edges receive a history penalty so
the same conflict becomes progressively less attractive. This is a negotiated
congestion loop rather than one-pass greedy routing.

## Output invariant

The topology makes arbitrary layer changes unreachable. The trace builder then
performs a second, independent check: each emitted `route_type: "via"` must
match the coordinate and both layers of a prefabricated via obstacle. A mismatch
throws instead of silently manufacturing copper.
