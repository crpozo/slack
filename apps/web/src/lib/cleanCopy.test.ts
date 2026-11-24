// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanFragment, installCleanCopy, plainTextOf } from "./cleanCopy";

const MESSAGE = `<div class="md text-ink" style="color: rgb(248,248,248); background: #222529">
  <p class="mb-1">Hi Dayanis,</p>
  <p>The form sends <code class="rounded bg-white/10 px-1" style="background:#333">configuration</code> and it's in <strong class="font-bold">Estimate Sent</strong>. See <a href="https://example.com/x" class="underline" target="_blank">the quote</a>.</p>
  <ol class="list-decimal"><li class="ml-4">Free-text lead source</li><li>Customer Type</li></ol>
  <button class="copy">Copy</button>
  <p>Thanks!</p>
</div>`;

afterEach(() => {
  document.body.innerHTML = "";
});

describe("copying from the app", () => {
  it("keeps the words and their structure, none of the look", () => {
    const holder = document.createElement("div");
    holder.innerHTML = MESSAGE;
    const clean = cleanFragment(holder);
    expect(clean.innerHTML).not.toMatch(/style=|class=|background|rgb\(|target=/);
    expect(clean.innerHTML).toContain("<code>configuration</code>");
    expect(clean.innerHTML).toContain("<strong>Estimate Sent</strong>");
    expect(clean.innerHTML).toContain('<a href="https://example.com/x">the quote</a>');
    expect(clean.querySelector("button")).toBeNull();
    expect(plainTextOf(clean)).toBe(
      [
        "Hi Dayanis,",
        "The form sends configuration and it's in Estimate Sent. See the quote.",
        "1. Free-text lead source",
        "2. Customer Type",
        "Thanks!",
      ].join("\n"),
    );
  });

  it("puts that on the clipboard for a selection, and leaves text fields alone", () => {
    document.body.innerHTML = `${MESSAGE}<input id="field" value="typed">`;
    const uninstall = installCleanCopy();
    const range = document.createRange();
    range.selectNodeContents(document.querySelector(".md")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const data = new Map<string, string>();
    const copy = (target: Element) => {
      const event = new Event("copy", { bubbles: true, cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", {
        value: { setData: (type: string, value: string) => data.set(type, value) },
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(copy(document.querySelector(".md")!)).toBe(true);
    expect(data.get("text/plain")).toContain("1. Free-text lead source");
    expect(data.get("text/html")).not.toMatch(/style=|class=/);
    // A field copies its own text, as always.
    data.clear();
    expect(copy(document.getElementById("field")!)).toBe(false);
    expect(data.size).toBe(0);
    uninstall();
    expect(copy(document.querySelector(".md")!)).toBe(false);
  });
});
