import type { Attachment } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  dropPlaceholder,
  fillPlaceholder,
  hasPlaceholders,
  imageRef,
  insertBlock,
  parseTaskText,
  pastedImages,
  pastedName,
  placeholder,
  referencedImages,
  textWithoutImages,
} from "./taskText";

const KEY = "attachments/b_1/01ABC-shot.png";
const file = (key: string, contentType = "image/png"): Attachment => ({
  key,
  name: key.split("/").pop()!,
  size: 10,
  contentType,
});

describe("image references in task text", () => {
  it("writes and reads `![name](attachment:key)`, never a link", () => {
    expect(imageRef("shot.png", KEY)).toBe(`![shot.png](attachment:${KEY})`);
    expect(imageRef("a]b\nc", KEY)).toBe(`![a b c](attachment:${KEY})`);
    expect(parseTaskText(`Steps:\n${imageRef("shot.png", KEY)}\ndone`)).toEqual([
      { kind: "text", text: "Steps:\n" },
      { kind: "image", alt: "shot.png", key: KEY },
      { kind: "text", text: "\ndone" },
    ]);
    // An ordinary markdown image (a URL) is just text: nothing outside the task is ever loaded.
    expect(parseTaskText("![x](https://evil.example/pixel.png)")).toEqual([
      { kind: "text", text: "![x](https://evil.example/pixel.png)" },
    ]);
  });

  it("shows only the task's own image files, each once", () => {
    const text = `${imageRef("a", KEY)} ${imageRef("b", "attachments/b_2/other.png")} ${imageRef("a", KEY)} ${imageRef("pdf", "attachments/b_1/x.pdf")}`;
    const own = [file(KEY), file("attachments/b_1/x.pdf", "application/pdf")];
    expect(referencedImages(text, own).map((a) => a.key)).toEqual([KEY]);
  });

  it("leaves image references out of a card's preview", () => {
    const text = `Fix the header\n\n${imageRef("shot.png", KEY)}\n\n\n${placeholder("p1", "x.png")}\nthanks`;
    expect(textWithoutImages(text)).toBe("Fix the header\n\nthanks");
  });
});

describe("pasting", () => {
  it("puts an image on its own lines at the caret", () => {
    expect(insertBlock("before after", 6, 7, "IMG")).toEqual({
      text: "before\nIMG\nafter",
      caret: 10,
    });
    expect(insertBlock("", 0, 0, "IMG")).toEqual({ text: "IMG", caret: 3 });
    expect(insertBlock("line\n", 5, 5, "IMG")).toEqual({ text: "line\nIMG", caret: 8 });
  });

  it("swaps the placeholder for the reference when the upload finishes, or drops it", () => {
    const text = `a\n${placeholder("p1", "x.png")}\nb`;
    expect(hasPlaceholders(text)).toBe(true);
    const done = fillPlaceholder(text, "p1", imageRef("x.png", KEY));
    expect(done).toBe(`a\n${imageRef("x.png", KEY)}\nb`);
    expect(hasPlaceholders(done)).toBe(false);
    expect(dropPlaceholder(text, "p1")).toBe("a\nb");
    expect(dropPlaceholder(placeholder("p1", "x.png"), "p1")).toBe("");
    expect(fillPlaceholder(text, "other", "X")).toBe(text);
  });

  it("intercepts pasted images, but not text that comes with a picture of itself", () => {
    const png = new File(["x"], "image.png", { type: "image/png" });
    const clip = (files: File[], text = "") => ({
      files: files as unknown as FileList,
      types: text ? ["Files", "text/plain"] : ["Files"],
      getData: () => text,
    });
    expect(pastedImages(clip([png]))).toEqual([png]);
    expect(pastedImages(clip([png], "A1\tB1"))).toEqual([]); // spreadsheet cells
    expect(pastedImages(clip([new File(["x"], "a.pdf", { type: "application/pdf" })]))).toEqual([]);
    expect(pastedImages(clip([]))).toEqual([]);
  });

  it("names screenshots after the moment they were pasted", () => {
    const at = new Date("2026-10-23T14:05:09Z");
    expect(pastedName(new File(["x"], "image.png", { type: "image/png" }), at)).toBe(
      "pasted-20261023-140509.png",
    );
    expect(pastedName(new File(["x"], "", { type: "image/jpeg" }), at)).toBe(
      "pasted-20261023-140509.jpg",
    );
    expect(pastedName(new File(["x"], "mockup.png", { type: "image/png" }), at)).toBe("mockup.png");
  });
});
