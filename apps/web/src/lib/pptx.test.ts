import { DEMO_ROI, roiDeck, roiModel } from "@mindfultech/shared";
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pptxBytes, pptxFiles } from "./pptx";

// Phase 73: the business case as a PowerPoint file, written without a library.

const model = roiModel(DEMO_ROI);
const deck = roiDeck(
  { name: "Farmacias & Cía <Andina>" },
  { name: "Plataforma B2B", nextStep: "", criteria: "" },
  model,
);

describe("the .pptx", () => {
  it("has a slide part per slide, with the model's figures and escaped text", () => {
    const files = pptxFiles(deck);
    const slides = files.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.name));
    expect(slides).toHaveLength(deck.length);
    const all = slides.map((s) => s.text).join("");
    const n = new Intl.NumberFormat("es-EC", { maximumFractionDigits: 0 });
    expect(all).toContain(n.format(model.scenarios.base.net));
    expect(all).toContain(`${model.scenarios.base.roiPct}%`);
    expect(all).toContain("Farmacias &amp; Cía &lt;Andina&gt;");
    expect(all).toContain("<a:tbl>");
    // Every part a slide points to exists.
    const names = new Set(files.map((f) => f.name));
    expect(names.has("[Content_Types].xml")).toBe(true);
    for (const f of files.filter((x) => x.name.includes("notesSlides/_rels"))) {
      expect(names.has(f.name.replace("_rels/", "").replace(".rels", ""))).toBe(true);
    }
  });

  it("is a zip a reader can open (stored entries, sizes and CRCs)", () => {
    const bytes = pptxBytes(deck);
    expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const view = new DataView(bytes.buffer);
    const end = bytes.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(pptxFiles(deck).length);
    if (process.env.PPTX_OUT) writeFileSync(process.env.PPTX_OUT, bytes);
  });
});
