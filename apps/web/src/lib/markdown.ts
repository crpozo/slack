const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<]*[^\s<.,;:!?)\]'"]/g;

/**
 * Light markdown → HTML: ```blocks```, `code`, **bold**, _italic_, links and
 * line breaks. The input is HTML-escaped first, so the output is safe to
 * inject; code and links are stashed so other rules never touch them.
 */
export function renderMarkdown(text: string): string {
  const stash: string[] = [];
  const keep = (html: string) => `\uE000${stash.push(html) - 1}\uE000`;

  let html = escapeHtml(text.replace(/\uE000/g, ""));

  html = html.replace(/```(?:\n)?([\s\S]*?)```/g, (_, code: string) =>
    keep(`<pre><code>${code}</code></pre>`),
  );
  html = html.replace(/`([^`\n]+)`/g, (_, code: string) => keep(`<code>${code}</code>`));
  html = html.replace(URL_PATTERN, (url) =>
    keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`),
  );
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, "$1<em>$2</em>");
  html = html.replace(/\n/g, "<br>");

  return html.replace(/\uE000(\d+)\uE000/g, (_, i: string) => stash[Number(i)] ?? "");
}
