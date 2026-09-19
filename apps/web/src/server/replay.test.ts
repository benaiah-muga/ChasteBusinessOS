import { describe, expect, it } from "vitest";
import { replayTrajectory } from "@chaste/kernel";

describe("true trajectory replay", () => {
  it("rebuilds stored tool observations without an executor or model", () => {
    const trace = replayTrajectory([
      { seq: 1, role: "user", content: { text: "How many customers?" } },
      { seq: 2, role: "tool_call", content: { name: "crm_listCustomers", args: {} } },
      { seq: 3, role: "tool", content: { name: "crm_listCustomers", result: '{"count":1}' } },
      { seq: 4, role: "assistant", content: { text: "There is one customer." } },
    ]);

    expect(trace.eventCount).toBe(4);
    expect(trace.observations).toEqual([
      { seq: 3, name: "crm_listCustomers", result: '{"count":1}' },
    ]);
    expect(trace.messages[2]).toEqual({
      role: "tool",
      content: '{"count":1}',
      toolCallId: "replay-2",
    });
    expect(trace.finalMessage).toBe("There is one customer.");
  });

  it("rejects corrupt ordering instead of inventing a trajectory", () => {
    expect(() =>
      replayTrajectory([
        { seq: 2, role: "user", content: { text: "first" } },
        { seq: 2, role: "assistant", content: { text: "duplicate" } },
      ]),
    ).toThrow("strictly increasing");
  });
});

console.log("TRUE-REPLAY-OK");
