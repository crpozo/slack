// @vitest-environment jsdom
import type { TeamMember } from "@mindfultech/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/teamApi", () => ({
  teamApi: { list: vi.fn(), invite: vi.fn(), setRole: vi.fn() },
}));
import { chat } from "../lib/chat";
import { teamApi } from "../lib/teamApi";
import { useChat } from "../store";
import { AdminPanel } from "./AdminPanel";
import { SettingsModal } from "./SettingsModal";

const api = vi.mocked(teamApi);
const member = (patch: Partial<TeamMember>): TeamMember => ({
  userId: "u-ana",
  email: "ana@mt.ec",
  displayName: "Ana",
  role: "member",
  status: "active",
  createdAt: 1,
  ...patch,
});
const ME = { userId: "u-carlos", email: "carlos@mt.ec", role: "admin" as const };

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  useChat.getState().setSession(ME, []);
  api.list.mockResolvedValue([
    member({ userId: ME.userId, email: ME.email, displayName: "Carlos", role: "admin" }),
    member({}),
    member({ userId: "u-guest", email: "c@acme.com", displayName: "Client", role: "guest" }),
  ]);
  vi.spyOn(chat, "refreshUsers").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Settings → Team (Phase 62)", () => {
  it("only admins see it", () => {
    render(<SettingsModal onClose={() => {}} />);
    expect(document.querySelector("[data-admin-section]")).not.toBeNull();
    cleanup();
    useChat.getState().setSession({ ...ME, role: "member" }, []);
    render(<SettingsModal onClose={() => {}} />);
    expect(document.querySelector("[data-admin-section]")).toBeNull();
  });

  it("lists everyone with role and status; your own and guests' roles can't be changed here", async () => {
    render(<AdminPanel onClose={() => {}} />);
    await screen.findByText("Ana");
    expect(screen.getByRole("combobox", { name: "Role of Ana" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Role of Carlos" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Role of Client" })).toBeNull();
    const guestRow = document.querySelector('[data-member="u-guest"]') as HTMLElement;
    expect(within(guestRow).getByText("Guest")).toBeTruthy();
  });

  it("invites by email as Staff or Admin and refreshes the directory", async () => {
    api.invite.mockResolvedValue(
      member({
        userId: "u-luis",
        email: "luis@mt.ec",
        displayName: "Luis",
        role: "admin",
        status: "invited",
      }),
    );
    render(<AdminPanel onClose={() => {}} />);
    await screen.findByText("Ana");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "luis@mt.ec" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Luis" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await screen.findByText("Luis");
    expect(api.invite).toHaveBeenCalledWith({
      email: "luis@mt.ec",
      displayName: "Luis",
      role: "admin",
    });
    const row = document.querySelector('[data-member="u-luis"]') as HTMLElement;
    expect(within(row).getByText("Invited")).toBeTruthy();
    expect(chat.refreshUsers).toHaveBeenCalled();
  });

  it("shows why an invitation failed", async () => {
    api.invite.mockRejectedValue(new Error("ana@mt.ec already has an account"));
    render(<AdminPanel onClose={() => {}} />);
    await screen.findByText("Ana");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ana@mt.ec" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already has an account/);
  });

  it("moves someone from Staff to Admin", async () => {
    api.setRole.mockResolvedValue(member({ role: "admin" }));
    render(<AdminPanel onClose={() => {}} />);
    fireEvent.change(await screen.findByRole("combobox", { name: "Role of Ana" }), {
      target: { value: "admin" },
    });
    await waitFor(() => expect(api.setRole).toHaveBeenCalledWith("u-ana", "admin"));
    await waitFor(() =>
      expect(
        (screen.getByRole("combobox", { name: "Role of Ana" }) as HTMLSelectElement).value,
      ).toBe("admin"),
    );
  });
});
