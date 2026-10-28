import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPageServer } from "../src/index.ts";
import { bundleReactPage, reactShell } from "../src/react.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "doc-review-react-")));
const write = (name: string, source: string): string => {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
};

try {
  // The shell: a root, the bundle from the same path, and the page's language.
  assert.equal(
    reactShell("/x/page.tsx", "/tok/files/x/page.tsx", "export default () => <p>中文</p>"),
    '<!doctype html>\n<html lang="zh-Hant">\n<meta charset="utf-8">\n<title>page.tsx</title>\n<body>\n<div id="pi-root"></div>\n<script type="module" src="/tok/files/x/page.tsx?bundle"></script>\n</body>\n</html>\n',
  );
  assert.match(reactShell("/x/a.jsx", "/a.jsx", "plain"), /^<!doctype html>\n<html>\n/);

  // A page anywhere on disk bundles with the package's React and pi-kit, and a sibling module of its own.
  write("helper.ts", "export const label = (n: number): string => `n=${n}`;\n");
  write("style.css", "p { color: red }\n");
  const page = write(
    "page.tsx",
    'import { useState } from "react";\nimport { Callout, send } from "pi-kit";\nimport { label } from "./helper";\nimport "./style.css";\n' +
      "export default function Page() { const [n] = useState(1); return <Callout tone=\"ok\" title={label(n)}><button onClick={() => send({ n: String(n) })}>go</button></Callout>; }\n",
  );
  const bundle = await bundleReactPage(page);
  assert.match(bundle, /createRoot/);
  assert.match(bundle, /n=\$\{n\}/, "the sibling module is bundled");
  assert.match(bundle, /"pi-callout"/, "pi-kit is bundled");
  assert.ok(!bundle.includes("color: red"), "a stylesheet import adds nothing");
  assert.ok(!bundle.includes("sourceMappingURL"));

  // A build error becomes a script that shows it, naming the page by its short path.
  const broken = await bundleReactPage(write("broken.tsx", "export default function P() { return <div>oops</div }\n"));
  assert.match(broken, /This page could not be built/);
  assert.match(broken, /broken\.tsx:1:52: Expected \\">\\" but found \\"}\\"/);
  const missing = await bundleReactPage(write("missing.tsx", 'import x from "no-such-package";\nexport default () => x;\n'));
  assert.match(missing, /Could not resolve \\"no-such-package\\"/);

  // The page server: the shell with kit and page script at the file's path, the bundle with ?bundle, and the renderers.
  const server = await createPageServer(() => {}, (path) => path.startsWith(`${dir}/`));
  try {
    const url = `${server.base}/files${pathToFileURL(page).pathname}`;
    const shell = await fetch(url);
    assert.equal(shell.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await shell.text();
    assert.match(html, /<div id="pi-root"><\/div>/);
    assert.match(html, /\/kit\/kit\.css/);
    assert.match(html, /window\.piDocReview = \{ base, send \}/);
    const script = await fetch(`${url}?bundle`);
    assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(await script.text(), /createRoot/);
    assert.equal((await fetch(`${server.base}/files/etc/x.tsx?bundle`)).status, 404, "only allowed pages bundle");

    const markdown = await fetch(`${server.base}/render/markdown`, { method: "POST", body: "> [!TIP]\n> hi" });
    assert.match(await markdown.text(), /<pi-callout tone="ok" title="Tip">/);
    const diagram = await fetch(`${server.base}/render/mermaid`, { method: "POST", body: "graph LR\n  A --> B" });
    assert.match(await diagram.text(), /^<figure class="pi-diagram"><svg /);
    const bad = await fetch(`${server.base}/render/mermaid`, { method: "POST", body: "nonsense" });
    assert.equal(bad.status, 422);
    assert.match(await bad.text(), /Invalid mermaid header/);
    assert.equal((await fetch(`${new URL(server.base).origin}/render/markdown`, { method: "POST", body: "x" })).status, 405, "not without the token");
  } finally {
    server.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
