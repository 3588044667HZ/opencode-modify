import { Calculator } from "../src/core.js";

test("add", () => {
  const calculator = new Calculator();
  expect(calculator.add(1, 2)).toBe(3);
});
