/**
 * React pages: a `.tsx` or `.jsx` file whose default export is a component. The page server answers
 * its path with a shell page, and the shell loads `<path>?bundle`, which esbuild builds from the file
 * with the React this package ships and the `pi-kit` module (assets/pi-kit.tsx). A build error or a
 * render error shows on the page instead of a blank one.
 */

import { build } from "esbuild";
import { createRequire } from "node:module";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REACT_FILE = /\.(tsx|jsx)$/i;

const require = createRequire(import.meta.url);
/** The node_modules holding this package's React, so a page anywhere on disk resolves the same copy. */
const REACT_MODULES = dirname(dirname(require.resolve("react/package.json")));
const PI_KIT = fileURLToPath(new URL("../assets/pi-kit.tsx", import.meta.url));

const escape = (text: string): string => text.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);

/** The page a React file is served as; its bundle loads from the same path with `?bundle`. */
export function reactShell(path: string, url: string, source: string): string {
  return [
    "<!doctype html>",
    // The kit's own words (the feedback panel) follow the page's language.
    /[\u3400-\u9fff]/.test(source) ? '<html lang="zh-Hant">' : "<html>",
    '<meta charset="utf-8">',
    `<title>${escape(basename(path))}</title>`,
    '<body>\n<div id="pi-root"></div>',
    `<script type="module" src="${escape(url)}?bundle"></script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

const entry = (path: string): string => `
import { Component, createElement } from "react";
import { createRoot } from "react-dom/client";
import Page from ${JSON.stringify(path)};
import { Callout } from "pi-kit";

class Boundary extends Component {
  state = { error: undefined };
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return createElement(Callout, { tone: "risk", title: "This page failed to render" }, createElement("pre", null, String(this.state.error.stack ?? this.state.error)));
  }
}

if (typeof Page !== "function") throw new Error(${JSON.stringify(`${basename(path)} must export a React component as its default export`)});
createRoot(document.getElementById("pi-root")).render(createElement(Boundary, null, createElement(Page)));
`;

/** A script that shows why a page could not be built. */
const failure = (message: string): string => `
const box = document.createElement("pi-callout");
box.setAttribute("tone", "risk");
box.setAttribute("title", "This page could not be built");
const pre = document.createElement("pre");
pre.textContent = ${JSON.stringify(message)};
box.append(pre);
document.getElementById("pi-root").replaceChildren(box);
`;

/** Builds the page's bundle on each load, so an edit shows on the next reload. */
export async function bundleReactPage(path: string): Promise<string> {
  try {
    const result = await build({
      stdin: { contents: entry(path), resolveDir: dirname(path), loader: "jsx", sourcefile: "pi-page-entry.jsx" },
      // Error locations then name the page's own files by their short paths.
      absWorkingDir: dirname(path),
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      nodePaths: [REACT_MODULES],
      alias: { "pi-kit": PI_KIT },
      define: { "process.env.NODE_ENV": '"production"' },
      // The kit styles the page; a stylesheet import adds nothing.
      loader: { ".css": "empty" },
      logLevel: "silent",
    });
    return result.outputFiles[0].text;
  } catch (error) {
    const errors = (error as { errors?: { text: string; location?: { file: string; line: number; column: number } | null }[] }).errors;
    const message = errors?.length
      ? errors.map(({ text, location }) => (location ? `${location.file}:${location.line}:${location.column}: ${text}` : text)).join("\n")
      : String((error as Error).message ?? error);
    return failure(message);
  }
}
