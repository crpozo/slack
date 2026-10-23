import { beforeEach, describe, expect, it, vi } from "vitest";

const amplify = vi.hoisted(() => ({
  signIn: vi.fn(),
  confirmSignIn: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
  updatePassword: vi.fn(),
  fetchAuthSession: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => amplify);
vi.mock("aws-amplify", () => ({ Amplify: { configure: vi.fn() } }));

import {
  authErrorMessage,
  ChallengeExpiredError,
  changePassword,
  confirmPasswordReset,
  passwordProblem,
  requestPasswordReset,
  setNewPassword,
  signIn,
} from "./auth";

const named = (name: string, message = "") => Object.assign(new Error(message), { name });

beforeEach(() => {
  Object.values(amplify).forEach((fn) => fn.mockReset());
  amplify.fetchAuthSession.mockResolvedValue({
    tokens: { idToken: { payload: { sub: "u1", email: "ana@x.ec" } } },
  });
});

describe("passwordProblem", () => {
  it("follows the pool's policy", () => {
    expect(passwordProblem("short")).toMatch(/at least 8/);
    expect(passwordProblem(" spaced-out")).toMatch(/space/);
    expect(passwordProblem("spaced-out ")).toMatch(/space/);
    expect(passwordProblem("x".repeat(257))).toMatch(/at most/);
    expect(passwordProblem("good password")).toBeNull(); // inner spaces are fine
  });
});

describe("authErrorMessage", () => {
  it("reads the same Cognito error by what the user was doing", () => {
    const denied = named("NotAuthorizedException", "Incorrect username or password.");
    expect(authErrorMessage(denied, "signIn")).toBe("Incorrect email or password.");
    expect(authErrorMessage(denied, "change")).toBe("Your current password is incorrect.");
    expect(authErrorMessage(denied, "requestReset")).toMatch(/temporary password/);
  });

  it("explains an expired invitation", () => {
    const expired = named(
      "NotAuthorizedException",
      "Temporary password has expired and must be reset by an administrator.",
    );
    expect(authErrorMessage(expired, "signIn")).toMatch(/invitation has expired/);
  });

  it("only blames spaces where a password is being set", () => {
    const invalid = named("InvalidParameterException");
    expect(authErrorMessage(invalid, "newPassword")).toMatch(/space/);
    expect(authErrorMessage(invalid, "change")).toMatch(/space/);
    expect(authErrorMessage(invalid, "signIn")).toBe("Couldn't sign in. Please try again.");
  });

  it("falls back per action", () => {
    expect(authErrorMessage(new Error("?"), "confirmReset")).toMatch(/Couldn't reset/);
    expect(authErrorMessage(named("CodeMismatchException"), "confirmReset")).toMatch(/code/);
  });
});

describe("new password challenge", () => {
  it("asks for a new password, then signs in", async () => {
    amplify.signIn.mockResolvedValue({
      isSignedIn: false,
      nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED" },
    });
    expect(await signIn(" Ana@X.ec ", "temp")).toEqual({ newPasswordRequired: true });
    expect(amplify.signIn).toHaveBeenCalledWith({ username: "ana@x.ec", password: "temp" });

    amplify.confirmSignIn.mockResolvedValue({ isSignedIn: true });
    expect(await setNewPassword("my new password")).toMatchObject({ userId: "u1" });
  });

  it("turns an expired challenge session into ChallengeExpiredError", async () => {
    amplify.confirmSignIn.mockRejectedValue(
      named("NotAuthorizedException", "Invalid session for the user, session is expired."),
    );
    await expect(setNewPassword("my new password")).rejects.toBeInstanceOf(ChallengeExpiredError);

    amplify.confirmSignIn.mockRejectedValue(named("SignInException", "no sign in in progress"));
    await expect(setNewPassword("my new password")).rejects.toBeInstanceOf(ChallengeExpiredError);
  });

  it("keeps other errors as messages", async () => {
    amplify.confirmSignIn.mockRejectedValue(named("InvalidPasswordException"));
    await expect(setNewPassword("x")).rejects.toThrow("at least 8 characters");
  });
});

describe("forgot password", () => {
  it("sends a code and returns where it went", async () => {
    amplify.resetPassword.mockResolvedValue({
      nextStep: { codeDeliveryDetails: { destination: "a***@x***" } },
    });
    expect(await requestPasswordReset("Ana@x.ec")).toBe("a***@x***");
    expect(amplify.resetPassword).toHaveBeenCalledWith({ username: "ana@x.ec" });
  });

  it("resets with the code, then signs in with the new password", async () => {
    amplify.confirmResetPassword.mockResolvedValue(undefined);
    amplify.signIn.mockResolvedValue({ isSignedIn: true, nextStep: { signInStep: "DONE" } });
    expect(await confirmPasswordReset("ana@x.ec", " 123456 ", "brand new pw")).toMatchObject({
      user: { userId: "u1" },
    });
    expect(amplify.confirmResetPassword).toHaveBeenCalledWith({
      username: "ana@x.ec",
      confirmationCode: "123456",
      newPassword: "brand new pw",
    });
    expect(amplify.signIn).toHaveBeenCalledWith({ username: "ana@x.ec", password: "brand new pw" });
  });

  it("explains a wrong code", async () => {
    amplify.confirmResetPassword.mockRejectedValue(named("CodeMismatchException"));
    await expect(confirmPasswordReset("ana@x.ec", "1", "brand new pw")).rejects.toThrow(
      "That code isn't right",
    );
    expect(amplify.signIn).not.toHaveBeenCalled();
  });
});

describe("changePassword", () => {
  it("passes both passwords and explains a wrong current one", async () => {
    amplify.updatePassword.mockResolvedValue(undefined);
    await changePassword("old password", "new password");
    expect(amplify.updatePassword).toHaveBeenCalledWith({
      oldPassword: "old password",
      newPassword: "new password",
    });
    amplify.updatePassword.mockRejectedValue(named("NotAuthorizedException"));
    await expect(changePassword("bad", "new password")).rejects.toThrow("current password");
  });
});
