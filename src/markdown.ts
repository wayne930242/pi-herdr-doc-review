/**
 * Renders a Markdown page for the page server. The agent writes plain Markdown; the kit gives it its
 * look, and these additions turn familiar notations into kit elements:
 *
 * - GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`, with an optional
 *   title after the marker) become `<pi-callout>`.
 * - A `mermaid` code block becomes an SVG diagram, drawn on the server by beautiful-mermaid.
 * - `cards`, `options`, and `form` code blocks hold YAML and become `<pi-grid>`, `<pi-options>`, and
 *   `<pi-form>`; their text fields are Markdown.
 * - A `diff` code block colours added, removed, and hunk lines.
 *
 * Raw HTML passes through, so kit elements can also be written as tags.
 */

import { renderMermaidSVG } from "beautiful-mermaid";
import MarkdownIt from "markdown-it";
import { parse as parseYaml } from "yaml";

export const MARKDOWN_FILE = /\.(md|markdown)$/i;

const ALERTS: Record<string, { tone: string; label: string }> = {
  NOTE: { tone: "note", label: "Note" },
  TIP: { tone: "ok", label: "Tip" },
  IMPORTANT: { tone: "note", label: "Important" },
  WARNING: { tone: "warn", label: "Warning" },
  CAUTION: { tone: "risk", label: "Caution" },
};
const ALERT_LINE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*([^\n]*)\n?/i;

const md = new MarkdownIt({ html: true, linkify: true });

const escape = (text: string): string => md.utils.escapeHtml(text);
const attr = (name: string, value: unknown): string =>
  value === undefined || value === null || value === false ? "" : value === true ? ` ${name}` : ` ${name}="${escape(String(value))}"`;
/** A YAML text field: Markdown, rendered inline when it is one line. */
const prose = (text: unknown): string => {
  if (text === undefined || text === null) return "";
  const source = String(text).trim();
  return source.includes("\n") ? md.render(source) : md.renderInline(source);
};
const list = (value: unknown): string[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value.map(String) : String(value).split(";").map((item) => item.trim()).filter(Boolean);

/** A block that could not be drawn shows why, with its source, instead of failing the page. */
const failed = (what: string, error: unknown, source: string): string =>
  `<pi-callout tone="risk" title="${escape(`This ${what} could not be rendered`)}"><p>${escape((error as Error).message ?? String(error))}</p><pre><code>${escape(source)}</code></pre></pi-callout>\n`;

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`each ${what} must be a mapping`);
  return value as Record<string, unknown>;
};
/** A block's items: a YAML list, or a mapping holding the list under `key`. */
const items = (data: unknown, key: string): unknown[] => {
  if (Array.isArray(data)) return data;
  const found = data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(found)) throw new Error(`expected a YAML list, or a mapping with a \`${key}\` list`);
  return found;
};

export function renderMermaid(source: string): string {
  const svg = renderMermaidSVG(source, { bg: "var(--pi-bg)", fg: "var(--pi-fg)", accent: "var(--pi-accent)", transparent: true });
  // The page loads nothing from other sites, so the diagram's web font import is dropped for the page's own font.
  return `<figure class="pi-diagram">${svg.replace(/@import url\([^)]*\);?/g, "")}</figure>\n`;
}

function renderCards(data: unknown): string {
  const cards = items(data, "cards").map((item) => {
    const card = record(item, "card");
    return `<pi-card${attr("title", card.title)}${attr("tone", card.tone)}>${prose(card.body)}</pi-card>`;
  });
  return `<pi-grid>\n${cards.join("\n")}\n</pi-grid>\n`;
}

function renderOptions(data: unknown): string {
  const options = items(data, "options").map((item) => {
    const option = record(item, "option");
    const recommended = option.recommended === true ? true : option.recommended || undefined;
    const pros = list(option.pros);
    const cons = list(option.cons);
    return [
      `<pi-option${attr("title", option.title)}${attr("recommended", recommended)}>`,
      prose(option.body),
      pros.length > 0 ? `<ul class="pi-pros">${pros.map((pro) => `<li>${md.renderInline(pro)}</li>`).join("")}</ul>` : "",
      cons.length > 0 ? `<ul class="pi-cons">${cons.map((con) => `<li>${md.renderInline(con)}</li>`).join("")}</ul>` : "",
      "</pi-option>",
    ].join("");
  });
  return `<pi-options>\n${options.join("\n")}\n</pi-options>\n`;
}

function renderForm(data: unknown): string {
  const form = Array.isArray(data) ? { questions: data } : record(data, "form");
  const questions = items(form, "questions").map((item) => {
    const question = record(item, "question");
    const choices: unknown[] = Array.isArray(question.choices) ? question.choices : list(question.choices);
    const rendered = choices.map((entry) => {
      const choice = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : { label: entry };
      const label = String(choice.label ?? choice.value ?? "");
      const recommended = choice.recommended === true ? true : choice.recommended || undefined;
      return `<pi-choice${attr("value", choice.value ?? label)}${attr("note", choice.note)}${attr("recommended", recommended)}>${escape(label)}</pi-choice>`;
    });
    return [
      `<pi-question${attr("name", question.name ?? question.label)}${attr("label", question.label)}${attr("type", question.type)}`,
      `${attr("hint", question.hint)}${attr("required", question.required === true)}${attr("other", question.other === true ? "" : question.other)}>`,
      rendered.join(""),
      "</pi-question>",
    ].join("");
  });
  return `<pi-form${attr("title", form.title)}${attr("submit", form.submit)}>\n${questions.join("\n")}\n</pi-form>\n`;
}

function renderDiff(source: string): string {
  const lines = source.replace(/\n$/, "").split("\n").map((line) => {
    const kind = line.startsWith("@@") ? "pi-hunk" : line.startsWith("+") ? "pi-add" : line.startsWith("-") ? "pi-del" : "";
    return `<span${kind ? ` class="${kind}"` : ""}>${escape(line) || " "}</span>`;
  });
  // One block per line, so a line's tint spans the block's width without overflowing it.
  return `<pre class="pi-diff"><code>${lines.join("")}</code></pre>\n`;
}

const BLOCKS: Record<string, (source: string) => string> = {
  mermaid: renderMermaid,
  cards: (source) => renderCards(parseYaml(source)),
  options: (source) => renderOptions(parseYaml(source)),
  form: (source) => renderForm(parseYaml(source)),
  diff: renderDiff,
};

const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const kind = token.info.trim().split(/\s+/)[0].toLowerCase();
  const render = BLOCKS[kind];
  if (!render) return defaultFence(tokens, index, options, env, self);
  try {
    return render(token.content);
  } catch (error) {
    return failed(`${kind} block`, error, token.content);
  }
};

/** Turns a blockquote that starts with a GitHub alert marker into a `<pi-callout>`. */
md.core.ruler.after("block", "pi-alerts", (state) => {
  const tokens = state.tokens;
  for (let index = 0; index < tokens.length; index++) {
    const open = tokens[index];
    const inline = tokens[index + 2];
    if (open.type !== "blockquote_open" || tokens[index + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const marker = ALERT_LINE.exec(inline.content);
    if (!marker) continue;
    const alert = ALERTS[marker[1].toUpperCase()];
    inline.content = inline.content.slice(marker[0].length);
    if (inline.content.trim() === "") {
      tokens[index + 1].hidden = true;
      tokens[index + 3].hidden = true;
    }
    open.tag = "pi-callout";
    open.attrSet("tone", alert.tone);
    open.attrSet("title", marker[2].trim() || alert.label);
    for (let close = index + 1; close < tokens.length; close++) {
      if (tokens[close].type === "blockquote_close" && tokens[close].level === open.level) {
        tokens[close].tag = "pi-callout";
        break;
      }
    }
  }
});

/** A Markdown fragment, with the same blocks and alerts a page has. */
export function renderMarkdown(source: string): string {
  return md.render(source);
}

/** The whole page: its title is the first `# heading`, else the file name; Chinese text marks it zh-Hant. */
export function renderMarkdownPage(source: string, name: string): string {
  const title = /^#[ \t]+(.+)$/m.exec(source)?.[1].trim() ?? name;
  // The kit's own words (the feedback panel) follow the page's language.
  const lang = /[\u3400-\u9fff]/.test(source) ? ' lang="zh-Hant"' : "";
  return `<!doctype html>\n<html${lang}>\n<meta charset="utf-8">\n<title>${escape(title)}</title>\n<body>\n${md.render(source)}</body>\n</html>\n`;
}
