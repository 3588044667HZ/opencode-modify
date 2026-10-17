import { Calculator } from "./core.js";
import { format } from "@lib/util";

function main() {
  const calculator = new Calculator();
  console.log(format(calculator.add(1, 2)));
}

main();
