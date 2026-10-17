import { Calculator } from "./core.js";

const app = express();

function handleCalc(req, res) {
  const calculator = new Calculator();
  res.send(String(calculator.add(1, 2)));
}

app.get("/calc", handleCalc);
