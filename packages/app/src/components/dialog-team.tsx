import { Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { TeamPanel } from "@/components/agent-teams-panels"

export const DialogTeam: Component<{ sessionID: string }> = (props) => {
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.team.title")} description={language.t("dialog.team.description")}>
      <div class="px-4 pb-3 max-h-[60vh] overflow-y-auto">
        <TeamPanel sessionID={props.sessionID} />
      </div>
    </Dialog>
  )
}
