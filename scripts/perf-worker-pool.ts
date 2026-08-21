import type { SimpleRouteJson } from "@tscircuit/core";
import { BiscuitBoardAutorouter } from "../lib/biscuit-board-autorouter";
import { BiscuitBoardWorkerPool } from "../lib/biscuit-board-worker-pool";
import stm32Input from "../repros/fixtures/repro01-biscuit-board-stm32.srj.json";

const getPositiveInteger = (name: string, fallback: number) => {
  const argument = process.argv.find((value) => value.startsWith(`${name}=`));
  const value = Number(argument?.slice(name.length + 1) ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const runCount = getPositiveInteger("--runs", 3);
const boardCount = getPositiveInteger("--boards", 4);
const poolSize = getPositiveInteger("--pool-size", 2);
const input = stm32Input as SimpleRouteJson;
const inputs = Array.from({ length: boardCount }, () => input);

const validate = (
  outputs: Awaited<ReturnType<BiscuitBoardWorkerPool["routeMany"]>>,
) => {
  if (
    outputs.length !== boardCount ||
    outputs.some((traces) => traces.length !== 17)
  ) {
    throw new Error("worker-pool benchmark returned an invalid trace count");
  }
};

const runSequential = () => {
  const startedAt = performance.now();
  const outputs = inputs.map((board) =>
    new BiscuitBoardAutorouter(board).solveSync(),
  );
  validate(outputs);
  return Math.round(performance.now() - startedAt);
};

const pool = new BiscuitBoardWorkerPool({ size: poolSize });
try {
  validate(await pool.routeMany(inputs));
  const sequentialMs: number[] = [];
  const pooledMs: number[] = [];
  for (let runIndex = 0; runIndex < runCount; runIndex++) {
    const order =
      runIndex % 2 === 0
        ? (["sequential", "pooled"] as const)
        : (["pooled", "sequential"] as const);
    for (const mode of order) {
      if (mode === "sequential") sequentialMs.push(runSequential());
      else {
        const startedAt = performance.now();
        validate(await pool.routeMany(inputs));
        pooledMs.push(Math.round(performance.now() - startedAt));
      }
    }
  }
  const mean = (values: number[]) =>
    Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  console.log(
    JSON.stringify(
      {
        runCount,
        boardCount,
        poolSize,
        sequential: { meanMs: mean(sequentialMs), rawMs: sequentialMs },
        pooled: { meanMs: mean(pooledMs), rawMs: pooledMs },
      },
      null,
      2,
    ),
  );
} finally {
  await pool.close();
}
