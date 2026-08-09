import { expect, test } from "bun:test";
import { obstacleBounds } from "../lib/geometry";

test("obstacle bounds include rotation and clearance", () => {
  const bounds = obstacleBounds(
    {
      center: { x: 10, y: -5 },
      width: 1.2,
      height: 1.8,
      ccwRotationDegrees: 270,
    },
    0.15,
  );

  expect(bounds.minX).toBeCloseTo(8.95);
  expect(bounds.maxX).toBeCloseTo(11.05);
  expect(bounds.minY).toBeCloseTo(-5.75);
  expect(bounds.maxY).toBeCloseTo(-4.25);
});

test("obstacle bounds can preserve the routing graph's unrotated envelope", () => {
  const bounds = obstacleBounds(
    {
      center: { x: 10, y: -5 },
      width: 1.2,
      height: 1.8,
      ccwRotationDegrees: 270,
    },
    0.15,
    false,
  );

  expect(bounds.minX).toBeCloseTo(9.25);
  expect(bounds.maxX).toBeCloseTo(10.75);
  expect(bounds.minY).toBeCloseTo(-6.05);
  expect(bounds.maxY).toBeCloseTo(-3.95);
});
