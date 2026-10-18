import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatDock } from "./ChatDock";
import { resetChat } from "../chat-store";

const encoder = new TextEncoder();

interface ControlledStream {
  response: Response;
  push: (line: string) => void;
  close: () => void;
}

function controlledStream(): ControlledStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  return {
    response: new Response(stream, { status: 200, headers: { "x-session-id": "00000000-0000-4000-8000-000000000001" } }),
    push: (line) => controller.enqueue(encoder.encode(line)),
    close: () => controller.close(),
  };
}

function harness(options: { steer?: () => Response } = {}) {
  const streams: ControlledStream[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/chat/steer") return options.steer ? options.steer() : Response.json({ queued: true });
    const stream = controlledStream();
    streams.push(stream);
    return stream.response;
  }));
  return { streams };
}

async function finish(stream: ControlledStream, reply: string) {
  stream.push(`{"type":"done","sessionId":"00000000-0000-4000-8000-000000000001","reply":"${reply}"}\n`);
  stream.close();
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop" })).toBeNull());
}

beforeEach(() => {
  resetChat();
  window.history.replaceState(null, "", "/projects");
});

afterEach(() => {
  cleanup();
  resetChat();
  vi.unstubAllGlobals();
});

describe("ChatDock", () => {
  it("does not render on the chat page itself", () => {
    render(<ChatDock pathname="/chat" />);
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("expands from the bubble into the panel and offers the full page", async () => {
    render(<ChatDock pathname="/projects" />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));

    const dialog = await screen.findByRole("dialog", { name: "Chat with your workmate" });
    expect(dialog).not.toBeNull();
    expect(screen.getByText(/Hi, I'm your business workmate/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open the full chat page" }));
    expect(window.location.pathname).toBe("/chat");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("streams, shows live status, and keeps the transcript across minimize and reopen", async () => {
    const { streams } = harness();
    render(<ChatDock pathname="/projects" />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));

    const textarea = await screen.findByLabelText("Message your workmate");
    fireEvent.change(textarea, { target: { value: "Any overdue invoices?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(streams).toHaveLength(1));

    streams[0]!.push('{"type":"step","step":1,"maxSteps":8}\n');
    streams[0]!.push('{"type":"tool","name":"accounting.aging"}\n');
    expect(await screen.findByText("Step 1/8 · aging")).not.toBeNull();

    await finish(streams[0]!, "Two invoices are overdue.");
    expect(screen.getByText("Two invoices are overdue.")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close chat" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(await screen.findByText("Two invoices are overdue.")).not.toBeNull();
    expect(screen.getByText("Any overdue invoices?")).not.toBeNull();
  });

  it("shows a steered bubble while the run is still streaming", async () => {
    const { streams } = harness();
    render(<ChatDock pathname="/projects" />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));

    const textarea = await screen.findByLabelText("Message your workmate");
    fireEvent.change(textarea, { target: { value: "First." } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(streams).toHaveLength(1));

    fireEvent.change(textarea, { target: { value: "Also this." } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(await screen.findByText("Also this.")).not.toBeNull();
    expect(screen.getByText("steered into the running turn")).not.toBeNull();

    await finish(streams[0]!, "Noted.");
  });

  it("shows the fallback queue chips with remove buttons when steering is refused", async () => {
    const { streams } = harness({ steer: () => Response.json({ error: "session not found" }, { status: 404 }) });
    render(<ChatDock pathname="/projects" />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));

    const textarea = await screen.findByLabelText("Message your workmate");
    fireEvent.change(textarea, { target: { value: "First." } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(streams).toHaveLength(1));

    fireEvent.change(textarea, { target: { value: "Queued instead." } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(await screen.findByText("queued")).not.toBeNull();
    expect(screen.getByText("Queued instead.")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove queued message: Queued instead." }));
    await waitFor(() => expect(screen.queryByText("Queued instead.")).toBeNull());

    await finish(streams[0]!, "Done.");
  });
});
