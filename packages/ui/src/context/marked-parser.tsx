import katex from "katex"
import { Marked, type MarkedExtension, type Tokens } from "marked"
import markedShiki from "marked-shiki"

export function createMarkdownParser(highlight: (code: string, language: string) => string | Promise<string>) {
  return new Marked(
    {
      renderer: {
        link({ href, title, text }) {
          const titleAttr = title ? ` title="${title}"` : ""
          return `<a href="${href}"${titleAttr} class="external-link" target="_blank" rel="noopener noreferrer">${text}</a>`
        },
      },
    },
    katexExtension,
    markedShiki({ highlight }),
  )
}

const inlineMathRegex = /^\\\(((?:\\.|[^\\\n])*?)\\\)/
const blockMathRegex = /^\$\$\n([\s\S]+?)\n\$\$(?:\n|$)/
const displayBracketRegex = /^\\\[([\s\S]+?)\\\]/
const displayDollarRegex = /^\$\$([\s\S]+?)\$\$/
const inlineDollarRegex = /^\$(?!\$)(?![ \t\n])((?:\\.|[^\\\n$])+?)(?<![ \t\n\\])\$(?!\$)/

// marked 会把后注册的 inline tokenizer 放到尝试队列最前，故 `$` 需先于 `$$` 注册，
// 以保证 `$$` 优先匹配；两者正则互斥只是双保险。
const katexExtension: MarkedExtension = {
  extensions: [
    {
      name: "inlineKatex",
      level: "inline",
      start(src) {
        const index = src.indexOf("\\(")
        if (index === -1) return
        return index
      },
      tokenizer(src) {
        const match = src.match(inlineMathRegex)
        if (!match) return
        return {
          type: "inlineKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: false,
        }
      },
      renderer: renderKatexToken,
    },
    {
      name: "displayBracketKatex",
      level: "inline",
      start(src) {
        const index = src.indexOf("\\[")
        if (index === -1) return
        return index
      },
      tokenizer(src) {
        const match = src.match(displayBracketRegex)
        if (!match) return
        return {
          type: "displayBracketKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: true,
        }
      },
      renderer: renderKatexToken,
    },
    {
      name: "inlineDollarKatex",
      level: "inline",
      start(src) {
        const index = src.indexOf("$")
        if (index === -1) return
        return index
      },
      tokenizer(src) {
        const match = src.match(inlineDollarRegex)
        if (!match) return
        return {
          type: "inlineDollarKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: false,
        }
      },
      renderer: renderKatexToken,
    },
    {
      name: "displayDollarKatex",
      level: "inline",
      start(src) {
        const index = src.indexOf("$$")
        if (index === -1) return
        return index
      },
      tokenizer(src) {
        const match = src.match(displayDollarRegex)
        if (!match) return
        return {
          type: "displayDollarKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: true,
        }
      },
      renderer: renderKatexToken,
    },
    {
      name: "blockKatex",
      level: "block",
      tokenizer(src) {
        const match = src.match(blockMathRegex)
        if (!match) return
        return {
          type: "blockKatex",
          raw: match[0],
          text: match[1].trim(),
          displayMode: true,
        }
      },
      renderer: renderKatexToken,
    },
  ],
}

function renderKatexToken(token: Tokens.Generic) {
  return katex.renderToString(typeof token.text === "string" ? token.text : "", {
    displayMode: token.displayMode === true,
    throwOnError: false,
  })
}
