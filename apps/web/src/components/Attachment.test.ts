import type { Attachment as AttachmentData } from "@mindfultech/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Attachment, attachmentKind, MAX_INLINE_MARKDOWN_BYTES } from "./Attachment";

const file = (contentType: string, name: string, size = 1_000): AttachmentData => ({
  key: `attachments/ch_general/01A-${name}`,
  name,
  size,
  contentType,
});
const render = (a: AttachmentData) =>
  renderToStaticMarkup(createElement(Attachment, { attachment: a }));

describe("attachmentKind", () => {
  it("plays video types inline and reads PDFs in the viewer", () => {
    expect(attachmentKind(file("video/mp4", "demo.mp4"))).toBe("video");
    expect(attachmentKind(file("video/webm", "demo.webm"))).toBe("video");
    expect(attachmentKind(file("video/quicktime", "demo.mov"))).toBe("video");
    expect(attachmentKind(file("application/pdf", "spec.pdf"))).toBe("pdf");
    // Some browsers upload a PDF with a generic type: the extension decides.
    expect(attachmentKind(file("application/octet-stream", "Spec.PDF"))).toBe("pdf");
  });

  it("previews small Markdown files whatever type the browser gave them", () => {
    expect(attachmentKind(file("text/markdown", "README.md"))).toBe("markdown");
    expect(attachmentKind(file("text/x-markdown", "notes.markdown"))).toBe("markdown");
    expect(attachmentKind(file("application/octet-stream", "notes.md"))).toBe("markdown");
    expect(attachmentKind(file("text/markdown", "big.md", MAX_INLINE_MARKDOWN_BYTES))).toBe(
      "markdown",
    );
  });

  it("keeps large Markdown files and anything else as a plain download", () => {
    expect(attachmentKind(file("text/markdown", "big.md", MAX_INLINE_MARKDOWN_BYTES + 1))).toBe(
      "file",
    );
    expect(attachmentKind(file("text/plain", "notes.txt"))).toBe("file");
    expect(attachmentKind(file("application/zip", "md.zip"))).toBe("file");
  });
});

describe("Attachment", () => {
  it("shows a PDF as a card that opens the in-app viewer", () => {
    const html = render(file("application/pdf", "spec.pdf", 2048));
    expect(html).toContain('aria-label="Open spec.pdf"');
    expect(html).toContain("PDF");
    expect(html).toContain("2 KB");
  });

  it("shows a small Markdown file with a collapsed preview toggle and its download", () => {
    const html = render(file("text/markdown", "README.md"));
    expect(html).toContain("Preview document");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Download README.md"');
  });

  it("shows a large Markdown file as a download only", () => {
    const html = render(file("text/markdown", "big.md", MAX_INLINE_MARKDOWN_BYTES + 1));
    expect(html).not.toContain("Preview document");
    expect(html).toContain('aria-label="Download big.md"');
  });
});
