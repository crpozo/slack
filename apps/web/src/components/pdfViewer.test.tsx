// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// pdf.js can't run in jsdom: a react-pdf stand-in with the same callbacks.
const pdf = vi.hoisted(() => ({ numPages: 3, fail: false }));
vi.mock("react-pdf", () => ({
  pdfjs: { GlobalWorkerOptions: {}, version: "5.4.296" },
  Document: ({
    onLoadSuccess,
    onLoadError,
    children,
  }: {
    onLoadSuccess: (doc: unknown) => void;
    onLoadError: (err: Error) => void;
    children: React.ReactNode;
  }) => {
    queueMicrotask(() =>
      pdf.fail
        ? onLoadError(new Error("Invalid PDF structure."))
        : onLoadSuccess({
            numPages: pdf.numPages,
            getPage: async () => ({ getViewport: () => ({ width: 612, height: 792 }) }),
          }),
    );
    return <div data-testid="pdf-document">{children}</div>;
  },
  Page: ({ pageNumber }: { pageNumber: number }) => <canvas data-testid={`canvas-${pageNumber}`} />,
}));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({
  default: "/assets/pdf.worker.js",
}));
vi.mock("../lib/upload", () => ({
  getDownloadUrl: vi.fn(async () => "https://bucket.s3.amazonaws.com/a.pdf?X-Amz-Signature=x"),
}));

import { PdfViewer } from "./PdfViewer";

beforeEach(() => {
  pdf.numPages = 3;
  pdf.fail = false;
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  // jsdom has no layout: give the scrolling column a phone's width.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => 390,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PdfViewer", () => {
  it("phones: every page is listed, drawn with pdf.js, in a scrolling column of explicit height", async () => {
    render(
      <PdfViewer
        fileKey="attachments/ch/a.pdf"
        name="a.pdf"
        onClose={() => {}}
        renderer="canvas"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("pdf-page").textContent).toBe("1 / 3"));
    for (const page of [1, 2, 3]) expect(screen.getByTestId(`canvas-${page}`)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    const scroller = screen.getByTestId("pdf-scroller");
    expect(scroller.className).toMatch(/overflow-auto/);
    expect(scroller.className).toMatch(/\[-webkit-overflow-scrolling:touch\]/);
    expect(scroller.className).toMatch(/h-full/);
    expect(document.querySelector("dialog")?.className).toMatch(/h-\[100dvh\]/);
    expect(screen.getByRole("button", { name: "Next page" })).toBeTruthy();
  });

  it("phones: a PDF pdf.js can't read says so, with New tab and Download still there", async () => {
    pdf.fail = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <PdfViewer
        fileKey="attachments/ch/a.pdf"
        name="a.pdf"
        onClose={() => {}}
        renderer="canvas"
      />,
    );
    await waitFor(() => expect(screen.getByText(/Couldn't show this PDF here/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Download a.pdf" })).toBeTruthy();
    expect(screen.getByTitle("Open in a new tab").getAttribute("href")).toMatch(/^https:\/\//);
  });

  it("computers: the browser's own viewer in an iframe, no pdf.js", async () => {
    render(
      <PdfViewer
        fileKey="attachments/ch/a.pdf"
        name="a.pdf"
        onClose={() => {}}
        renderer="native"
      />,
    );
    await waitFor(() => expect(document.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByTestId("pdf-document")).toBeNull();
  });
});
