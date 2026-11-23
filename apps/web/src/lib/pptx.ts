import type { SalesSlide } from "@mindfultech/shared";

// ---------------------------------------------------------------------------
// A presentation as a PowerPoint file (Phase 73), written here: a .pptx is a
// zip of XML parts, and a deck of titles, bullets, tables and notes needs
// only a few of them. No library: the zip is stored (no compression), with
// its CRC-32. Opens in PowerPoint, Keynote and Google Slides (File → Import).
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip with every file stored as it is. */
export function zipStore(files: Array<{ name: string; text: string }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = enc.encode(file.name);
    const data = enc.encode(file.text);
    const crc = crc32(data);
    const header = (signature: number, extra: number) => {
      const view = new DataView(new ArrayBuffer(extra));
      view.setUint32(0, signature, true);
      return view;
    };
    const local = header(0x04034b50, 30);
    local.setUint16(4, 20, true); // version
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint32(10, 0x00210000, true); // 1980-01-01 00:00
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const cd = header(0x02014b50, 46);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint32(12, 0x00210000, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), name, data);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const size = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Text for an XML part: without the control characters XML 1.0 forbids, and escaped. */
const esc = (s: string) =>
  [...s]
    .filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const rels = (items: Array<[string, string, string]>) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
    )
    .join("")}</Relationships>`;

// 16:9, in EMU.
const W = 12192000;
const H = 6858000;
const M = 609600;

const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const run = (text: string, size: number, bold = false, color = "1F2937") =>
  `<a:r><a:rPr lang="es-EC" sz="${size}"${bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${esc(text)}</a:t></a:r>`;

function box(id: number, name: string, x: number, y: number, cx: number, cy: number, body: string) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function table(id: number, rows: string[][], y: number): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const width = Math.floor((W - 2 * M) / cols);
  const cell = (text: string, head: boolean) =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(text, 1200, head, head ? "FFFFFF" : "1F2937")}</a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="${head ? "1F6E47" : "F3F4F6"}"/></a:solidFill></a:tcPr></a:tc>`;
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Tabla"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${M}" y="${y}"/><a:ext cx="${width * cols}" cy="${rows.length * 420000}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${width}"/>`).join("")}</a:tblGrid>${rows
    .map(
      (r, i) =>
        `<a:tr h="420000">${Array.from({ length: cols }, (_, c) => cell(r[c] ?? "", i === 0)).join("")}</a:tr>`,
    )
    .join("")}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function slideXml(slide: SalesSlide, first: boolean): string {
  const title = box(
    2,
    "Título",
    M,
    first ? 2200000 : 420000,
    W - 2 * M,
    first ? 1500000 : 1000000,
    `<a:p>${run(slide.title, first ? 4000 : 2800, true, "0E3B26")}</a:p>`,
  );
  const bullets = slide.bullets.length
    ? box(
        3,
        "Contenido",
        M,
        first ? 3800000 : 1500000,
        W - 2 * M,
        slide.table ? 1400000 : 4600000,
        slide.bullets
          .map(
            (b) =>
              `<a:p>${first ? "" : '<a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="•"/></a:pPr>'}${run(b, first ? 2000 : 1800)}</a:p>`,
          )
          .join(""),
      )
    : "";
  const tbl = slide.table?.length
    ? table(4, slide.table, slide.bullets.length ? 3100000 : 1600000)
    : "";
  return `${XML}<p:sld ${NS}><p:cSld><p:spTree>${GROUP}${title}${bullets}${tbl}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const notesXml = (text: string) =>
  `${XML}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notas"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${text
    .split("\n")
    .map((line) => `<a:p><a:r><a:rPr lang="es-EC" dirty="0"/><a:t>${esc(line)}</a:t></a:r></a:p>`)
    .join(
      "",
    )}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;

const FILL3 =
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const LINE = '<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>';
const EFFECT = "<a:effectStyle><a:effectLst/></a:effectStyle>";
const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="MindfulTech"><a:themeElements><a:clrScheme name="MindfulTech"><a:dk1><a:srgbClr val="1F2937"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="0E3B26"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="40B375"/></a:accent1><a:accent2><a:srgbClr val="1F6E47"/></a:accent2><a:accent3><a:srgbClr val="ECB22E"/></a:accent3><a:accent4><a:srgbClr val="E01E5A"/></a:accent4><a:accent5><a:srgbClr val="36C5F0"/></a:accent5><a:accent6><a:srgbClr val="6B7280"/></a:accent6><a:hlink><a:srgbClr val="1F6E47"/></a:hlink><a:folHlink><a:srgbClr val="6B7280"/></a:folHlink></a:clrScheme><a:fontScheme name="MindfulTech"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="MindfulTech"><a:fillStyleLst>${FILL3}</a:fillStyleLst><a:lnStyleLst>${LINE}${LINE}${LINE}</a:lnStyleLst><a:effectStyleLst>${EFFECT}${EFFECT}${EFFECT}</a:effectStyleLst><a:bgFillStyleLst>${FILL3}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
const BG =
  '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>';

/** The parts of a .pptx with these slides (16:9; titles, bullets, tables, speaker notes). */
export function pptxFiles(slides: SalesSlide[]): Array<{ name: string; text: string }> {
  const n = slides.length;
  const withNotes = slides.map((s) => s.notes.trim().length > 0);
  const types = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    ...(withNotes.some(Boolean)
      ? [
          '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>',
          '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
        ]
      : []),
    ...slides.flatMap((_, i) => [
      `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
      ...(withNotes[i]
        ? [
            `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`,
          ]
        : []),
    ]),
  ];
  const notes = withNotes.some(Boolean);
  const files = [
    {
      name: "[Content_Types].xml",
      text: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${types.join("")}</Types>`,
    },
    { name: "_rels/.rels", text: rels([["rId1", "officeDocument", "ppt/presentation.xml"]]) },
    {
      name: "ppt/presentation.xml",
      text: `${XML}<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notes ? `<p:notesMasterIdLst><p:notesMasterId r:id="rId${n + 3}"/></p:notesMasterIdLst>` : ""}<p:sldIdLst>${slides
        .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`)
        .join(
          "",
        )}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="${H}" cy="9144000"/></p:presentation>`,
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      text: rels([
        ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
        ...slides.map((_, i): [string, string, string] => [
          `rId${i + 2}`,
          "slide",
          `slides/slide${i + 1}.xml`,
        ]),
        [`rId${n + 2}`, "theme", "theme/theme1.xml"],
        ...(notes
          ? [
              [`rId${n + 3}`, "notesMaster", "notesMasters/notesMaster1.xml"] as [
                string,
                string,
                string,
              ],
            ]
          : []),
      ]),
    },
    {
      name: "ppt/slideMasters/slideMaster1.xml",
      text: `${XML}<p:sldMaster ${NS}><p:cSld>${BG}<p:spTree>${GROUP}</p:spTree></p:cSld>${CLR_MAP}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`,
    },
    {
      name: "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      text: rels([
        ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
        ["rId2", "theme", "../theme/theme1.xml"],
      ]),
    },
    {
      name: "ppt/slideLayouts/slideLayout1.xml",
      text: `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="En blanco"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    },
    {
      name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      text: rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]),
    },
    { name: "ppt/theme/theme1.xml", text: THEME },
    ...(notes
      ? [
          {
            name: "ppt/notesMasters/notesMaster1.xml",
            text: `${XML}<p:notesMaster ${NS}><p:cSld>${BG}<p:spTree>${GROUP}</p:spTree></p:cSld>${CLR_MAP}</p:notesMaster>`,
          },
          {
            name: "ppt/notesMasters/_rels/notesMaster1.xml.rels",
            text: rels([["rId1", "theme", "../theme/theme2.xml"]]),
          },
          { name: "ppt/theme/theme2.xml", text: THEME },
        ]
      : []),
    ...slides.flatMap((slide, i) => [
      { name: `ppt/slides/slide${i + 1}.xml`, text: slideXml(slide, i === 0) },
      {
        name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
        text: rels([
          ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
          ...(withNotes[i]
            ? [
                ["rId2", "notesSlide", `../notesSlides/notesSlide${i + 1}.xml`] as [
                  string,
                  string,
                  string,
                ],
              ]
            : []),
        ]),
      },
      ...(withNotes[i]
        ? [
            { name: `ppt/notesSlides/notesSlide${i + 1}.xml`, text: notesXml(slide.notes) },
            {
              name: `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`,
              text: rels([
                ["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"],
                ["rId2", "slide", `../slides/slide${i + 1}.xml`],
              ]),
            },
          ]
        : []),
    ]),
  ];
  return files;
}

export const pptxBytes = (slides: SalesSlide[]) => zipStore(pptxFiles(slides));

export function downloadBytes(name: string, bytes: Uint8Array | string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadPptx = (name: string, slides: SalesSlide[]) =>
  downloadBytes(
    `${name.replace(/[^\p{L}\d]+/gu, "-").replace(/^-|-$/g, "") || "presentacion"}.pptx`,
    pptxBytes(slides),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
