import { useState } from "react";
import { PanelRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../../ui/dialog";
import { useSupportDesk } from "./SupportDeskContext";
import { SupportQueue } from "./SupportQueue";
import { SupportThread } from "./SupportThread";
import { SupportContextPanel } from "./SupportContextPanel";

export function SupportInbox() {
  const desk = useSupportDesk();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const current =
    desk.conversation && desk.conversation.id === desk.selectedId
      ? desk.conversation
      : null;

  return (
    <div
      className="support-inbox"
      data-has-thread={desk.selectedId ? "true" : "false"}
    >
      <SupportQueue />
      <SupportThread onOpenDetails={() => setDetailsOpen(true)} />
      <aside
        className="support-context-aside"
        aria-label="Customer, ticket, and billing context"
      >
        {current ? (
          <SupportContextPanel
            conversation={current}
            messages={desk.messages}
          />
        ) : (
          <div className="support-context-placeholder">
            <PanelRight size={18} aria-hidden="true" />
            <p>
              Choose a conversation to see the customer, ticket, billing, and
              activity context.
            </p>
          </div>
        )}
      </aside>
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="support-context-dialog">
          <DialogTitle>Customer and ticket details</DialogTitle>
          <DialogDescription className="support-sr-only">
            The customer record, ticket fields, billing context, history, and
            activity for the selected conversation.
          </DialogDescription>
          {current ? (
            <SupportContextPanel
              conversation={current}
              messages={desk.messages}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
