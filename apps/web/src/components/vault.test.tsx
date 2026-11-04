// @vitest-environment jsdom
import type { Channel, VaultSecret } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/vaultApi", () => ({
  vaultApi: { list: vi.fn(), create: vi.fn(), reveal: vi.fn(), remove: vi.fn() },
}));

import { configureTasksApi, TasksApiError } from "../lib/tasksApi";
import { vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { useVault } from "../store/vault";
import { VaultSecretCard } from "./VaultSecretCard";
import { VaultView } from "./VaultView";

const api = vi.mocked(vaultApi);
const ME = { userId: "u-ana", email: "ana@example.com", role: "member" as const };
const channel = (channelId: string, name: string, members?: string[]): Channel => ({
  channelId,
  name,
  type: members ? "private" : "public",
  createdBy: "u-ana",
  createdAt: 1,
  archived: false,
  ...(members && { members }),
});
const aws: VaultSecret = {
  secretId: "vs_01JBAAAAAAAAAAAAAAAAAAAAAA",
  channelId: "ch_infra",
  name: "AWS root",
  username: "root@mindfultech.ec",
  website: "https://console.aws.amazon.com/",
  createdBy: "u-ana",
  createdByName: "Ana",
  createdAt: 2,
};
const figma: VaultSecret = {
  secretId: "vs_01JBBBBBBBBBBBBBBBBBBBBBBB",
  channelId: "ch_general",
  name: "Figma",
  createdBy: "u-bob",
  createdByName: "Bob",
  createdAt: 1,
};

beforeEach(() => {
  configureTasksApi("https://api.fake.example");
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })),
  );
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  useChat.setState({
    me: ME,
    toast: null,
    channels: [channel("ch_general", "general"), channel("ch_infra", "infra", ["u-ana"])],
  });
  useVault.setState({ status: "idle", secrets: [], error: null });
  api.list.mockResolvedValue([aws, figma]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const rows = () => screen.queryAllByRole("row").filter((r) => r.hasAttribute("data-vault-row"));

describe("the Vault dashboard", () => {
  it("lists names, projects and usernames, with every password hidden", async () => {
    render(<VaultView />);
    expect(screen.getByRole("heading", { name: "Vault" })).toBeTruthy();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const first = rows()[0]!;
    expect(within(first).getByText("AWS root")).toBeTruthy();
    expect(within(first).getByText("#infra")).toBeTruthy();
    expect(within(first).getByText("root@mindfultech.ec")).toBeTruthy();
    expect(within(first).getByLabelText("Hidden password").textContent).toBe("••••••••••");
    expect(document.body.textContent).not.toMatch(/hunter/);
    // Only what's yours (or an admin) can be deleted.
    expect(within(first).queryByRole("button", { name: "Delete AWS root" })).toBeTruthy();
    expect(within(rows()[1]!).queryByRole("button", { name: "Delete Figma" })).toBeNull();
    expect(api.reveal).not.toHaveBeenCalled();
  });

  it("searches and filters by project", async () => {
    render(<VaultView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.change(screen.getByRole("textbox", { name: "Search the Vault" }), {
      target: { value: "figma" },
    });
    expect(rows().map((r) => r.getAttribute("data-vault-row"))).toEqual([figma.secretId]);
    fireEvent.change(screen.getByRole("textbox", { name: "Search the Vault" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by project" }), {
      target: { value: "ch_infra" },
    });
    expect(rows().map((r) => r.getAttribute("data-vault-row"))).toEqual([aws.secretId]);
  });

  it("reveals a password from the server and hides it again after 30 seconds", async () => {
    api.reveal.mockResolvedValue("Tr0ub4dor&3");
    render(<VaultView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(
        within(rows()[0]!).getByRole("button", { name: "Reveal the AWS root password" }),
      );
    });
    expect(api.reveal).toHaveBeenCalledWith(aws.secretId);
    expect(within(rows()[0]!).getByLabelText("AWS root password").textContent).toBe("Tr0ub4dor&3");
    act(() => vi.advanceTimersByTime(30_000));
    expect(within(rows()[0]!).getByLabelText("Hidden password")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Tr0ub4dor");
  });

  it("copies through the desktop app's clipboard when it's there", async () => {
    api.reveal.mockResolvedValue("Tr0ub4dor&3");
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    render(<VaultView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await act(async () => {
      fireEvent.click(
        within(rows()[0]!).getByRole("button", { name: "Copy the AWS root password" }),
      );
    });
    expect(invoke).toHaveBeenCalledWith("copy_secret", {
      text: "Tr0ub4dor&3",
      clearAfterSecs: 30,
    });
    expect(useChat.getState().toast?.message).toMatch(/cleared from the clipboard in 30 s/);
    // Copying doesn't show it.
    expect(within(rows()[0]!).getByLabelText("Hidden password")).toBeTruthy();
  });

  it("creates a secret with a generated password, in the chosen channel", async () => {
    api.create.mockImplementation(async (input) => ({
      secret: { ...aws, secretId: "vs_01JBCCCCCCCCCCCCCCCCCCCCCC", name: input.name },
      shared: false,
    }));
    render(<VaultView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Create Secret/ }));
    fireEvent.change(document.querySelector("[data-vault-name]")!, {
      target: { value: "Grafana admin" },
    });
    fireEvent.change(document.querySelector("[data-vault-website]")!, {
      target: { value: "javascript:alert(1)" },
    });
    const save = document.querySelector("[data-vault-save]") as HTMLButtonElement;
    fireEvent.click(document.querySelector("[data-vault-generate]")!);
    const password = (document.querySelector("[data-vault-password]") as HTMLInputElement).value;
    expect(password).toHaveLength(24);
    expect(save.disabled).toBe(true); // the website isn't http(s)
    fireEvent.change(document.querySelector("[data-vault-website]")!, {
      target: { value: "grafana.mindfultech.ec" },
    });
    fireEvent.change(document.querySelector("[data-vault-channel]")!, {
      target: { value: "ch_infra" },
    });
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    expect(api.create).toHaveBeenCalledWith({
      channelId: "ch_infra",
      name: "Grafana admin",
      password,
      website: "grafana.mindfultech.ec",
    });
    await waitFor(() => expect(rows()).toHaveLength(3));
  });
});

describe("the 🔒 card in the chat", () => {
  it("shows the name, never the password, and reveals it on request", async () => {
    api.reveal.mockResolvedValue("sk_live_123");
    render(
      <VaultSecretCard
        card={{ secretId: aws.secretId, name: "Stripe", username: "billing" }}
        mine={false}
      />,
    );
    expect(screen.getByText("🔒 Shared a Secret")).toBeTruthy();
    expect(screen.getByText("Stripe")).toBeTruthy();
    expect(screen.getByLabelText("Hidden password")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reveal the Stripe password" }));
    });
    expect(screen.getByLabelText("Stripe password").textContent).toBe("sk_live_123");
  });

  it("tells someone outside the channel it's not shared with them", async () => {
    api.reveal.mockRejectedValue(new TasksApiError(404, "Secret not found"));
    render(<VaultSecretCard card={{ secretId: aws.secretId, name: "Stripe" }} mine={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reveal the Stripe password" }));
    });
    expect(useChat.getState().toast?.message).toBe(
      "This secret was deleted, or it's not shared with you.",
    );
    expect(screen.getByLabelText("Hidden password")).toBeTruthy();
  });
});
