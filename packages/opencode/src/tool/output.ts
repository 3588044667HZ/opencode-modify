import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const DESCRIPTION = `Display a message to the user without performing any action.

Use this when you want to show a progress update, intermediate result, or question while continuing to work. This tool does not read files, run commands, or change anything; it only prints the provided text to the user.`

export const Parameters = Schema.Struct({
  text: Schema.String.annotate({
    description: "The message to display to the user",
  }),
  title: Schema.optional(
    Schema.String.annotate({
      description: "Optional short heading shown above the message",
    }),
  ),
})

type Metadata = {
  text: string
  title?: string
}

export const OutputTool = Tool.define<typeof Parameters, Metadata, never>(
  "output",
  Effect.sync(() => ({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>) => {
      const text = params.text.trim()
      if (!text) throw new Error("output text must not be empty")
      return Effect.succeed({
        title: params.title ?? "Output",
        output: text,
        metadata: {
          text,
          ...(params.title === undefined ? {} : { title: params.title }),
        },
      })
    },
  })),
)
