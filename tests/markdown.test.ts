import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPageServer, pageFeedbackMessage } from "../src/index.ts";
import { renderMarkdownPage } from "../src/markdown.ts";

const page = (source: string) => renderMarkdownPage(source, "page.md");

// The page: a full document titled by its first heading, Chinese pages marked zh-Hant.
{
  const html = page("# 標題\n\n段落 **粗體**\n");
  assert.match(html, /^<!doctype html>\n<html lang="zh-Hant">\n<meta charset="utf-8">\n<title>標題<\/title>/);
  assert.match(html, /<p>段落 <strong>粗體<\/strong><\/p>/);
  assert.match(page("plain"), /<html>\n.*\n<title>page\.md<\/title>/s, "no heading: the file name; no Chinese: no lang");
  assert.match(page("<pi-badge tone=\"ok\">ok</pi-badge>"), /<pi-badge tone="ok">ok<\/pi-badge>/, "raw HTML passes through");
}

// GitHub alerts become callouts: tone by type, the default or given title, the marker line removed.
{
  const html = page("> [!WARNING] 注意\n> 會覆寫\n\n> [!TIP]\n> 小技巧\n\n> [!CAUTION]\n\n> plain quote\n");
  assert.match(html, /<pi-callout tone="warn" title="注意">\n<p>會覆寫<\/p>\n<\/pi-callout>/);
  assert.match(html, /<pi-callout tone="ok" title="Tip">\n<p>小技巧<\/p>\n<\/pi-callout>/);
  assert.match(html, /<pi-callout tone="risk" title="Caution"><\/pi-callout>/, "an alert with no body leaves no empty paragraph");
  assert.match(html, /<blockquote>\n<p>plain quote<\/p>\n<\/blockquote>/);
}

// Code blocks: mermaid draws an SVG without the remote font, YAML blocks become kit elements, diff lines are tinted.
{
  const diagram = page("```mermaid\ngraph LR\n  A[開始] --> B[結束]\n```\n");
  assert.match(diagram, /<figure class="pi-diagram"><svg /);
  assert.ok(!diagram.includes("fonts.googleapis.com"), "nothing loads from another site");

  const cards = page("```cards\n- {title: X, tone: ok, body: \"**1**\"}\n- title: Y\n```\n");
  assert.match(cards, /<pi-grid>\n<pi-card title="X" tone="ok"><strong>1<\/strong><\/pi-card>\n<pi-card title="Y"><\/pi-card>\n<\/pi-grid>/);

  const options = page("```options\n- title: A\n  recommended: true\n  pros: [快, \"有 ; 分號\"]\n  cons: 貴; 慢\n  body: 說明\n- title: B\n```\n");
  assert.match(options, /<pi-option title="A" recommended>說明<ul class="pi-pros"><li>快<\/li><li>有 ; 分號<\/li><\/ul><ul class="pi-cons"><li>貴<\/li><li>慢<\/li><\/ul><\/pi-option>/);
  assert.match(options, /<pi-option title="B"><\/pi-option>/);

  const form = page("```form\ntitle: 決定\nsubmit: 送出\nquestions:\n  - name: s\n    label: 哪個？\n    required: true\n    other: true\n    choices: [A, {value: b, label: \"B <x>\", note: n, recommended: 建議}]\n  - label: 補充\n```\n");
  assert.match(form, /<pi-form title="決定" submit="送出">/);
  assert.match(form, /<pi-question name="s" label="哪個？" required other=""><pi-choice value="A">A<\/pi-choice><pi-choice value="b" note="n" recommended="建議">B &lt;x&gt;<\/pi-choice><\/pi-question>/);
  assert.match(form, /<pi-question name="補充" label="補充"><\/pi-question>/, "a question without a name is named by its label");

  const diff = page("```diff\n@@ a @@\n-old\n+new\n same\n```\n");
  assert.match(diff, /<pre class="pi-diff"><code><span class="pi-hunk">@@ a @@<\/span><span class="pi-del">-old<\/span><span class="pi-add">\+new<\/span><span> same<\/span><\/code><\/pre>/);

  assert.match(page("```js\nlet a = 1 < 2;\n```\n"), /<pre><code class="language-js">let a = 1 &lt; 2;\n<\/code><\/pre>/, "other code blocks stay code");
}

// A block that cannot be drawn shows why and its source, instead of failing the page.
{
  const broken = page("# T\n\n```options\ntitle: not a list\n```\n\n```mermaid\nnot a diagram\n```\n\nafter\n");
  assert.match(broken, /<pi-callout tone="risk" title="This options block could not be rendered"><p>expected a YAML list, or a mapping with a `options` list<\/p><pre><code>title: not a list\n<\/code><\/pre><\/pi-callout>/);
  assert.match(broken, /title="This mermaid block could not be rendered"/);
  assert.match(broken, /<p>after<\/p>/);
}

// Page feedback: each passage quoted with its comment, then the overall note.
{
  const fields = new URLSearchParams([
    ["pi-kind", "feedback"],
    ["page", "快取"],
    ["quote", "第一行\n第二行"],
    ["comment", "為什麼？"],
    ["quote", "另一段"],
    ["comment", ""],
    ["overall", "方向 OK"],
  ]);
  assert.equal(pageFeedbackMessage(fields), 'User feedback on the page "快取":\n\n> 第一行\n> 第二行\n為什麼？\n\n> 另一段\n(no comment)\n\nOverall: 方向 OK');
  assert.equal(pageFeedbackMessage(new URLSearchParams([["page", "p"], ["overall", "only"]])), 'User feedback on the page "p":\n\nOverall: only');
}

// The page server serves a Markdown file as its rendered page, with the kit and page script.
{
  const dir = mkdtempSync(join(tmpdir(), "doc-review-md-"));
  writeFileSync(join(dir, "report.md"), "# Report\n\n> [!NOTE]\n> hi\n");
  const server = await createPageServer(() => {}, () => true);
  try {
    const response = await fetch(`${server.base}/files${pathToFileURL(join(dir, "report.md")).pathname}`);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await response.text();
    assert.match(html, /<title>Report<\/title>/);
    assert.match(html, /<pi-callout tone="note" title="Note">/);
    assert.match(html, /<\/html>\n\n<link rel="stylesheet" href="[^"]+\/kit\/kit\.css">/);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
