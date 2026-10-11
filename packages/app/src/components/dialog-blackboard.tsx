import { Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { BlackboardPanel } from "@/components/agent-teams-panels"

export const DialogBlackboard: Component<{ sessionID: string }> = (props) => {
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.blackboard.title")} description={language.t("dialog.blackboard.description")}>
      <div class="px-4 pb-3 max-h-[60vh] overflow-y-auto">
        <BlackboardPanel sessionID={props.sessionID} />
      </div>
    </Dialog>
  )
}
