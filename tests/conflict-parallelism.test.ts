import { expect, test } from "bun:test";
import { generateBiscuitBoardHypergraph } from "../lib";
import { forcedPrefabricatedViaFixture } from "./fixtures/forced-prefabricated-via";

test("worker conflict collection is identical to serial collection", () => {
  const serial = generateBiscuitBoardHypergraph(forcedPrefabricatedViaFixture, {
    conflictWorkerCount: 1,
  });
  const parallel = generateBiscuitBoardHypergraph(
    forcedPrefabricatedViaFixture,
    { conflictWorkerCount: 2 },
  );

  expect(parallel.nodes).toEqual(serial.nodes);
  expect(parallel.edges).toEqual(serial.edges);
  expect(Array.from(parallel.conflictOffsets ?? [])).toEqual(
    Array.from(serial.conflictOffsets ?? []),
  );
  expect(Array.from(parallel.compactConflictEdgeIds ?? [])).toEqual(
    Array.from(serial.compactConflictEdgeIds ?? []),
  );
});
