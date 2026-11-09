// @vitest-environment jsdom
import type { Channel, UserProfile, VaultSecret } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/vaultApi", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/vaultApi")>();
  return {
    ...real,
    vaultApi: {
      pinStatus: vi.fn(),
      setPin: vi.fn(),
      unlock: vi.fn(),
      resetPin: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      reveal: vi.fn(),
      remove: vi.fn(),
    },
  };
});

import { configureTasksApi, TasksApiError } from "../lib/tasksApi";
import { vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { useVault } from "../store/vault";
import { VaultSecretCard } from "./VaultSecretCard";
import { VaultView } from "./VaultView";

const api = vi.mocked(vaultApi);
const ME = { userId: "u-ana", email: "ana@example.com", role: "member" as const };
const SESSION = { token: "tok", expiresAt: Date.now() + 15 * 60_000 };
const user = (userId: string, displayName: string, role?: UserProfile["role"]): UserProfile => ({
  userId,
  email: `${displayName.toLowerCase()}@example.com`,
  displayName,
  updatedAt: 1,
  ...(role && { role }),
});
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
  allowedUserIds: ["u-bob"],
  createdAt: 2,
};
const figma: VaultSecret = {
  secretId: "vs_01JBBBBBBBBBBBBBBBBBBBBBBB",
  channelId: "ch_general",
  name: "Figma",
  createdBy: "u-bob",
  createdByName: "Bob",
  allowedUserIds: ["u-ana"],
  createdAt: 1,
};
const pinError = (status: number, data: Record<string, unknown>) =>
  new TasksApiError(status, String(data.message ?? ""), data);

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
    channels: [channel("ch_general", "general"), channel("ch_infra", "infra", ["u-ana", "u-bob"])],
    users: {
      "u-ana": user("u-ana", "Ana"),
      "u-bob": user("u-bob", "Bob"),
      "u-carl": user("u-carl", "Carl"),
      "u-gus": user("u-gus", "Gus", "guest"),
    },
  });
  useVault.getState().lock();
  api.pinStatus.mockResolvedValue({ hasPin: true, attemptsLeft: 5 });
  api.unlock.mockResolvedValue(SESSION);
  api.list.mockResolvedValue([aws, figma]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const rows = () => screen.queryAllByRole("row").filter((r) => r.hasAttribute("data-vault-row"));
const pinBox = () => screen.getAllByLabelText(/PIN/)[0] as HTMLInputElement;
async function typePin(pin: string, input: HTMLInputElement = pinBox()) {
  await act(async () => {
    fireEvent.change(input, { target: { value: pin } });
  });
}
async function openVault() {
  render(<VaultView />);
  await waitFor(() => expect(document.querySelector("[data-pin-input]")).toBeTruthy());
  await typePin("4821");
  await waitFor(() => expect(rows()).toHaveLength(2));
}

describe("the Vault's lock screen", () => {
  it("shows nothing of the Vault until the PIN is right", async () => {
    api.unlock.mockRejectedValueOnce(
      pinError(401, { code: "PIN_WRONG", attemptsLeft: 4, message: "Wrong PIN. 4 tries left." }),
    );
    render(<VaultView />);
    await waitFor(() => expect(screen.getByText("Enter your Vault PIN")).toBeTruthy());
    expect(rows()).toHaveLength(0);
    expect(api.list).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Create Secret/ })).toBeNull();

    await typePin("1111");
    expect(screen.getByText("Wrong PIN. 4 tries left.")).toBeTruthy();
    expect(rows()).toHaveLength(0);

    await typePin("4821");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.unlock).toHaveBeenLastCalledWith("4821");
    expect(api.list).toHaveBeenCalledWith("tok");
  });

  it("says until when it's locked after too many wrong PINs", async () => {
    const until = Date.now() + 15 * 60_000;
    api.pinStatus.mockResolvedValue({ hasPin: true, lockedUntil: until, attemptsLeft: 0 });
    render(<VaultView />);
    await waitFor(() => expect(screen.getByText(/Too many wrong PINs/)).toBeTruthy());
    expect((document.querySelector("[data-pin-input]") as HTMLInputElement).disabled).toBe(true);
  });

  it("has a first-time visitor choose a PIN twice, refusing an easy one", async () => {
    api.pinStatus.mockResolvedValue({ hasPin: false, attemptsLeft: 5 });
    api.setPin.mockResolvedValue(SESSION);
    render(<VaultView />);
    await waitFor(() => expect(screen.getByText("Create your Vault PIN")).toBeTruthy());
    await typePin("1234");
    expect(screen.getByText(/Too easy to guess/)).toBeTruthy();
    await typePin("4821");
    expect(screen.getByText("Confirm your Vault PIN")).toBeTruthy();
    await typePin("4822");
    expect(screen.getByText(/don't match/)).toBeTruthy();
    await typePin("4821");
    await typePin("4821");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.setPin).toHaveBeenCalledWith("4821");
  });

  it("stays open when you leave and come back; locks with the Lock button and when it runs out", async () => {
    const view = await (async () => {
      const r = render(<VaultView />);
      await waitFor(() => expect(document.querySelector("[data-pin-input]")).toBeTruthy());
      await typePin("4821");
      await waitFor(() => expect(rows()).toHaveLength(2));
      return r;
    })();
    fireEvent.click(screen.getByRole("button", { name: /Lock/ }));
    await waitFor(() => expect(screen.getByText("Enter your Vault PIN")).toBeTruthy());
    expect(useVault.getState().secrets).toEqual([]);
    await typePin("4821");
    await waitFor(() => expect(rows()).toHaveLength(2));
    // Leaving keeps the session: coming back shows the list with no PIN.
    view.unmount();
    expect(useVault.getState().session).toBe(SESSION);
    api.unlock.mockClear();
    render(<VaultView />);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(api.unlock).not.toHaveBeenCalled();
    // A session that ran out locks the Vault by itself.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    act(() => useVault.getState().remember({ token: "t2", expiresAt: Date.now() + 1000 }));
    act(() => vi.advanceTimersByTime(1000));
    expect(useVault.getState()).toMatchObject({ status: "locked", session: null, secrets: [] });
  });
});

describe("the unlocked Vault", () => {
  it("reveals with the open session (no PIN again), and hides the password after 30 s", async () => {
    api.reveal.mockResolvedValue("Tr0ub4dor&3");
    await openVault();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      fireEvent.click(
        within(rows()[0]!).getByRole("button", { name: "Reveal the AWS root password" }),
      );
    });
    expect(document.querySelector("[data-pin-prompt]")).toBeNull();
    expect(api.reveal).toHaveBeenCalledWith(aws.secretId, "tok");
    expect(within(rows()[0]!).getByLabelText("AWS root password").textContent).toBe("Tr0ub4dor&3");
    act(() => vi.advanceTimersByTime(30_000));
    expect(within(rows()[0]!).getByLabelText("Hidden password")).toBeTruthy();
  });

  it("goes back to the lock screen when the server says the session ran out", async () => {
    api.reveal.mockRejectedValue(pinError(401, { code: "VAULT_LOCKED", message: "locked" }));
    await openVault();
    await act(async () => {
      fireEvent.click(
        within(rows()[0]!).getByRole("button", { name: "Copy the AWS root password" }),
      );
    });
    await waitFor(() => expect(screen.getByText("Enter your Vault PIN")).toBeTruthy());
    expect(useVault.getState()).toMatchObject({ status: "locked", session: null, secrets: [] });
  });

  it("copies through the desktop app's clipboard", async () => {
    api.reveal.mockResolvedValue("Tr0ub4dor&3");
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    await openVault();
    await act(async () => {
      fireEvent.click(
        within(rows()[0]!).getByRole("button", { name: "Copy the AWS root password" }),
      );
    });
    expect(invoke).toHaveBeenCalledWith("copy_secret", { text: "Tr0ub4dor&3", clearAfterSecs: 30 });
    expect(within(rows()[0]!).getByLabelText("Hidden password")).toBeTruthy();
  });

  it("shows a Launch button that opens the site outside the app", async () => {
    await openVault();
    const launch = within(rows()[0]!).getByRole("link", { name: /Launch AWS root/ });
    expect(launch.getAttribute("href")).toBe("https://console.aws.amazon.com/");
    expect(launch.getAttribute("target")).toBe("_blank");
    expect(launch.getAttribute("rel")).toBe("noopener noreferrer");
    // Desktop: the opener plugin, not the app's own window.
    const invoke = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("__TAURI__", { core: { invoke } });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    launch.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plugin:opener|open_url", {
        url: "https://console.aws.amazon.com/",
      }),
    );
  });

  it("lets you edit, share and delete every secret shared with you, not only your own", async () => {
    await openVault();
    expect(within(rows()[0]!).queryByRole("button", { name: "Edit AWS root" })).toBeTruthy();
    // Bob saved Figma and shared it with Ana: that makes her a co-admin of it.
    expect(within(rows()[1]!).queryByRole("button", { name: "Edit Figma" })).toBeTruthy();
    expect(within(rows()[1]!).queryByRole("button", { name: /Delete Figma/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Reset a PIN/ })).toBeNull();
  });

  it("edits who can see a secret with the people picker (no guests offered)", async () => {
    api.update.mockImplementation(async (_id, input) => ({
      ...aws,
      allowedUserIds: input.allowedUserIds,
    }));
    await openVault();
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Edit AWS root" }));
    const access = document.querySelector("[data-vault-access]") as HTMLElement;
    const options = within(access).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Bob"),
      expect.stringContaining("Carl"),
    ]);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(options[1]!).getByRole("button"));
    fireEvent.click(within(options[0]!).getByRole("button"));
    expect((document.querySelector("[data-vault-password]") as HTMLInputElement).required).toBe(
      false,
    );
    await act(async () => {
      fireEvent.click(document.querySelector("[data-vault-save]")!);
    });
    expect(api.update).toHaveBeenCalledWith(
      aws.secretId,
      {
        channelId: "ch_infra",
        name: "AWS root",
        username: "root@mindfultech.ec",
        website: "https://console.aws.amazon.com/",
        allowedUserIds: ["u-carl"],
      },
      "tok",
    );
    await waitFor(() => expect(within(rows()[0]!).getByText(/\+1 person/)).toBeTruthy());
  });

  it("creates a secret shared with a channel's members in one click", async () => {
    api.create.mockImplementation(async (input) => ({
      secret: {
        ...aws,
        secretId: "vs_01JBCCCCCCCCCCCCCCCCCCCCCC",
        name: input.name,
        allowedUserIds: input.allowedUserIds ?? [],
      },
      shared: false,
    }));
    await openVault();
    fireEvent.click(screen.getByRole("button", { name: /Create Secret/ }));
    fireEvent.change(document.querySelector("[data-vault-name]")!, {
      target: { value: "Grafana admin" },
    });
    fireEvent.click(document.querySelector("[data-vault-generate]")!);
    const password = (document.querySelector("[data-vault-password]") as HTMLInputElement).value;
    fireEvent.change(document.querySelector("[data-vault-channel]")!, {
      target: { value: "ch_infra" },
    });
    fireEvent.click(document.querySelector("[data-vault-add-channel]")!);
    await act(async () => {
      fireEvent.click(document.querySelector("[data-vault-save]")!);
    });
    expect(api.create).toHaveBeenCalledWith({
      channelId: "ch_infra",
      name: "Grafana admin",
      username: "",
      website: "",
      password,
      allowedUserIds: ["u-bob"],
    });
    await waitFor(() => expect(rows()).toHaveLength(3));
  });

  it("gives admins the PIN reset", async () => {
    useChat.setState({ me: { ...ME, role: "admin" } });
    api.resetPin.mockResolvedValue({ reset: "u-bob" });
    await openVault();
    expect(within(rows()[1]!).queryByRole("button", { name: "Edit Figma" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reset a PIN/ }));
    fireEvent.click(screen.getByRole("button", { name: /Bob/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset Bob's PIN" }));
    });
    expect(api.resetPin).toHaveBeenCalledWith("u-bob");
  });
});

describe("the 🔒 card in the chat", () => {
  it("is one thin row: title, hidden username and password with Reveal and Copy, and Launch", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(
      <VaultSecretCard
        card={{
          secretId: aws.secretId,
          name: "AWS root",
          username: "root@mindfultech.ec",
          website: "https://console.aws.amazon.com/",
        }}
        mine={false}
      />,
    );
    const card = document.querySelector("[data-vault-card]") as HTMLElement;
    expect(card.textContent).toContain("AWS root");
    expect(card.textContent).not.toMatch(/Shared a Secret/); // no bot-style header
    // Both hidden at first.
    expect(screen.getByLabelText("Hidden username").textContent).not.toContain("root@");
    expect(screen.getByLabelText("Hidden password")).toBeTruthy();

    // The username is on the card already: Reveal and Copy need no PIN.
    fireEvent.click(screen.getByRole("button", { name: "Reveal the AWS root username" }));
    expect(screen.getByLabelText("AWS root username").textContent).toBe("root@mindfultech.ec");
    fireEvent.click(screen.getByRole("button", { name: "Hide the username" }));
    expect(screen.getByLabelText("Hidden username")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the AWS root username" }));
    });
    expect(writeText).toHaveBeenCalledWith("root@mindfultech.ec");
    expect(document.querySelector("[data-pin-prompt]")).toBeNull();
    expect(api.reveal).not.toHaveBeenCalled();

    // The password has its own Reveal and Copy, and Launch sits at the end.
    expect(screen.getByRole("button", { name: "Reveal the AWS root password" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy the AWS root password" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Launch AWS root/ })).toBeTruthy();
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("leaves the username out when the secret has none", () => {
    render(<VaultSecretCard card={{ secretId: aws.secretId, name: "Stripe" }} mine={false} />);
    expect(document.querySelector("[data-username-controls]")).toBeNull();
    expect(screen.queryByRole("link", { name: /Launch/ })).toBeNull();
    expect(screen.getByLabelText("Hidden password")).toBeTruthy();
  });

  it("asks for the PIN once, unlocks the Vault with it, and says when it isn't shared with you", async () => {
    api.reveal.mockRejectedValueOnce(new TasksApiError(404, "Secret not found"));
    api.reveal.mockResolvedValue("sk_live_123");
    render(<VaultSecretCard card={{ secretId: aws.secretId, name: "Stripe" }} mine={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Reveal the Stripe password" }));
    const prompt = () => document.querySelector("[data-pin-prompt]") as HTMLElement;
    await typePin("4821", within(prompt()).getByLabelText("Vault PIN") as HTMLInputElement);
    expect(within(prompt()).getByRole("alert").textContent).toBe(
      "This secret was deleted, or it's not shared with you.",
    );
    await typePin("4821", within(prompt()).getByLabelText("Vault PIN") as HTMLInputElement);
    expect(api.unlock).toHaveBeenCalledWith("4821");
    expect(api.reveal).toHaveBeenLastCalledWith(aws.secretId, "tok");
    expect(screen.getByLabelText("Stripe password").textContent).toBe("sk_live_123");
    // The Vault is open now: Copy needs no PIN.
    api.unlock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Hide the password" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy the Stripe password" }));
    });
    expect(document.querySelector("[data-pin-prompt]")).toBeNull();
    expect(api.unlock).not.toHaveBeenCalled();
  });
});
