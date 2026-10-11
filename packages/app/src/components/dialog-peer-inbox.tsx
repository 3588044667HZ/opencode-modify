import { Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { PeerInboxPanel } from "@/components/agent-teams-panels"

export const DialogPeerInbox: Component<{ sessionID: string }> = (props) => {
  const language = useLanguage()

  return (
    <Dialog title={language.t("dialog.peerInbox.title")} description={language.t("dialog.peerInbox.description")}>
      <div class="px-4 pb-3 max-h-[60vh] overflow-y-auto">
        <PeerInboxPanel sessionID={props.sessionID} />
      </div>
    </Dialog>
  )
}
