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
   preview, or graphics-debug output.
2. `PrefabricatedViaPostprocessingSolver` attracts Pipeline7's vias onto the
   board's assignable prefabricated vias and relaxes the attached copper.

## Via attraction and assignment

Prefabricated vias are the multi-layer Simple Route JSON obstacles marked
`netIsAssignable: true`. A via can only be assigned to a target supporting its
`from_layer` and `to_layer`, and a target is reserved by at most one routed net.
The attraction pass repeatedly takes the shortest remaining compatible
via-to-target pair. If no compatible target remains, the solver fails rather
than emitting a manufacturing via.

## Trace repulsion

Moving a via changes the two wire legs adjacent to the layer transition. A
straight pull can cross a pad or another trace, so each leg is rebuilt on a
small visibility graph:

- pad and via rectangles are expanded by trace half-width plus clearance;
- rectangle corners become obstacle-repulsion sites;
- foreign trace endpoints are offset along tangent and normal directions to
  create trace-repulsion sites around their clearance capsules;
- only mutually visible sites are connected; and
- Dijkstra chooses the shortest collision-free rubber-band path.

This preserves the Pipeline7 route outside the local via neighborhood. The
selected prefabricated via is excluded from blocking geometry for its own net;
all other unused prefabricated vias remain obstacles.

## Output invariant

After all local relaxations, every emitted `route_type: "via"` is checked
against the set of assigned prefabricated coordinates. A missing compatible
target or unreachable collision-free relaxation is a hard solver failure.
There is no fallback that silently keeps Pipeline7's arbitrary via.
