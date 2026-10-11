import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010053507_agent_teams",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_message\` (
          \`id\` text PRIMARY KEY,
          \`root_session_id\` text NOT NULL,
          \`from_session_id\` text NOT NULL,
          \`from_agent\` text,
          \`to_session_id\` text NOT NULL,
          \`kind\` text DEFAULT 'note' NOT NULL,
          \`body\` text NOT NULL,
          \`hop\` integer DEFAULT 0 NOT NULL,
          \`reply_to\` text,
          \`status\` text DEFAULT 'delivered' NOT NULL,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_blackboard\` (
          \`root_session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text NOT NULL,
          \`author_session_id\` text,
          \`author_agent\` text,
          \`version\` integer DEFAULT 1 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_blackboard_pk\` PRIMARY KEY(\`root_session_id\`,\`key\`)
        );
      `)
      yield* tx.run(`CREATE INDEX \`idx_agent_message_to\` ON \`agent_message\` (\`to_session_id\`,\`time_created\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
