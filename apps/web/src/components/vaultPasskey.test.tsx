// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureTasksApi } from "../lib/tasksApi";
import { vaultApi } from "../lib/vaultApi";
import { useChat } from "../store";
import { VaultLockScreen } from "./VaultPin";

// Phase 77: the Vault with the device's fingerprint (Touch ID), next to the PIN.

const bytes = (...n: number[]) => new Uint8Array(n).buffer;
const session = { token: "t".repeat(43), expiresAt: Date.now() + 60_000 };
let credentials: { create: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };

beforeEach(() => {
  localStorage.clear();
  configureTasksApi("https://api.fake.example");
  useChat.setState({ me: { userId: "u-1", email: "ana@example.test", role: "member" } });
  vi.stubGlobal("PublicKeyCredential", {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
  });
  credentials = { create: vi.fn(), get: vi.fn() };
  Object.defineProperty(navigator, "credentials", { value: credentials, configurable: true });
  vi.spyOn(vaultApi, "passkeyChallenge").mockResolvedValue({
    challenge: "AQID",
    credentialIds: ["CQkJ"],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Vault's lock screen with a fingerprint", () => {
  it("offers it after the PIN on a device that has one, and enrolls with the open session", async () => {
    vi.spyOn(vaultApi, "pinStatus").mockResolvedValue({
      hasPin: true,
      attemptsLeft: 5,
      passkeys: [],
    });
    vi.spyOn(vaultApi, "unlock").mockResolvedValue(session);
    const register = vi.spyOn(vaultApi, "registerPasskey").mockResolvedValue({ id: "CQkJ" });
    credentials.create.mockResolvedValue({
      rawId: bytes(9, 9, 9),
      response: {
        clientDataJSON: bytes(1, 2),
        getPublicKey: () => bytes(3, 4),
        getPublicKeyAlgorithm: () => -7,
      },
    });
    const onUnlocked = vi.fn();
    render(<VaultLockScreen onUnlocked={onUnlocked} />);
    const input = await screen.findByLabelText("Enter your Vault PIN");
    expect(screen.queryByRole("button", { name: /Unlock with fingerprint/ })).toBeNull();
    fireEvent.change(input, { target: { value: "9052" } });
    fireEvent.click(await screen.findByRole("button", { name: "Use fingerprint on this device" }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(session));
    // Only this device's own authenticator, with the person verified.
    const options = credentials.create.mock.calls[0]![0].publicKey;
    expect(options.authenticatorSelection).toMatchObject({
      authenticatorAttachment: "platform",
      userVerification: "required",
    });
    expect(register).toHaveBeenCalledWith(
      { id: "CQkJ", publicKey: "AwQ", alg: -7, clientDataJSON: "AQI", name: expect.any(String) },
      session.token,
    );
    expect(localStorage.getItem("slack.vault.passkey")).toBe("CQkJ");
  });

  it("opens with the fingerprint on an enrolled device; the PIN is still there", async () => {
    localStorage.setItem("slack.vault.passkey", "CQkJ");
    vi.spyOn(vaultApi, "pinStatus").mockResolvedValue({
      hasPin: true,
      attemptsLeft: 5,
      passkeys: ["CQkJ"],
    });
    const verify = vi.spyOn(vaultApi, "verifyPasskey").mockResolvedValue(session);
    credentials.get.mockResolvedValue({
      rawId: bytes(9, 9, 9),
      response: { clientDataJSON: bytes(1), authenticatorData: bytes(2), signature: bytes(3) },
    });
    const onUnlocked = vi.fn();
    render(<VaultLockScreen onUnlocked={onUnlocked} />);
    fireEvent.click(await screen.findByRole("button", { name: /Unlock with fingerprint/ }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledWith(session));
    expect(credentials.get.mock.calls[0]![0].publicKey).toMatchObject({
      userVerification: "required",
      rpId: location.hostname,
    });
    expect(verify).toHaveBeenCalledWith({
      id: "CQkJ",
      clientDataJSON: "AQ",
      authenticatorData: "Ag",
      signature: "Aw",
    });
    expect(screen.getByLabelText("Enter your Vault PIN")).toBeTruthy();
  });

  it("isn't offered where the server no longer knows this device", async () => {
    localStorage.setItem("slack.vault.passkey", "CQkJ");
    vi.spyOn(vaultApi, "pinStatus").mockResolvedValue({
      hasPin: true,
      attemptsLeft: 5,
      passkeys: [],
    });
    render(<VaultLockScreen onUnlocked={() => {}} />);
    await screen.findByLabelText("Enter your Vault PIN");
    expect(screen.queryByRole("button", { name: /Unlock with fingerprint/ })).toBeNull();
  });
});
