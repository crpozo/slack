import type { VaultUnlock } from "@mindfultech/shared";
import { vaultApi } from "./vaultApi";

// ---------------------------------------------------------------------------
// The Vault with a fingerprint (Phase 77): the device's own authenticator
// through WebAuthn (Touch ID on a Mac, Windows Hello, a phone's biometrics).
// The key stays in the device; the server checks each signature. A device is
// enrolled once, with the Vault open; this browser remembers that it did.
// ---------------------------------------------------------------------------

const ENROLLED_KEY = "slack.vault.passkey";
const DECLINED_KEY = "slack.vault.passkey.declined";

const toB64u = (data: ArrayBuffer | Uint8Array) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64u = (text: string) => {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

/** Whether this device can verify its owner (a fingerprint reader, a face, a device PIN). */
export async function passkeySupported(): Promise<boolean> {
  try {
    return (
      typeof PublicKeyCredential !== "undefined" &&
      (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
    );
  } catch {
    return false;
  }
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Blocked storage: it will be offered again.
  }
};

/** The credential this browser enrolled, if the server still knows it. */
export function enrolledHere(serverIds: string[] = []): string | null {
  const id = read(ENROLLED_KEY);
  return id && serverIds.includes(id) ? id : null;
}
export const passkeyDeclined = () => read(DECLINED_KEY) === "1";
export const declinePasskey = () => write(DECLINED_KEY, "1");

/** What the device is called in its own prompt and in the server's list. */
const deviceName = () =>
  /Mac/i.test(navigator.userAgent)
    ? "Mac"
    : /iPhone|iPad/i.test(navigator.userAgent)
      ? "iPhone"
      : /Android/i.test(navigator.userAgent)
        ? "Android"
        : /Windows/i.test(navigator.userAgent)
          ? "Windows"
          : "Device";

/** Enrolls this device (the Vault is open: `token`). The system asks for the fingerprint. */
export async function enrollPasskey(
  token: string,
  user: { userId: string; email: string },
): Promise<void> {
  const { challenge, credentialIds } = await vaultApi.passkeyChallenge();
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: fromB64u(challenge),
      rp: { name: "MindfulTech Vault", id: location.hostname },
      user: {
        id: new TextEncoder().encode(user.userId).slice(0, 64),
        name: user.email,
        displayName: user.email,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        userVerification: "required",
        residentKey: "discouraged",
      },
      excludeCredentials: credentialIds.map((id) => ({ type: "public-key", id: fromB64u(id) })),
      attestation: "none",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("The fingerprint wasn't set up.");
  const response = credential.response as AuthenticatorAttestationResponse;
  const publicKey = response.getPublicKey();
  if (!publicKey) throw new Error("This device's key couldn't be read.");
  const id = toB64u(credential.rawId);
  await vaultApi.registerPasskey(
    {
      id,
      publicKey: toB64u(publicKey),
      alg: response.getPublicKeyAlgorithm(),
      clientDataJSON: toB64u(response.clientDataJSON),
      name: deviceName(),
    },
    token,
  );
  write(ENROLLED_KEY, id);
  write(DECLINED_KEY, null);
}

/** Opens the Vault with the fingerprint: the device signs the server's challenge. */
export async function unlockWithPasskey(): Promise<VaultUnlock> {
  const { challenge, credentialIds } = await vaultApi.passkeyChallenge();
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromB64u(challenge),
      rpId: location.hostname,
      allowCredentials: credentialIds.map((id) => ({
        type: "public-key",
        id: fromB64u(id),
        transports: ["internal"],
      })),
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("The fingerprint wasn't read.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return vaultApi.verifyPasskey({
    id: toB64u(credential.rawId),
    clientDataJSON: toB64u(response.clientDataJSON),
    authenticatorData: toB64u(response.authenticatorData),
    signature: toB64u(response.signature),
  });
}

/** Forgets every enrolled device (the PIN still opens the Vault). */
export async function forgetPasskeys(token: string): Promise<void> {
  await vaultApi.removePasskeys(token);
  write(ENROLLED_KEY, null);
}
