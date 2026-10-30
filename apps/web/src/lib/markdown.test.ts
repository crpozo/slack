import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  MAX_LIST_DEPTH,
  renderMarkdown,
  renderNotesMarkdown,
  splitTableRow,
} from "./markdown";

describe("renderMarkdown", () => {
  it("escapes HTML before formatting", () => {
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(escapeHtml(`'&'`)).toBe("&#39;&amp;&#39;");
  });

  it("formats bold, italic and inline code", () => {
    expect(renderMarkdown("**hola** _mundo_ `x < y`")).toBe(
      "<strong>hola</strong> <em>mundo</em> <code>x &lt; y</code>",
    );
  });

  it("does not format inside code", () => {
    expect(renderMarkdown("`**no**` y ```\n_tampoco_\n```")).toBe(
      "<code>**no**</code> y <pre><code>_tampoco_\n</code></pre>",
    );
  });

  it("links http(s) URLs only, without trailing punctuation", () => {
    expect(renderMarkdown("ver https://mindfultech.ec/a_b?x=1&y=2.")).toBe(
      'ver <a href="https://mindfultech.ec/a_b?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">https://mindfultech.ec/a_b?x=1&amp;y=2</a>.',
    );
    expect(renderMarkdown("javascript:alert(1)")).toBe("javascript:alert(1)");
  });

  it("keeps snake_case words and converts newlines", () => {
    expect(renderMarkdown("mi_variable_x\nlinea 2")).toBe("mi_variable_x<br>linea 2");
  });

  it("ignores injected stash markers", () => {
    expect(renderMarkdown("0")).toBe("0");
  });
});

describe("renderNotesMarkdown (AI call notes)", () => {
  /** What the model typically writes for the requested summary + action items. */
  const HAIKU = [
    "## Summary",
    "",
    "Carlos and Ana agreed to ship the **beta** on Friday.",
    "",
    "## Action Items",
    "",
    "- **Carlos**: send the release notes",
    "- Ana: review the budget",
    "  - check the *hosting* line",
    "  - confirm with finance",
    "- Both: demo on Monday",
  ].join("\n");

  it("renders the summary and a nested bulleted list of action items", () => {
    expect(renderNotesMarkdown(HAIKU)).toBe(
      "<h3>Summary</h3>" +
        "<p>Carlos and Ana agreed to ship the <strong>beta</strong> on Friday.</p>" +
        "<h3>Action Items</h3>" +
        "<ul><li><strong>Carlos</strong>: send the release notes</li>" +
        "<li>Ana: review the budget" +
        "<ul><li>check the <em>hosting</em> line</li><li>confirm with finance</li></ul>" +
        "</li><li>Both: demo on Monday</li></ul>",
    );
  });

  it("accepts every bullet style the model uses, and numbered lists with their start", () => {
    expect(renderNotesMarkdown("* one\n+ two\n• three")).toBe(
      "<ul><li>one</li><li>two</li><li>three</li></ul>",
    );
    expect(renderNotesMarkdown("1. first\n2) second")).toBe(
      "<ol><li>first</li><li>second</li></ol>",
    );
    expect(renderNotesMarkdown("3. third\n4. fourth")).toBe(
      '<ol start="3"><li>third</li><li>fourth</li></ol>',
    );
    expect(renderNotesMarkdown("1. step\n- note")).toBe(
      "<ol><li>step</li></ol><ul><li>note</li></ul>",
    );
  });

  it("keeps a loose list (blank lines between items) as one list", () => {
    expect(renderNotesMarkdown("- a\n\n- b\n\nAfter.")).toBe(
      "<ul><li>a</li><li>b</li></ul><p>After.</p>",
    );
  });

  it("joins an item's wrapped lines and closes lists before headings and rules", () => {
    expect(renderNotesMarkdown("- a long\n  item\n---\n# Next")).toBe(
      "<ul><li>a long<br>item</li></ul><hr><h3>Next</h3>",
    );
  });

  it("renders checkboxes as marks, not form fields", () => {
    expect(renderNotesMarkdown("- [ ] todo\n- [x] done")).toBe(
      '<ul><li class="task"><span class="check" aria-label="To do">☐</span> todo</li>' +
        '<li class="task"><span class="check" aria-label="Done">☑</span> done</li></ul>',
    );
  });

  it("caps nesting depth, closing every list it opened", () => {
    const deep = Array.from({ length: 8 }, (_, i) => `${"  ".repeat(i)}- level ${i}`).join("\n");
    const html = renderNotesMarkdown(deep);
    expect(html.match(/<ul>/g)).toHaveLength(MAX_LIST_DEPTH);
    expect(html.match(/<\/ul>/g)).toHaveLength(MAX_LIST_DEPTH);
    expect(html.match(/<li>/g)).toHaveLength(8);
  });

  it("does not mistake bold or arithmetic for bullets or italics", () => {
    expect(renderNotesMarkdown("**Decisions:** none\n2 * 3 * 4")).toBe(
      "<p><strong>Decisions:</strong> none<br>2 * 3 * 4</p>",
    );
  });

  it("escapes HTML a transcript may have smuggled into the model's output", () => {
    const html = renderNotesMarkdown(
      [
        '- <img src=x onerror="alert(1)">',
        "- <script>alert(1)</script>",
        '## <a href="javascript:alert(1)">x</a>',
        "> <iframe src=//evil>",
        "```",
        "</pre><script>alert(1)</script>",
        "```",
      ].join("\n"),
    );
    expect(html).not.toMatch(/<(img|script|iframe|a)\b/i);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("<pre><code>&lt;/pre&gt;&lt;script&gt;");
  });

  it("links http(s) only, from bare URLs or [label](url), and never javascript: links", () => {
    expect(renderNotesMarkdown("- see [the doc](https://mindfultech.ec/d?a=1&b=2)")).toBe(
      '<ul><li>see <a href="https://mindfultech.ec/d?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">the doc</a></li></ul>',
    );
    expect(renderNotesMarkdown("[click](javascript:alert(1))")).toBe(
      "<p>[click](javascript:alert(1))</p>",
    );
    expect(renderNotesMarkdown('[x](https://a.ec/"onmouseover="alert(1))')).not.toMatch(
      /href="[^"]*"onmouseover/,
    );
  });

  it("ignores injected stash markers", () => {
    expect(renderNotesMarkdown("- 0")).toBe("<ul><li>0</li></ul>");
  });
});

describe("GFM tables and strikethrough (renderNotesMarkdown)", () => {
  it("renders a table: header cells, body rows, inline formatting inside", () => {
    const html = renderNotesMarkdown(
      "| Column | Column |\n| --- | --- |\n| **bold** | `code` |\n| plain | [x](https://example.com) |",
    );
    expect(html).toBe(
      '<div class="table-wrap"><table><thead><tr><th>Column</th><th>Column</th></tr></thead>' +
        "<tbody><tr><td><strong>bold</strong></td><td><code>code</code></td></tr>" +
        '<tr><td>plain</td><td><a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a></td></tr>' +
        "</tbody></table></div>",
    );
  });

  it("reads alignment, tables without outer pipes, and the text around them", () => {
    const html = renderNotesMarkdown(
      "Before\n\nFile | Size | Kind\n:--- | ---: | :---:\nSKILL.md | 22 KB | md\n\nAfter",
    );
    expect(html).toContain(
      '<th class="align-left">File</th><th class="align-right">Size</th><th class="align-center">Kind</th>',
    );
    expect(html).toContain('<td class="align-right">22 KB</td>');
    expect(html.startsWith('<p>Before</p><div class="table-wrap">')).toBe(true);
    expect(html.endsWith("</table></div><p>After</p>")).toBe(true);
  });

  it("pads short rows, cuts long ones, and ends at the first line without a pipe", () => {
    const html = renderNotesMarkdown("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\nnot a row");
    expect(html).toContain("<tr><td>1</td><td></td></tr>");
    expect(html).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(html).not.toContain("<td>3</td>");
    expect(html.endsWith("</table></div><p>not a row</p>")).toBe(true);
    // A header alone is still a table.
    expect(renderNotesMarkdown("| a |\n|---|")).toBe(
      '<div class="table-wrap"><table><thead><tr><th>a</th></tr></thead></table></div>',
    );
  });

  it("keeps escaped pipes and pipes in code spans inside their cell", () => {
    expect(splitTableRow("| a \\| b | `x | y` | c |")).toEqual(["a | b", "`x | y`", "c"]);
    const html = renderNotesMarkdown("| cmd | note |\n|---|---|\n| `ls | wc -l` | a \\| b |");
    expect(html).toContain("<td><code>ls | wc -l</code></td><td>a | b</td>");
  });

  it("isn't fooled: pipes in prose, a rule under a line, mismatched columns", () => {
    expect(renderNotesMarkdown("this | that\nand more")).toBe("<p>this | that<br>and more</p>");
    expect(renderNotesMarkdown("a | b\n---")).not.toContain("<table>");
    expect(renderNotesMarkdown("| a | b |\n| --- |")).not.toContain("<table>");
    expect(renderNotesMarkdown("- item\n\n---")).toContain("<hr>");
  });

  it("escapes HTML in cells like everywhere else", () => {
    const html = renderNotesMarkdown(
      '| <script>alert(1)</script> | <img src=x onerror="y"> |\n|---|---|',
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("strikes through ~~text~~, but not lone tildes", () => {
    expect(renderNotesMarkdown("~~old~~ new")).toBe("<p><del>old</del> new</p>");
    expect(renderNotesMarkdown("~ 5 min ~~")).toBe("<p>~ 5 min ~~</p>");
    // Chat messages keep their own rules.
    expect(renderMarkdown("~~old~~")).toBe("~~old~~");
  });
});
