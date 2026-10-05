// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callApi: vi.fn(),
  postApi: vi.fn(),
  useModuleEnabled: vi.fn(() => true),
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
}));

vi.mock("next/navigation", () => ({ useRouter: mocks.useRouter }));
vi.mock("@/lib/api", () => ({ callApi: mocks.callApi, postApi: mocks.postApi }));
vi.mock("../_shell/module-context", () => ({
  ModuleDisabled: () => null,
  useModuleEnabled: mocks.useModuleEnabled,
}));
vi.mock("../_shell/app-frame", () => ({ AppFrame: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import ProjectsPage from "./page";

const projectId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const taskId = "9b73995f-15a4-49d1-94fd-ef35e2276104";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Next Projects page", () => {
  it("makes archived board task movement and assignment read-only", async () => {
    mocks.callApi.mockImplementation(async (path: string) => {
      if (path === "/api/projects") {
        return { ok: true, data: { projects: [{ id: projectId, name: "Warehouse", status: "archived", dueAt: null, createdAt: "2026-10-01T00:00:00.000Z" }] } };
      }
      if (path === "/api/team") return { ok: true, data: { members: [] } };
      if (path === `/api/projects?projectId=${projectId}`) {
        return { ok: true, data: { columns: [
          { status: "todo", tasks: [{ id: taskId, title: "Count the stock", parentTaskId: null, priority: "medium", assigneeUserId: null, dueAt: null, position: 0 }] },
          { status: "doing", tasks: [] },
          { status: "done", tasks: [] },
        ] } };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    render(<ProjectsPage />);

    const move = await screen.findByLabelText("Move Count the stock") as HTMLSelectElement;
    const assign = screen.getByLabelText("Assign Count the stock") as HTMLSelectElement;
    expect(move.disabled).toBe(true);
    expect(assign.disabled).toBe(true);
    expect(screen.getByText(/board is read-only/i)).not.toBeNull();
    expect(mocks.postApi).not.toHaveBeenCalled();
  });
});
