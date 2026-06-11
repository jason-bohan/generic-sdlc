import { test, expect } from "vitest";

test("cube", () => {
  expect(cube(2)).toBe(8);
  expect(cube(3)).toBe(27);
  expect(cube(4)).toBe(64);
});