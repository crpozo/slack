// @vitest-environment jsdom
import type { Message } from "@mindfultech/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/messagesApi", () => ({ messagesApi: { transcribe: vi.fn(), delete: vi.fn() } }));

import { messagesApi } from "../lib/messagesApi";
import { TasksApiError } from "../lib/tasksApi";
import { useChat } from "../store";
import { TRANSCRIBE_RETRY_MS, VoiceTranscript } from "./VoiceTranscript";

const api = vi.mocked(messagesApi);
const CH = "dm_a_b";
const note: Message = {
  messageId: "01JVOICE",
  channelId: CH,
  sk: "1762786800000#01JVOICE",
  userId: "b",
  userEmail: "b@example.com",
  text: "",
  attachments: [
    { key: "attachments/dm_a_b/v.webm", name: "v.webm", size: 99, contentType: "audio/webm" },
  ],
  createdAt: 1,
};

/** The component as the chat renders it: fed the message from the store. */
function FromStore() {
  const message = useChat((s) => s.messagesByChannel[CH]?.[0]);
  return message ? <VoiceTranscript message={message} /> : null;
}

beforeEach(() => {
  api.transcribe.mockReset();
  useChat.setState({ messagesByChannel: { [CH]: [{ ...note }] } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a voice message's transcript (Phase 58)", () => {
  it("offers Transcribir, spins while it works, then shows the text and no button", async () => {
    let answer!: (v: { transcript: string; cached: boolean }) => void;
    api.transcribe.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    render(<FromStore />);
    fireEvent.click(screen.getByRole("button", { name: "Transcribir el audio" }));
    const busy = screen.getByRole("button", {
      name: "Transcribiendo el audio",
    }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.textContent).toContain("Transcribiendo…");
    expect(api.transcribe).toHaveBeenCalledWith(CH, note.sk);

    await act(async () => answer({ transcript: "El deploy ya está listo.", cached: false }));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("Transcripción del audio").textContent).toContain(
      "El deploy ya está listo.",
    );
    // Kept in the store: the message carries it from now on.
    expect(useChat.getState().messagesByChannel[CH]?.[0]?.transcript).toBe(
      "El deploy ya está listo.",
    );
  });

  it("shows a transcript the message already has, without asking", () => {
    useChat.setState({ messagesByChannel: { [CH]: [{ ...note, transcript: "Hola equipo." }] } });
    render(<FromStore />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByLabelText("Transcripción del audio").textContent).toContain("Hola equipo.");
    expect(api.transcribe).not.toHaveBeenCalled();
  });

  it("says so when no speech was heard", () => {
    useChat.setState({ messagesByChannel: { [CH]: [{ ...note, transcript: "" }] } });
    render(<FromStore />);
    expect(screen.getByText("No se escuchó voz en este audio.")).toBeTruthy();
  });

  it("waits and asks again while someone else's request is transcribing it", async () => {
    vi.useFakeTimers();
    api.transcribe
      .mockRejectedValueOnce(new TasksApiError(409, "It's being transcribed right now"))
      .mockResolvedValueOnce({ transcript: "Listo.", cached: true });
    render(<FromStore />);
    fireEvent.click(screen.getByRole("button", { name: "Transcribir el audio" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TRANSCRIBE_RETRY_MS);
    });
    expect(api.transcribe).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("Transcripción del audio").textContent).toContain("Listo.");
  });

  it("tells you when it fails and lets you try again", async () => {
    api.transcribe.mockRejectedValueOnce(
      new TasksApiError(502, "Couldn't transcribe it just now. Try again."),
    );
    render(<FromStore />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Transcribir el audio" }));
    });
    expect(useChat.getState().toast?.message).toBe("Couldn't transcribe it just now. Try again.");
    expect(screen.getByRole("button", { name: "Transcribir el audio" })).toBeTruthy();
  });

  it("isn't offered for a message without audio", () => {
    useChat.setState({ messagesByChannel: { [CH]: [{ ...note, attachments: [] }] } });
    const { container } = render(<FromStore />);
    expect(container.innerHTML).toBe("");
  });
});
