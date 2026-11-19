import { Effect, Schema } from "effect"
import * as Tool from "./tool"

const DESCRIPTION = `Send a visible message to the user while continuing to work, without ending your turn.

Use this for progress updates, decisions, warnings, and interim results during long tasks. This tool does not read files, run commands, or change anything; it only displays the provided text to the user. Do not use it for your final answer.`

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

export const TellUserTool = Tool.define<typeof Parameters, Metadata, never>(
  "tell_user",
  Effect.sync(() => ({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>) => {
      const text = params.text.trim()
      if (!text) throw new Error("tell_user text must not be empty")
      return Effect.succeed({
        title: params.title ?? "Message to user",
        output: text,
        metadata: {
          text,
          ...(params.title === undefined ? {} : { title: params.title }),
        },
      })
    },
  })),
)
export const OutputTool = TellUserTool
