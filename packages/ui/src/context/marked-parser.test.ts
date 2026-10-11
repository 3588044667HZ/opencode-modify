import { expect, test } from "bun:test"
import { createMarkdownParser } from "./marked-parser"

const parser = createMarkdownParser((code, language) => `<pre data-language="${language}">${code}</pre>`)

test("renders links with application attributes", async () => {
  expect(await parser.parse("[OpenCode](https://opencode.ai)")).toBe(
    '<p><a href="https://opencode.ai" class="external-link" target="_blank" rel="noopener noreferrer">OpenCode</a></p>\n',
  )
})

test("renders inline and block math", async () => {
  expect(await parser.parse("\\(x^2\\)")).toContain('<span class="katex">')
  expect(await parser.parse("$$\nx^2\n$$\n")).toContain('<span class="katex-display">')
})

test("renders inline math delimiters", async () => {
  expect(await parser.parse("\\(x^2\\)")).toContain('<span class="katex">')
  expect(await parser.parse("a $x^2$ b")).toContain('<span class="katex">')
  expect(await parser.parse("\\[x^2\\]")).toContain('<span class="katex">')
})

test("renders display math delimiters", async () => {
  expect(await parser.parse("$$\nx^2\n$$\n")).toContain('<span class="katex-display">')
  expect(await parser.parse("$$x^2$$")).toContain('<span class="katex-display">')
  expect(await parser.parse("\\[\nx^2\n\\]\n")).toContain('<span class="katex-display">')
  expect(await parser.parse("前文 \\[x^2\\] 后文")).toContain('<span class="katex-display">')
})

test("does not render invalid delimiters", async () => {
  expect(await parser.parse("价格 $5 和 $10")).not.toContain("katex")
  expect(await parser.parse("\\$x\\$")).not.toContain("katex")
  expect(await parser.parse("```\n\\[\nx\n\\]\n```\n")).not.toContain("katex")
  expect(await parser.parse("`$x$`")).not.toContain("katex")
})

test("stays safe while a delimiter is still streaming", async () => {
  expect(await parser.parse("\\[")).not.toContain("katex")
  expect(await parser.parse("$$x")).not.toContain("katex")
  expect(await parser.parse("$x")).not.toContain("katex")
})

test("renders real deepseek export samples", async () => {
  expect(
    await parser.parse("\\[\ny(t)=x(t)*h(t)=\\int_{-\\infty}^{\\infty}x(\\tau)h(t-\\tau)\\,d\\tau\n\\]"),
  ).toContain('<span class="katex-display">')

  expect(
    await parser.parse(
      "\\[\n\\begin{bmatrix} 1 & 1 \\\\ 1 & 1 \\end{bmatrix}\n\\underbrace{x(k\\Delta)}_{\\text{面积}=x(k\\Delta)\\Delta}\n\\]",
    ),
  ).toContain('<span class="katex-display">')
})

test("uses the configured code highlighter", async () => {
  expect(await parser.parse("```ts\nconst value = 1\n```\n")).toBe('<pre data-language="ts">const value = 1</pre>\n')
})
