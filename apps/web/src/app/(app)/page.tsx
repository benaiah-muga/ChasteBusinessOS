import { ChatConsole } from "./chat-console";

export default function ConsolePage() {
  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Console</h1>
      <p className="mb-6 text-sm text-neutral-500">
        Work alongside your agent. Everything it does goes through the same governed path as you —
        approvals land in the inbox, everything lands in the ledger.
      </p>
      <ChatConsole />
    </div>
  );
}
