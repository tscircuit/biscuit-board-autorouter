# Architecture

## Why this is a post-processor

Pipeline7 is responsible for the hard global problem: topology planning,
capacity routing, high-density routing, exact-geometry DRC repair, and final
trace construction. A prefabricated board adds a narrower manufacturing
constraint after that solve: layer transitions may only use holes that already
exist in the copper clad.

`BiscuitBoardRoutingPipelineSolver` therefore has two visible stages:

1. `Pipeline7Solver` adapts `AutoroutingPipelineSolver7_MultiGraph` to the
   standard solver-utils interface without hiding Pipeline7's progress,
   preview, or graphics-debug output. Assignable prefab vias are hardened for
   this stage, preventing the unassigned global route from crossing them.
2. `PrefabricatedViaPostprocessingSolver` attracts Pipeline7's vias onto the
   board's assignable prefabricated vias and relaxes the attached copper.

## Via attraction and assignment

Prefabricated vias are the multi-layer Simple Route JSON obstacles marked
`netIsAssignable: true`. A via can only be assigned to a target supporting its
`from_layer` and `to_layer`, and a target is reserved by at most one routed net.
Pipeline7 vias are processed by distance to their nearest compatible target.
For each via, candidate targets are tried nearest-first and accepted only when
the moved legs and global collision pass produce a valid route. If no reachable
compatible target remains, the solver fails rather than emitting a
manufacturing via.

## Trace repulsion

Moving a via changes the two wire legs adjacent to the layer transition. A
straight pull can cross a pad or another trace, so each leg is rebuilt on a
small visibility graph:

- pad and via rectangles are expanded by trace half-width plus clearance;
- rectangle corners become obstacle-repulsion sites;
- foreign trace endpoints are offset along tangent and normal directions to
  create trace-repulsion sites around their clearance capsules;
- only mutually visible sites are connected;
- Dijkstra chooses the shortest collision-free rubber-band path; and
- an A* grid search handles winding channels that the sparse visibility graph
  cannot express.

If the moving leg and a foreign trace still conflict, the global collision pass
tries pushing either segment through the same visibility/grid search. This
preserves the Pipeline7 route outside the affected neighborhoods. The selected
prefabricated via is excluded from blocking geometry for its own net; all other
unused prefabricated vias remain obstacles.

## Output invariant

After all relaxations, every Pipeline7 via is checked against the set of
assigned prefabricated coordinates. Each is then emitted as a zero-length
`route_type: "through_obstacle"` layer transition, allowing tscircuit core to
claim the existing assignable PCB via without creating duplicate copper. A
missing target, unreachable relaxation, or unresolved crossing is a hard solver
failure. There is no fallback that silently keeps Pipeline7's arbitrary via.
