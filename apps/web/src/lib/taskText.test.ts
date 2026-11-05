import type { Attachment } from "@mindfultech/shared";
import { describe, expect, it } from "vitest";
import {
  imageRef,
  parseTaskText,
  pastedFiles,
  pastedName,
  referencedImages,
  taskImages,
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

  it("leaves image references (and old upload placeholders) out of a card's preview", () => {
    const text = `Fix the header\n\n${imageRef("shot.png", KEY)}\n\n\n![Uploading x.png…](uploading:p1)\nthanks`;
    expect(textWithoutImages(text)).toBe("Fix the header\n\nthanks");
  });

  it("shows a task's images: the ones its text refers to first, then its other image files", () => {
    const pasted = file("attachments/b_1/02-pasted.png");
    const pdf = file("attachments/b_1/x.pdf", "application/pdf");
    const own = [pasted, file(KEY), pdf];
    expect(taskImages(imageRef("a", KEY), own).map((a) => a.key)).toEqual([KEY, pasted.key]);
    expect(taskImages("plain text", own).map((a) => a.key)).toEqual([pasted.key, KEY]);
  });
});

describe("pasting", () => {
  it("intercepts pasted images and files, but not text that comes with a picture of itself", () => {
    const png = new File(["x"], "image.png", { type: "image/png" });
    const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
    const clip = (files: File[], text = "") => ({
      files: files as unknown as FileList,
      types: text ? ["Files", "text/plain"] : ["Files"],
      getData: () => text,
    });
    expect(pastedFiles(clip([png]))).toEqual([png]);
    expect(pastedFiles(clip([png], "A1\tB1"))).toEqual([]); // spreadsheet cells
    expect(pastedFiles(clip([pdf]))).toEqual([pdf]);
    expect(pastedFiles(clip([pdf], "a.pdf"))).toEqual([pdf]); // a copied file and its name
    expect(pastedFiles(clip([]))).toEqual([]);
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
