/**
 * Review pane for documents the agent wants the user to read, inside Herdr.
 *
 * `show_doc` opens files in one editable nvim or vim per session, split to the right of the
 * agent's pane, with the documents stacked as rows. The editor polls a command file in its scratch
 * directory on a timer, so both editors take new rows and reloads without a remote-control build. When the agent writes a Mini SDD
 * `docs/specs/<slug>/spec.md` whose header says `Status: proposed`, the folder's phase files
 * (decision, spec, design, verification) open the same way without a tool call, and a phase file
 * written later in a folder already on screen joins as a new row. Agent edits reload in place.
 *
 * Nothing waits for the user: the tool returns once the pane is open. When the user saves a shown
 * document, the diff from the version the agent last saw goes to the agent as review feedback,
 * steered into a running turn or attached to the user's next message when idle, so a save never
 * starts a turn by itself.
 *
 * HTML files and images open rendered and view-only in one browser pane per session instead: Chawan (`cha`)
 * when it is on PATH, otherwise terminal-browser; PI_HERDR_DOC_REVIEW_BROWSER picks one. A form whose
 * action is `cgi-bin:pi-answer` sends its fields to the agent the same way a save does, in both.
 *
 * terminal-browser (Chromium drawn through kitty graphics) loads pages from a local HTTP server that
 * lives with its pane: the server adds a script to each HTML page that posts such a form back to the
 * server and reloads the page when the server says it changed. New pages open as new tabs through
 * `terminal-browser new-tab`.
 *
 * Chawan instead runs a start-up script that polls its own command file the same way the editor
 * does, so new pages and reloads after the agent changes a page arrive without restarting it. It runs
 * the form's local CGI script from the scratch directory, which appends the query string to an
 * answers file. Chawan blocks a POST from a `file:` page to `cgi-bin:`, so the form submits with GET.
 *
 * Other viewers (a browser page, for one) read the same documents through pi's event bus:
 * `doc-review:documents` carries the full list on every change, and a `doc-review:form` event
 * delivers form answers to the agent exactly as a Chawan submission does, with its result on
 * `doc-review:form-result`. A viewer that starts late asks with `doc-review:documents-request`
 * and gets the current list again on `doc-review:documents`.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MARKDOWN_FILE, renderMarkdown, renderMarkdownPage, renderMermaid } from "./markdown.ts";
import { bundleReactPage, REACT_FILE, reactShell } from "./react.ts";

export const MINI_SDD_FILE = /(^|\/)docs\/specs\/[^/]+\/(decision|spec|design|verification)\.md$/;
export const MINI_SDD_PHASES = ["decision.md", "spec.md", "design.md", "verification.md"];
export const PROPOSED_STATUS = /^Status:\s*proposed\b/m;
export const MAX_DIFF_CHARS = 20_000;
const MESSAGE_TYPE = "doc-review";
export const EDITOR_ENV = "PI_HERDR_DOC_REVIEW_EDITOR";
export const EDITORS = ["nvim", "vim"];
export const POLL_MS = 250;
export const HTML_FILE = /\.html?$/i;
/** Images open in the browser pane beside HTML pages; an editor shows them as bytes. */
export const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
export const BROWSER_ENV = "PI_HERDR_DOC_REVIEW_BROWSER";
export const TERMINAL_BROWSER = "terminal-browser";
export const CHAWAN = "cha";
/** The user's default browser outside the terminal, opened with {@link OPENER}. */
export const EXTERNAL = "external";
/** The command that opens a URL in the default browser. */
export const OPENER = process.platform === "darwin" ? "open" : "xdg-open";
/** The browsers HTML review supports, in the order tried when PI_HERDR_DOC_REVIEW_BROWSER is unset. */
export const BROWSERS = [EXTERNAL, CHAWAN, TERMINAL_BROWSER];
const BROWSER_NAMES: Record<string, string> = { [TERMINAL_BROWSER]: "terminal-browser", [CHAWAN]: "Chawan", [EXTERNAL]: "the default browser" };
/** The command each browser needs on PATH. */
const browserCommand = (program: string): string => (program === EXTERNAL ? OPENER : program);
/** The local CGI script an HTML form names as `action="cgi-bin:pi-answer"` to send its fields to the agent. */
export const ANSWER_CGI = "pi-answer";
/** The document contract on pi's event bus; every payload carries `version`. */
export const DOCUMENTS_EVENT = "doc-review:documents";
export const FORM_EVENT = "doc-review:form";
export const FORM_RESULT_EVENT = "doc-review:form-result";
export const DOCUMENTS_REQUEST_EVENT = "doc-review:documents-request";
export const CONTRACT_VERSION = 1;
/** The list keeps the most recently shown documents. */
export const MAX_DOCUMENTS = 32;
/** Form results remembered so a repeated `answerId` replays instead of delivering twice. */
export const MAX_REMEMBERED_ANSWERS = 256;
/** How often the panes are checked, so a pane the user closed is reported within a second or so. */
export const PANE_CHECK_MS = 1000;
const READY_WAIT_MS = 5000;
const READY_POLL_MS = 100;
/** terminal-browser starts Chromium before it lists itself, so a second page waits this long for it. */
export const TERMINAL_BROWSER_WAIT_MS = 15_000;
const TERMINAL_BROWSER_POLL_MS = 250;
/** The largest form submission the page server reads. */
const MAX_ANSWER_BYTES = 1_000_000;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The local HTTP server terminal-browser loads pages from. */
export interface PageServer {
  /** `http://127.0.0.1:<port>/<token>`: the page at absolute path `/a/b.html` is `<base>/files/a/b.html`. */
  base: string;
  /** Tells every open copy of the page at `path` to reload. */
  reload: (path: string) => void;
  close: () => void;
}

export interface DocReviewDeps {
  paneId: string | undefined;
  herdr: string;
  /** The editor the user chose through PI_HERDR_DOC_REVIEW_EDITOR, if any. */
  editor: string | undefined;
  /** The browser the user chose through PI_HERDR_DOC_REVIEW_BROWSER, if any. */
  browser: string | undefined;
  /** Starts a page server; `onAnswer` gets the query string of each submitted form. */
  servePages: (onAnswer: (query: string) => void, allowed: (path: string) => boolean) => Promise<PageServer>;
  onPath: (command: string) => boolean;
  pidAlive: (pid: number) => boolean;
  run: (command: string, args: string[]) => RunResult;
  makeDir: () => string;
  removeDir: (dir: string) => void;
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, content: string, mode?: number) => void;
  appendFile: (path: string, content: string) => void;
  realpath: (path: string) => string;
  watch: (path: string, onChange: () => void) => () => void;
  sleep: (ms: number) => Promise<void>;
  /** Calls `tick` every `ms` until the returned function is called. */
  every: (ms: number, tick: () => void) => () => void;
  newId: () => string;
}

const defaultDeps: DocReviewDeps = {
  paneId: process.env.HERDR_PANE_ID,
  herdr: process.env.HERDR_BIN_PATH ?? "herdr",
  editor: process.env[EDITOR_ENV],
  browser: process.env[BROWSER_ENV],
  servePages: (onAnswer, allowed) => createPageServer(onAnswer, allowed),
  onPath: (command) => spawnSync("sh", ["-c", 'command -v "$1"', "sh", command], { stdio: "ignore" }).status === 0,
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  run: (command, args) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
  },
  makeDir: () => mkdtempSync(join(tmpdir(), "pi-doc-review-")),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  writeFile: (path, content, mode) => writeFileSync(path, content, { mode }),
  appendFile: (path, content) => appendFileSync(path, content),
  realpath: (path) => (existsSync(path) ? realpathSync(path) : path),
  watch: (path, onChange) => {
    const listener = (): void => onChange();
    watchFile(path, { interval: 500 }, listener);
    return () => unwatchFile(path, listener);
  },
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
  newId: randomUUID,
};

interface Viewer {
  pane: string;
  editor: string;
  dir: string;
  control: string;
  ready: string;
  log: string;
  logOffset: number;
  stopWatch: () => void;
}

/** The browser pane; each browser program supplies the ways to open, reload, and quit. */
interface Browser {
  program: string;
  pane: string;
  dir: string;
  ready: string;
  /** Opens pages in the running browser, each as its own buffer or tab. */
  open: (paths: string[]) => Promise<void>;
  reload: (path: string) => void;
  /** Asks the browser to quit; its pane's shell then removes the scratch dir. */
  quit: () => void;
  /** Stops listening for its form answers. */
  stop: () => void;
  /** Set once its pane's shell is up, so the pane check does not take a starting browser for a quit one. */
  started: boolean;
}

/** A browser that is ready to run, and the command its pane's shell runs. */
type StartedBrowser = [Browser, string];

interface ShownDoc {
  display: string;
  snapshot: string;
}

type DocKind = "html" | "text";

/** A document as the event bus lists it. */
export interface PublishedDocument {
  id: string;
  path: string;
  kind: DocKind;
  display: string;
  reason: string;
  revision: number;
  onScreen: boolean;
}

interface DocEntry extends PublishedDocument {
  /** The content last published, so a revision bumps only when the file really changed. */
  seen: string;
  /** The pane showing it: a Markdown page is listed as text but shown in the browser. */
  screen: Screen;
}

type Screen = "editor" | "browser";
/** How show_doc opens a Markdown document: rendered as a page, or in the editor for review edits. */
export type View = "page" | "edit";

export interface FormResult {
  version: typeof CONTRACT_VERSION;
  id: string;
  answerId: string;
  accepted: boolean;
  reason?: string;
}

export interface ShowResult {
  opened: string[];
  text: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function vimLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Vimscript for both nvim and vim. A timer runs each new line of the command file; the ready file
 * holds the editor's pid; each save appends the path to the save log; quitting removes the scratch
 * directory, since the editor outlives the session when it holds unsaved edits.
 */
export function reviewScript(dir: string, control: string, ready: string, log: string): string {
  return [
    "set autoread",
    `let s:control = ${vimLiteral(control)}`,
    "let s:done = 0",
    "function! s:Poll(timer) abort",
    "  let lines = filereadable(s:control) ? readfile(s:control) : []",
    "  if len(lines) <= s:done",
    "    return",
    "  endif",
    "  let todo = lines[s:done :]",
    "  let s:done = len(lines)",
    "  for cmd in todo",
    "    try",
    "      execute cmd",
    "    catch",
    "    endtry",
    "  endfor",
    "endfunction",
    "function! PiDocReviewAdd(path) abort",
    "  for buf in getbufinfo({'buflisted': 1})",
    "    if fnamemodify(buf.name, ':p') ==# a:path && !empty(buf.windows)",
    "      return",
    "    endif",
    "  endfor",
    "  execute 'silent! botright split ' . fnameescape(a:path)",
    "  wincmd =",
    "endfunction",
    // `checktime` from a timer waits for the user's next key, so reload unmodified buffers directly.
    "function! PiDocReviewReload() abort",
    "  for buf in getbufinfo({'buflisted': 1})",
    "    if buf.changed || empty(buf.windows) || !filereadable(buf.name)",
    "      continue",
    "    endif",
    "    if readfile(buf.name) !=# getbufline(buf.bufnr, 1, '$')",
    "      call win_execute(buf.windows[0], 'silent! edit')",
    "    endif",
    "  endfor",
    "endfunction",
    "function! PiDocReviewClose() abort",
    "  if empty(filter(getbufinfo({'buflisted': 1}), 'v:val.changed'))",
    "    qall",
    "  endif",
    "endfunction",
    "augroup pi_doc_review",
    "  autocmd!",
    "  autocmd FocusGained,BufEnter * silent! checktime",
    `  autocmd BufWritePost * call writefile([expand('<afile>:p')], ${vimLiteral(log)}, 'a')`,
    `  autocmd VimLeave * call delete(${vimLiteral(dir)}, 'rf')`,
    "augroup END",
    `call writefile([string(getpid())], ${vimLiteral(ready)})`,
    `call timer_start(${POLL_MS}, function('s:Poll'), {'repeat': -1})`,
    "",
  ].join("\n");
}

/**
 * Chawan start-up script. A timer runs each new line of the command file as JavaScript in Chawan's
 * client context; a page reloads only while it is the current buffer, since Chawan reloads no other.
 */
export function browserScript(control: string): string {
  return [
    `const control = ${JSON.stringify(control)};`,
    "let done = 0;",
    "globalThis.piDocReviewReload = (url) => {",
    "  if (decodeURIComponent(String(pager.url)) === decodeURIComponent(url)) pager.reload();",
    "};",
    "setInterval(() => {",
    '  const lines = (readFile(control) ?? "").split("\\n").filter(Boolean);',
    "  const todo = lines.slice(done);",
    "  done = Math.max(done, lines.length);",
    "  for (const line of todo) {",
    "    try {",
    "      (0, eval)(line);",
    "    } catch {}",
    "  }",
    `}, ${POLL_MS});`,
    "",
  ].join("\n");
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] as string);

/**
 * The page Chawan shows an image in, fitted to the pane: opened on its own, an image waits on
 * Chawan's "Open as" prompt.
 */
export function imagePage(path: string): string {
  const name = escapeHtml(basename(path));
  return [
    '<!doctype html><meta charset="utf-8">',
    `<title>${name}</title>`,
    "<style>body{margin:0}img{max-width:100%;max-height:100vh}</style>",
    `<img src="${escapeHtml(pathToFileURL(path).href)}" alt="${name}">`,
    "",
  ].join("\n");
}

/** The local CGI script behind `cgi-bin:pi-answer`: it records one submitted form and confirms it. */
export function answerScript(answers: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$QUERY_STRING" >> ${shellQuote(answers)}`,
    "printf 'Content-Type: text/html; charset=utf-8\\n\\n<p>Sent to the agent. Press , to return to the page.</p>\\n'",
    "",
  ].join("\n");
}

/** The page kit the server adds to every HTML page, by the name it is served under `<base>/kit/`. */
export const KIT_FILES: Record<string, string> = {
  "kit.css": fileURLToPath(new URL("../assets/kit.css", import.meta.url)),
  "kit.js": fileURLToPath(new URL("../assets/kit.js", import.meta.url)),
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/**
 * What the page server adds to each HTML page: the page kit ({@link KIT_FILES}), and a script by
 * which a form whose action is `cgi-bin:pi-answer` posts its fields to the server instead of leaving
 * the page, `window.piDocReview.send(fields)` does the same for the kit's `<pi-form>`, and the page
 * reloads when the server sends `reload` for it.
 */
export function pageScript(base: string): string {
  return [
    `<link rel="stylesheet" href="${base}/kit/kit.css">`,
    `<script type="module" src="${base}/kit/kit.js"></script>`,
    "<script>(() => {",
    `  const base = ${JSON.stringify(base)};`,
    "  const note = (text) => {",
    '    const box = document.createElement("div");',
    "    box.textContent = text;",
    '    box.style.cssText = "position:fixed;right:1em;bottom:1em;padding:.5em 1em;background:#222;color:#fff;border-radius:4px;z-index:2147483647";',
    "    document.body.append(box);",
    "    setTimeout(() => box.remove(), 4000);",
    "  };",
    '  const send = (fields) => fetch(base + "/answer", { method: "POST", body: new URLSearchParams(fields).toString() }).then((response) => {',
    '    if (!response.ok) throw new Error("HTTP " + response.status);',
    "  });",
    "  window.piDocReview = { base, send };",
    '  document.addEventListener("submit", (event) => {',
    "    const form = event.target;",
    `    if (!(form instanceof HTMLFormElement) || form.getAttribute("action") !== ${JSON.stringify(`cgi-bin:${ANSWER_CGI}`)}) return;`,
    "    event.preventDefault();",
    "    const fields = new FormData(form, event.submitter);",
    "    const buttons = [...form.querySelectorAll(\"button, input[type=submit]\")].filter((button) => !button.disabled);",
    "    buttons.forEach((button) => (button.disabled = true));",
    "    const shown = new Promise((resolve) => setTimeout(resolve, 1000));",
    '    send(fields).then(',
    '      () => note("Sent to the agent."),',
    '      (error) => note("Not sent: " + error.message),',
    "    ).then(() => shown).then(() => buttons.forEach((button) => (button.disabled = false)));",
    "  }, true);",
    '  new EventSource(base + "/events?page=" + encodeURIComponent(location.pathname)).addEventListener("reload", () => location.reload());',
    "})();</script>",
    "",
  ].join("\n");
}

const finish = (response: ServerResponse, status: number): void => {
  response.statusCode = status;
  response.end();
};

/**
 * Pages may run their own inline and same-server scripts, but load nothing from elsewhere, so no
 * third-party script runs beside the files the server serves. A page can still navigate away.
 */
export const PAGE_POLICY = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'self'";

/**
 * Serves files to terminal-browser on 127.0.0.1 behind a random token, so only a page it was sent
 * to can load files or post answers. `GET <base>/files/<absolute path>` returns the file when its
 * real path passes `allowed`, an HTML file with {@link pageScript} added; `POST <base>/answer` hands
 * the body to `onAnswer`; `GET <base>/events?page=<page path>` is the event stream that tells a page
 * to reload. Every response carries {@link PAGE_POLICY}.
 */
export function createPageServer(onAnswer: (query: string) => void, allowed: (path: string) => boolean): Promise<PageServer> {
  const prefix = `/${randomUUID()}`;
  const filesPrefix = `${prefix}/files`;
  /** Open event streams by the absolute path of the page that opened them. */
  const streams = new Map<string, Set<ServerResponse>>();
  const pathOf = (urlPath: string): string | undefined => {
    if (!urlPath.startsWith(`${filesPrefix}/`)) return undefined;
    try {
      return fileURLToPath(`file://${urlPath.slice(filesPrefix.length)}`);
    } catch {
      return undefined;
    }
  };
  let base = "";
  const server = createServer((request, response) => {
    response.setHeader("content-security-policy", PAGE_POLICY);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    /** Reads a POST body of at most MAX_ANSWER_BYTES. */
    const body = (then: (text: string) => void): void => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > MAX_ANSWER_BYTES) request.destroy();
      });
      request.on("end", () => then(text));
    };
    if (url.pathname === `${prefix}/answer` && request.method === "POST") {
      return body((text) => {
        onAnswer(text);
        finish(response, 204);
      });
    }
    // React pages render Markdown and diagrams through the server, as Markdown pages do.
    const renderer = { [`${prefix}/render/markdown`]: renderMarkdown, [`${prefix}/render/mermaid`]: renderMermaid }[url.pathname];
    if (renderer && request.method === "POST") {
      return body((text) => {
        try {
          const html = renderer(text);
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(html);
        } catch (error) {
          response.writeHead(422, { "content-type": "text/plain; charset=utf-8" });
          response.end((error as Error).message ?? String(error));
        }
      });
    }
    if (request.method !== "GET") return finish(response, 405);
    if (url.pathname === `${prefix}/events`) {
      const page = pathOf(url.searchParams.get("page") ?? "");
      if (!page) return finish(response, 400);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(": open\n\n");
      const open = streams.get(page) ?? new Set();
      streams.set(page, open.add(response));
      response.on("close", () => open.delete(response));
      return;
    }
    if (url.pathname.startsWith(`${prefix}/kit/`)) {
      const kit = KIT_FILES[url.pathname.slice(`${prefix}/kit/`.length)];
      if (!kit) return finish(response, 404);
      response.writeHead(200, { "content-type": CONTENT_TYPES[extname(kit)] ?? "text/plain", "cache-control": "no-store" });
      return void response.end(readFileSync(kit));
    }
    const requested = pathOf(url.pathname);
    if (!requested) return finish(response, 404);
    let path: string;
    let content: Buffer;
    try {
      // The real path is what is checked and read, so a symlink cannot lead outside what is allowed.
      path = realpathSync(requested);
      if (!allowed(path)) return finish(response, 404);
      content = readFileSync(path);
    } catch {
      return finish(response, 404);
    }
    if (REACT_FILE.test(path)) {
      if (url.searchParams.has("bundle")) {
        return void bundleReactPage(path).then((script) => {
          response.writeHead(200, { "content-type": CONTENT_TYPES[".js"], "cache-control": "no-store" });
          response.end(script);
        });
      }
      response.writeHead(200, { "content-type": CONTENT_TYPES[".html"], "cache-control": "no-store" });
      return void response.end(`${reactShell(path, url.pathname, content.toString("utf8"))}\n${pageScript(base)}`);
    }
    // A Markdown file is served as the page it renders to.
    const markdown = MARKDOWN_FILE.test(path);
    const type = markdown ? CONTENT_TYPES[".html"] : (CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream");
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    const page = markdown ? Buffer.from(renderMarkdownPage(content.toString("utf8"), basename(path))) : HTML_FILE.test(path) ? content : undefined;
    response.end(page ? Buffer.concat([page, Buffer.from(`\n${pageScript(base)}`)]) : content);
  });
  server.unref();
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
      done({
        base,
        reload: (path) => {
          for (const stream of streams.get(path) ?? []) stream.write("event: reload\ndata:\n\n");
        },
        close: () => {
          for (const open of streams.values()) for (const stream of open) stream.end();
          streams.clear();
          server.close();
          server.closeAllConnections();
        },
      });
    });
  });
}

/** The user's edits as zero-context hunks: the `@@` headers carry the line numbers. */
function feedbackMessage(display: string, diff: string): string {
  const hunks = diff
    .split("\n")
    .filter((line) => !line.startsWith("--- ") && !line.startsWith("+++ "))
    .join("\n");
  const body = hunks.length > MAX_DIFF_CHARS ? `${hunks.slice(0, MAX_DIFF_CHARS)}\n… (truncated; read ${display})\n` : hunks;
  return `User edited ${display}:\n\`\`\`diff\n${body}\`\`\``;
}

/** The agent's view of one submitted form; the Chawan CGI path and the `form` event both build it here. */
export function formMessage(fields: Iterable<readonly [string, string]>): string {
  const lines = [...fields].map(([name, value]) => `- ${name}: ${value}`);
  return `User submitted a form in the HTML review pane:\n${lines.join("\n") || "(no fields)"}`;
}

/**
 * The agent's view of feedback sent from a page's feedback panel: each commented passage quoted with
 * its comment, then the overall note. The panel sends `pi-kind=feedback`, `page`, `quote`/`comment`
 * pairs, and `overall`.
 */
export function pageFeedbackMessage(fields: URLSearchParams): string {
  const quotes = fields.getAll("quote");
  const comments = fields.getAll("comment");
  const parts = quotes.map((quote, index) => {
    const quoted = quote ? quote.split("\n").map((line) => `> ${line}`).join("\n") : "";
    return [quoted, comments[index] || "(no comment)"].filter(Boolean).join("\n");
  });
  const overall = fields.get("overall");
  if (overall) parts.push(`Overall: ${overall}`);
  return `User feedback on the page "${fields.get("page") ?? ""}":\n\n${parts.join("\n\n") || "(empty)"}`;
}

const isFieldList = (value: unknown): value is [string, string][] =>
  Array.isArray(value) && value.every((field) => Array.isArray(field) && field.length === 2 && field.every((part) => typeof part === "string"));

export function createDocReview(pi: ExtensionAPI, deps: DocReviewDeps = defaultDeps) {
  let viewer: Viewer | undefined;
  let browser: Browser | undefined;
  let ctx: ExtensionContext | undefined;
  const shown = new Map<string, ShownDoc>();
  /** HTML pages on screen, with the content the browser last loaded. */
  const pages = new Map<string, string>();
  /**
   * Pages shown in the current browser: the page server serves files only from their directories,
   * and nothing whose name below them starts with a dot (`.env`, `.git`, `.ssh`).
   */
  const servable = new Set<string>();
  const canServe = (path: string): boolean =>
    [...servable].some((page) => {
      const inside = relative(dirname(page), path);
      return inside !== "" && !isAbsolute(inside) && inside.split(sep).every((part) => !part.startsWith("."));
    });
  /** Every document shown, by real path, oldest first; this is what the `documents` event lists. */
  const docs = new Map<string, DocEntry>();
  const answers = new Map<string, FormResult>();
  let stopPaneCheck: (() => void) | undefined;
  /** Set at shutdown: a show still waiting for its pane then lists nothing, so `[]` stays the last list. */
  let closed = false;

  const alive = (ready: string): boolean => {
    const pid = Number(deps.readFile(ready)?.trim());
    return Number.isInteger(pid) && pid > 0 && deps.pidAlive(pid);
  };
  const viewerAlive = (): boolean => viewer !== undefined && alive(viewer.ready);
  // The default browser runs outside Herdr, so its pages count as open until the session closes them.
  const browserAlive = (): boolean => browser !== undefined && (browser.program === EXTERNAL || alive(browser.ready));
  /** Queues an Ex command for the editor, or a JavaScript line for the browser; it runs on the next poll. */
  const command = (target: { control: string }, line: string): void => deps.appendFile(target.control, `${line}\n`);
  /** Reloads the HTML pages whose content changed since the browser last loaded them. */
  const reloadPages = (paths: Iterable<string>): void => {
    for (const path of paths) {
      const before = pages.get(path);
      const content = deps.readFile(path);
      if (before === undefined || content === undefined || content === before) continue;
      pages.set(path, content);
      if (browser && browserAlive()) browser.reload(path);
    }
  };
  const reload = (): void => {
    if (viewer && viewerAlive()) command(viewer, "call PiDocReviewReload()");
  };

  const chooseEditor = (): string => {
    if (deps.editor) {
      if (!EDITORS.includes(deps.editor)) throw new Error(`${EDITOR_ENV}=${deps.editor} is not supported; use ${EDITORS.join(" or ")}`);
      if (!deps.onPath(deps.editor)) throw new Error(`${EDITOR_ENV}=${deps.editor}, but ${deps.editor} is not on PATH`);
      return deps.editor;
    }
    const found = EDITORS.find((editor) => deps.onPath(editor));
    if (!found) throw new Error(`the review pane needs ${EDITORS.join(" or ")} on PATH`);
    return found;
  };

  const herdr = (...args: string[]): RunResult => {
    const result = deps.run(deps.herdr, args);
    if (result.status !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
    return result;
  };

  // A save waits for the user's next message; a submitted form is an explicit send, so it starts a turn when idle.
  const deliver = (text: string, notice: string, start = false): void => {
    const message = { customType: MESSAGE_TYPE, content: text, display: true };
    if (ctx && !ctx.isIdle()) {
      pi.sendMessage(message, { deliverAs: "steer" });
      return;
    }
    if (start) return void pi.sendMessage(message, { triggerTurn: true });
    pi.sendMessage(message, { deliverAs: "nextTurn" });
    if (ctx?.hasUI) ctx.ui.notify(`${notice} go to the agent with your next message.`, "info");
  };

  const listed = (): PublishedDocument[] => [...docs.values()].map(({ seen: _seen, screen: _screen, ...document }) => document);

  const publish = (): void => {
    const documents = listed();
    pi.events.emit(DOCUMENTS_EVENT, { version: CONTRACT_VERSION, documents });
    const onScreen = documents.some((document) => document.onScreen);
    if (onScreen && !stopPaneCheck) stopPaneCheck = deps.every(PANE_CHECK_MS, checkPanes);
    if (!onScreen && stopPaneCheck) {
      stopPaneCheck();
      stopPaneCheck = undefined;
    }
  };

  /** Marks the documents of the given pane kinds as no longer on screen, announcing it once. */
  const dropScreen = (screens: Screen[]): void => {
    let changed = false;
    for (const entry of docs.values()) {
      if (!entry.onScreen || !screens.includes(entry.screen)) continue;
      entry.onScreen = false;
      changed = true;
    }
    if (changed) publish();
  };

  function checkPanes(): void {
    // A browser the user quit stops listening (terminal-browser's page server with it) now, not at the next show.
    if (browser?.started && !browserAlive()) closeBrowser();
    dropScreen([...(viewerAlive() ? [] : ["editor" as const]), ...(browserAlive() ? [] : ["browser" as const])]);
  }

  /** Lists documents that were just opened: new ones get an id, known ones keep theirs. */
  const register = (group: { absolute: string; content: string; display: string }[], kind: DocKind, screen: Screen, reason: string): void => {
    if (closed) return;
    for (const doc of group) {
      const known = docs.get(doc.absolute);
      docs.delete(doc.absolute);
      docs.set(doc.absolute, {
        id: known?.id ?? deps.newId(),
        path: doc.absolute,
        kind,
        display: doc.display,
        reason,
        revision: known ? known.revision + (known.seen === doc.content ? 0 : 1) : 1,
        onScreen: true,
        seen: doc.content,
        screen,
      });
    }
    for (const oldest of docs.keys()) {
      if (docs.size <= MAX_DOCUMENTS) break;
      docs.delete(oldest);
    }
    publish();
  };

  /** A listed document whose file changed gets the next revision; one event covers all of them. */
  const bump = (paths: Iterable<string>): void => {
    let changed = false;
    for (const path of paths) {
      const entry = docs.get(path);
      const content = entry && deps.readFile(path);
      if (!entry || content === undefined || content === entry.seen) continue;
      entry.revision += 1;
      entry.seen = content;
      changed = true;
    }
    if (changed) publish();
  };

  const onSave = (path: string, dir: string): void => {
    const doc = shown.get(path);
    if (!doc) return;
    const content = deps.readFile(path);
    if (content === undefined || content === doc.snapshot) return;
    const scratch = join(dir, "before");
    deps.writeFile(scratch, doc.snapshot);
    const diff = deps.run("diff", ["-U0", "--label", `a/${doc.display}`, "--label", `b/${doc.display}`, scratch, path]);
    if (diff.status !== 0 && diff.status !== 1) throw new Error(`diff failed: ${diff.stderr.trim()}`);
    doc.snapshot = content;
    deliver(feedbackMessage(doc.display, diff.stdout), `Your edits to ${doc.display}`);
    bump([path]);
  };

  const readSaves = (): void => {
    if (!viewer) return;
    const { dir } = viewer;
    const log = deps.readFile(viewer.log) ?? "";
    const fresh = log.slice(viewer.logOffset);
    viewer.logOffset = log.length;
    for (const path of new Set(fresh.split("\n").filter(Boolean).map(deps.realpath))) {
      try {
        onSave(path, dir);
      } catch (error) {
        if (ctx?.hasUI) ctx.ui.notify(`doc-review: ${(error as Error).message}`, "error");
      }
    }
  };

  const closeViewer = (): void => {
    const current = viewer;
    viewer = undefined;
    shown.clear();
    dropScreen(["editor"]);
    if (!current) return;
    current.stopWatch();
    // The editor quits only without unsaved edits, and removes its scratch directory as it leaves.
    if (alive(current.ready)) command(current, "call PiDocReviewClose()");
    else deps.removeDir(current.dir);
  };

  /** One submitted form as a query string; a form without fields never reaches the agent. */
  const answered = (query: string): void => {
    if (!query) return;
    const fields = new URLSearchParams(query);
    if (fields.get("pi-kind") === "feedback") deliver(pageFeedbackMessage(fields), "Your page feedback", true);
    else deliver(formMessage(fields), "Your form answers", true);
  };

  const closeBrowser = (): void => {
    const current = browser;
    browser = undefined;
    pages.clear();
    servable.clear();
    dropScreen(["browser"]);
    if (!current) return;
    current.stop();
    // The pane's shell removes the scratch directory once the browser exits.
    if (current.program !== EXTERNAL && alive(current.ready)) current.quit();
    else deps.removeDir(current.dir);
  };

  /** A new review pane goes below the other review pane when one is open, else right of the agent's pane. */
  const splitPane = (cwd: string, other: { pane: string } | undefined): string => {
    const [target, direction] = other ? [other.pane, "down"] : [deps.paneId as string, "right"];
    const split = herdr("pane", "split", target, "--direction", direction, "--no-focus", "--cwd", cwd);
    const pane = (JSON.parse(split.stdout) as { result?: { pane?: { pane_id?: string } } }).result?.pane?.pane_id;
    if (!pane) throw new Error(`herdr pane split returned no pane id: ${split.stdout.trim()}`);
    return pane;
  };

  const waitReady = async (ready: string, program: string, pane: string): Promise<void> => {
    for (let waited = 0; !alive(ready); waited += READY_POLL_MS) {
      if (waited >= READY_WAIT_MS) throw new Error(`${program} in pane ${pane} did not start within ${READY_WAIT_MS} ms`);
      await deps.sleep(READY_POLL_MS);
    }
  };

  const chooseBrowser = (): string => {
    if (deps.browser) {
      if (!BROWSERS.includes(deps.browser)) throw new Error(`${BROWSER_ENV}=${deps.browser} is not supported; use ${BROWSERS.join(" or ")}`);
      const needed = browserCommand(deps.browser);
      if (!deps.onPath(needed)) throw new Error(`${BROWSER_ENV}=${deps.browser}, but ${needed} is not on PATH`);
      return deps.browser;
    }
    const found = BROWSERS.find((program) => deps.onPath(browserCommand(program)));
    if (!found) throw new Error(`HTML review needs ${OPENER}, Chawan (${CHAWAN}), or terminal-browser on PATH`);
    return found;
  };

  /** Runs `inner` in the pane's shell after recording that shell's pid; the scratch dir goes once it exits. */
  const runInPane = (pane: string, dir: string, ready: string, inner: string): void => {
    const wrapped = `echo $$ > ${shellQuote(ready)}; ${inner}; rm -rf ${shellQuote(dir)}`;
    // `exit` closes the pane when the user quits the browser; the next HTML show opens a fresh one.
    herdr("pane", "run", pane, `sh -c ${shellQuote(wrapped)}; exit`);
  };

  const startChawan = (pane: string, dir: string, ready: string, paths: string[]): StartedBrowser => {
    const control = join(dir, "commands.js");
    const script = join(dir, "review.js");
    // The script path sits inside a TOML literal string, which cannot hold a single quote.
    if (script.includes("'")) throw new Error(`cannot start ${CHAWAN} from a scratch path containing a quote: ${script}`);
    const answers = join(dir, "answers.log");
    deps.writeFile(control, "");
    deps.writeFile(answers, "");
    deps.writeFile(script, browserScript(control));
    deps.writeFile(join(dir, ANSWER_CGI), answerScript(answers), 0o755);
    // Each submitted form is one query string line in the answers file.
    let offset = 0;
    const stopWatch = deps.watch(answers, () => {
      const log = deps.readFile(answers) ?? "";
      const fresh = log.slice(offset);
      offset = log.length;
      for (const line of fresh.split("\n")) answered(line);
    });
    const startup = `start.startup-script='(0, eval)(readFile(${JSON.stringify(script)}))'`;
    // The scratch dir serves the answer script; Chawan's own directory serves file: and its other schemes.
    const cgiDirs = `external.cgi-dir=['${dir}', '$CHA_LIBEXEC_DIR/cgi-bin']`;
    /** Each image's page in the scratch dir, by the image's path. */
    const imagePages = new Map<string, string>();
    /** What Chawan opens for `path`: the page itself, or an image's page. */
    const target = (path: string): string => {
      if (!IMAGE_FILE.test(path)) return path;
      let page = imagePages.get(path);
      if (!page) {
        page = join(dir, `image-${imagePages.size + 1}.html`);
        deps.writeFile(page, imagePage(path));
        imagePages.set(path, page);
      }
      return page;
    };
    // Chawan loads no images unless buffer.images is on; it then draws them with the terminal's kitty or sixel support.
    const run = `${CHAWAN} -o ${shellQuote(startup)} -o ${shellQuote(cgiDirs)} -o buffer.images=true -- ${paths.map((path) => shellQuote(target(path))).join(" ")}`;
    const url = (path: string) => JSON.stringify(pathToFileURL(target(path)).href);
    const chawan: Browser = {
      program: CHAWAN,
      pane,
      dir,
      ready,
      open: async (more) => {
        for (const path of more) command({ control }, `pager.gotoURL(${url(path)})`);
      },
      reload: (path) => command({ control }, `piDocReviewReload(${url(path)})`),
      quit: () => command({ control }, "quit()"),
      stop: stopWatch,
      started: false,
    };
    return [chawan, run];
  };

  const startTerminalBrowser = (pane: string, dir: string, ready: string, first: string, server: PageServer): StartedBrowser => {
    const url = (path: string) => `${server.base}/files${pathToFileURL(path).pathname}`;
    let key: string | undefined;
    /** The key terminal-browser lists this pane's browser under, once Chromium has started. */
    const findKey = async (): Promise<string> => {
      for (let waited = 0; ; waited += TERMINAL_BROWSER_POLL_MS) {
        const listing = deps.run(TERMINAL_BROWSER, ["ls", "--json", "--all"]);
        if (listing.status === 0) {
          try {
            const { browsers } = JSON.parse(listing.stdout) as { browsers?: { key?: string; pane?: { pane?: string } }[] };
            const found = browsers?.find((candidate) => candidate.pane?.pane === pane)?.key;
            if (found) return found;
          } catch {
            // A listing cut short by a starting browser is read again on the next poll.
          }
        }
        if (waited >= TERMINAL_BROWSER_WAIT_MS) throw new Error(`terminal-browser in pane ${pane} was not listed within ${TERMINAL_BROWSER_WAIT_MS} ms`);
        await deps.sleep(TERMINAL_BROWSER_POLL_MS);
      }
    };
    const terminalBrowser: Browser = {
      program: TERMINAL_BROWSER,
      pane,
      dir,
      ready,
      open: async (more) => {
        key ??= await findKey();
        for (const path of more) {
          const opened = deps.run(TERMINAL_BROWSER, ["new-tab", "--browser", key, url(path)]);
          if (opened.status !== 0) throw new Error(`terminal-browser new-tab failed: ${(opened.stderr || opened.stdout).trim()}`);
        }
      },
      reload: (path) => server.reload(path),
      // ctrl+q quits terminal-browser; a pane already gone has nothing left to quit.
      quit: () => void deps.run(deps.herdr, ["pane", "send-keys", pane, "ctrl+q"]),
      stop: server.close,
      started: false,
    };
    // --no-merge keeps it out of another terminal-browser in the same Herdr tab.
    return [terminalBrowser, `${TERMINAL_BROWSER} open ${shellQuote(url(first))} --no-merge`];
  };

  /** Opens pages from the page server in the user's default browser; no Herdr pane is involved. */
  const startExternal = (server: PageServer): Browser => {
    const url = (path: string) => `${server.base}/files${pathToFileURL(path).pathname}`;
    return {
      program: EXTERNAL,
      pane: "",
      dir: deps.makeDir(),
      ready: "",
      open: async (more) => {
        for (const path of more) {
          const opened = deps.run(OPENER, [url(path)]);
          if (opened.status !== 0) throw new Error(`${OPENER} failed: ${(opened.stderr || opened.stdout).trim()}`);
        }
      },
      reload: (path) => server.reload(path),
      // The user closes the browser tabs; the session only stops serving them.
      quit: () => undefined,
      stop: server.close,
      started: true,
    };
  };

  /** Starts a browser on `paths`; returns the pages it opened, since terminal-browser starts on the first alone. */
  const launchBrowser = async (cwd: string, paths: string[]): Promise<string[]> => {
    closeBrowser();
    const program = chooseBrowser();
    for (const path of paths) servable.add(path);
    if (program === EXTERNAL) {
      browser = startExternal(await deps.servePages(answered, canServe));
      // showHtml opens every page as a tab of its own.
      return [];
    }
    // The server starts before the pane opens, so a server that cannot start leaves no empty pane.
    const server = program === TERMINAL_BROWSER ? await deps.servePages(answered, canServe) : undefined;
    let dir: string | undefined;
    let started: StartedBrowser;
    try {
      const pane = splitPane(cwd, viewer && viewerAlive() ? viewer : undefined);
      dir = deps.makeDir();
      const ready = join(dir, "ready");
      started = server ? startTerminalBrowser(pane, dir, ready, paths[0], server) : startChawan(pane, dir, ready, paths);
    } catch (error) {
      server?.close();
      if (dir) deps.removeDir(dir);
      throw error;
    }
    const [current, run] = started;
    // Held before the pane runs anything, so a pane that fails to start is still closed and cleaned up later.
    browser = current;
    runInPane(current.pane, current.dir, current.ready, run);
    herdr("pane", "rename", current.pane, "html review");
    await waitReady(current.ready, program, current.pane);
    current.started = true;
    return server ? paths.slice(0, 1) : paths;
  };

  const launch = async (cwd: string, paths: string[]): Promise<void> => {
    closeViewer();
    const editor = chooseEditor();
    const pane = splitPane(cwd, browser && browserAlive() ? browser : undefined);
    const dir = deps.makeDir();
    const control = join(dir, "commands.vim");
    const ready = join(dir, "ready");
    const log = join(dir, "saves.log");
    const script = join(dir, "review.vim");
    deps.writeFile(control, "");
    deps.writeFile(log, "");
    deps.writeFile(script, reviewScript(dir, control, ready, log));
    viewer = { pane, editor, dir, control, ready, log, logOffset: 0, stopWatch: deps.watch(log, readSaves) };
    // `exit` closes the pane when the user quits the editor; the next show opens a fresh one.
    herdr("pane", "run", pane, `${editor} -S ${shellQuote(script)} -o -- ${paths.map(shellQuote).join(" ")}; exit`);
    herdr("pane", "rename", pane, "doc review");
    await waitReady(ready, editor, pane);
  };

  /** Opens text documents in the editor; returns the ones not already on screen. */
  const showText = async (cwd: string, docs: { absolute: string; content: string; display: string }[]) => {
    const running = viewer !== undefined && viewerAlive();
    const fresh = running ? docs.filter((doc) => !shown.has(doc.absolute)) : docs;
    if (viewer && running) {
      for (const doc of docs) command(viewer, `call PiDocReviewAdd(${vimLiteral(doc.absolute)})`);
      reload();
    } else {
      await launch(cwd, docs.map((doc) => doc.absolute));
    }
    for (const doc of docs) shown.set(doc.absolute, shown.get(doc.absolute) ?? { display: doc.display, snapshot: doc.content });
    return fresh;
  };

  /** Opens HTML pages in the browser; returns the ones not already on screen. */
  const showHtml = async (cwd: string, docs: { absolute: string; content: string }[]) => {
    const running = browser !== undefined && browserAlive();
    const fresh = running ? docs.filter((doc) => !pages.has(doc.absolute)) : docs;
    if (running) {
      for (const doc of docs) servable.add(doc.absolute);
      reloadPages(docs.map((doc) => doc.absolute));
    } else {
      const opened = await launchBrowser(cwd, docs.map((doc) => doc.absolute));
      for (const doc of docs) if (opened.includes(doc.absolute)) pages.set(doc.absolute, doc.content);
    }
    // Each page counts as open once it is, so a failure part way leaves no page to open twice.
    for (const doc of fresh) {
      if (pages.has(doc.absolute) || !browser) continue;
      await browser.open([doc.absolute]);
      pages.set(doc.absolute, doc.content);
    }
    return fresh;
  };

  const show = async (cwd: string, paths: string[], reason: string, view: View = "edit"): Promise<ShowResult> => {
    const docs = paths.map((path) => {
      if (/[\n\r]/.test(path)) throw new Error(`cannot open a path containing a line break: ${JSON.stringify(path)}`);
      const absolute = deps.realpath(isAbsolute(path) ? path : resolve(cwd, path));
      const content = deps.readFile(absolute);
      if (content === undefined) throw new Error(`cannot read ${path}`);
      const rel = relative(deps.realpath(cwd), absolute);
      return { absolute, content, display: rel.startsWith("..") ? absolute : rel };
    });
    // Markdown and React files are text the server renders into a page when asked for view "page".
    const isMarkdownPage = (doc: { absolute: string }) => view === "page" && (MARKDOWN_FILE.test(doc.absolute) || REACT_FILE.test(doc.absolute));
    const inBrowser = (doc: { absolute: string }) => HTML_FILE.test(doc.absolute) || IMAGE_FILE.test(doc.absolute) || isMarkdownPage(doc);
    const texts = docs.filter((doc) => !inBrowser(doc));
    const htmls = docs.filter(inBrowser);
    if (view === "page" && texts.length > 0) {
      throw new Error(`view "page" renders Markdown, React (.tsx, .jsx), HTML, and images; open ${texts.map((doc) => doc.display).join(", ")} with view "edit"`);
    }
    // A NUL byte marks a binary file, which the editor would show as bytes; nothing opens when one is asked for.
    const binary = texts.filter((doc) => doc.content.includes("\0"));
    if (binary.length > 0) {
      throw new Error(`cannot show binary files: ${binary.map((doc) => doc.display).join(", ")}; show_doc opens text, HTML, and images (png, jpg, gif, webp, bmp, svg)`);
    }
    const names = docs.map((doc) => doc.display).join(", ");
    if (!deps.paneId) return { opened: [], text: `Not running inside Herdr, so no review pane opened. Tell the user to read: ${names}` };
    const markdownPages = htmls.filter(isMarkdownPage);
    // Chawan reads pages from disk, so nothing renders Markdown for it.
    const program = browser && browserAlive() ? browser.program : markdownPages.length > 0 ? chooseBrowser() : undefined;
    if (program === CHAWAN && markdownPages.length > 0) {
      throw new Error(`Chawan cannot render Markdown or React pages; set ${BROWSER_ENV}=${EXTERNAL} or ${TERMINAL_BROWSER}, or open ${markdownPages.map((doc) => doc.display).join(", ")} with view "edit"`);
    }
    const fresh: unknown[] = [];
    if (texts.length > 0) {
      fresh.push(...(await showText(cwd, texts)));
      register(texts, "text", "editor", reason);
    }
    if (htmls.length > 0) {
      fresh.push(...(await showHtml(cwd, htmls)));
      // Images stay off the event bus: its contract lists HTML and text documents only, so a Markdown page is text there.
      const pages = htmls.filter((doc) => HTML_FILE.test(doc.absolute));
      if (pages.length > 0) register(pages, "html", "browser", reason);
      if (markdownPages.length > 0) register(markdownPages, "text", "browser", reason);
    }
    if (fresh.length > 0) herdr("notification", "show", "Document ready for review", "--body", `${reason}: ${names}`, "--sound", "request");
    const list = (group: typeof docs) => group.map((doc) => doc.display).join(", ");
    const opened = [
      ...(texts.length > 0 ? [`${list(texts)} in Herdr pane ${viewer?.pane} (editable ${viewer?.editor}, one row per document)`] : []),
      ...(htmls.length > 0 && browser
        ? browser.program === EXTERNAL
          ? [`${list(htmls)} in the default browser (view-only, one tab per page)`]
          : [`${list(htmls)} in Herdr pane ${browser.pane} (rendered by ${BROWSER_NAMES[browser.program]}, view-only, one ${browser.program === CHAWAN ? "buffer" : "tab"} per page)`]
        : []),
    ];
    const feedback = texts.length > 0 ? " Their saved edits will reach you as review feedback." : "";
    return {
      opened: docs.map((doc) => doc.display),
      text: `Opened ${opened.join(" and ")} and returned without waiting for the user.${feedback}`,
    };
  };

  /** The Mini SDD files to open after the agent wrote `path`, or none. */
  const miniSddFollowUp = (path: string): string[] => {
    if (shown.has(path) || !MINI_SDD_FILE.test(path)) return [];
    const folder = dirname(path);
    const folderOnScreen = [...shown.keys()].some((open) => dirname(open) === folder);
    if (folderOnScreen) return [path];
    if (basename(path) !== "spec.md" || !PROPOSED_STATUS.test(deps.readFile(path) ?? "")) return [];
    return MINI_SDD_PHASES.map((phase) => join(folder, phase)).filter((phasePath) => deps.readFile(phasePath) !== undefined);
  };

  /** After the agent changes a shown document, the version it saw is the new one, and the pane reloads it. */
  const agentWrote = (path: string): void => {
    reloadPages([path]);
    bump([path]);
    const doc = shown.get(path);
    if (!doc) return;
    doc.snapshot = deps.readFile(path) ?? doc.snapshot;
    reload();
  };

  const refreshAfterShell = (): void => {
    reloadPages([...pages.keys()]);
    bump(docs.keys());
    if (shown.size === 0) return;
    for (const [path, doc] of shown) doc.snapshot = deps.readFile(path) ?? doc.snapshot;
    reload();
  };

  /** Delivers a form answered in another viewer exactly as a Chawan submission is delivered; replies on the result event. */
  const onForm = (data: unknown): void => {
    if (typeof data !== "object" || data === null) return;
    const { version, id, answerId, fields } = data as Record<string, unknown>;
    if (typeof id !== "string" || typeof answerId !== "string") return;
    const result = (accepted: boolean, reason?: string): FormResult => ({
      version: CONTRACT_VERSION,
      id,
      answerId,
      accepted,
      ...(reason === undefined ? {} : { reason }),
    });
    const remembered = answers.get(answerId);
    if (remembered) {
      // A repeated answerId never delivers again; it gets the first result back.
      pi.events.emit(FORM_RESULT_EVENT, remembered.id === id ? { ...remembered } : result(false, "invalid"));
      return;
    }
    const decide = (): FormResult => {
      const entry = [...docs.values()].find((doc) => doc.id === id);
      if (version !== CONTRACT_VERSION || !isFieldList(fields)) return result(false, "invalid");
      if (!entry) return result(false, "closed");
      if (entry.kind !== "html") return result(false, "invalid");
      // A Chawan submission without fields never reaches the agent, so this one does not either.
      if (fields.length === 0) return result(false, "empty");
      try {
        deliver(formMessage(fields), "Your form answers", true);
      } catch (error) {
        return result(false, `delivery failed: ${(error as Error).message}`);
      }
      return result(true);
    };
    const decided = decide();
    answers.set(answerId, decided);
    for (const oldest of answers.keys()) {
      if (answers.size <= MAX_REMEMBERED_ANSWERS) break;
      answers.delete(oldest);
    }
    pi.events.emit(FORM_RESULT_EVENT, decided);
  };

  /** A viewer that started late asks for the list: it is sent again as it stands, changing nothing else. */
  const onRequest = (data: unknown): void => {
    if (closed || typeof data !== "object" || data === null) return;
    if ((data as Record<string, unknown>).version !== CONTRACT_VERSION) return;
    pi.events.emit(DOCUMENTS_EVENT, { version: CONTRACT_VERSION, documents: listed() });
  };

  /** Session end: the list empties for every viewer and the panes close as they do today. */
  const shutdown = (): void => {
    closed = true;
    docs.clear();
    answers.clear();
    closeViewer();
    closeBrowser();
    publish();
  };

  return {
    show,
    docs,
    onForm,
    onRequest,
    shutdown,
    get viewer() {
      return viewer;
    },
    get browser() {
      return browser;
    },
    shown,
    pages,
    setContext: (next: ExtensionContext) => {
      ctx = next;
    },
    readSaves,
    miniSddFollowUp,
    agentWrote,
    refreshAfterShell,
    closeViewer,
    closeBrowser,
  };
}

export default function docReview(pi: ExtensionAPI, deps: DocReviewDeps = defaultDeps): void {
  const review = createDocReview(pi, deps);

  pi.registerTool(
    defineTool({
      name: "show_doc",
      label: "Show document",
      description:
        "Open documents the user should review beside this session (Herdr only; elsewhere it returns the paths to name to the user). " +
        "Text documents open in one editable nvim or vim pane, and the user's saved edits come back to you as a diff: use it for specs and drafts the user should edit. " +
        "For material the user should read or decide on (a report, plan, design, or comparison), write Markdown and open it with view \"page\": it renders in the user's default browser, one tab per page. HTML files and images (png, jpg, gif, webp, bmp, svg) always open there. " +
        "Pages get a built-in style, so write no CSS or scripts. In a Markdown page: GitHub alerts (> [!NOTE], [!TIP], [!IMPORTANT], [!WARNING], [!CAUTION], with an optional title after the marker) become callouts; " +
        "a ```mermaid block becomes a diagram (flowchart, state, sequence, class, ER, xychart bar or line); a ```diff block is coloured; " +
        "a ```cards block holds a YAML list of {title, tone: note|ok|warn|risk, body}; ```options holds a YAML list of {title, recommended: true or a label, body, pros: [..], cons: [..]} shown side by side; " +
        "```form holds {title, submit, questions: [{name, label, hint, required, type: single|multi|text, other: label, choices: [label or {value, label, note, recommended}]}]}, and the user's answers reach you as a message when they send it. body fields are Markdown. " +
        "Images and links resolve against the page's directory; nothing loads from above it or from another site. " +
        "Every page has a feedback panel: the user comments on selected passages and sends them to you as a message. " +
        "Put decisions that belong to the page (several questions, or a choice after a comparison) in a ```form at its end; ask a single short question with your question tool. " +
        "When a page needs interaction (inputs that recompute, tabs, filters), write a .tsx or .jsx file whose default export is a React component and open it with view \"page\": React is built in, and the \"pi-kit\" module exports Callout, Grid, Card, Badge, Options, Option, Form, Question, Choice (same props as the YAML fields), Markdown and Mermaid (children are their source), and send(fields) to hand the agent any values as a message. Import sibling modules freely; import no CSS. " +
        "In HTML pages the same elements are tags: <pi-callout tone title>, <pi-grid> of <pi-card title tone>, <pi-badge tone>, <pi-options> of <pi-option title recommended pros=\"a; b\" cons=\"c; d\">, <pi-form title submit> of <pi-question name label hint required type other> with <pi-choice value note recommended>. " +
        "It returns at once without waiting for the user. Documents stay open and reload when you edit them.",
      parameters: Type.Object({
        paths: Type.Array(Type.String({ description: "File path, absolute or relative to the working directory" }), { minItems: 1 }),
        reason: Type.String({ description: "One short line telling the user what to review, e.g. 'Spec ready for approval'" }),
        view: Type.Optional(
          Type.Union([Type.Literal("page"), Type.Literal("edit")], {
            description: "How Markdown opens: \"page\" renders it in the browser for reading, \"edit\" (default) opens it in the editor for review edits",
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        review.setContext(ctx);
        const result = await review.show(ctx.cwd, params.paths, params.reason, params.view);
        return { content: [{ type: "text", text: result.text }], details: { opened: result.opened } };
      },
    }),
  );

  pi.on("session_start", (_event, ctx) => review.setContext(ctx));

  pi.on("tool_result", async (event, ctx) => {
    review.setContext(ctx);
    if (event.isError) return;
    if (event.toolName === "bash") {
      review.refreshAfterShell();
      return;
    }
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    const path = deps.realpath(isAbsolute(input.path) ? input.path : resolve(ctx.cwd, input.path));
    review.agentWrote(path);
    if (!deps.paneId) return;
    const followUp = review.miniSddFollowUp(path);
    if (followUp.length === 0) return;
    try {
      await review.show(ctx.cwd, followUp, basename(path) === "spec.md" ? "Spec proposed for approval" : `${basename(path)} written`);
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`doc-review could not open ${input.path}: ${(error as Error).message}`, "warning");
    }
  });

  const stopForms = pi.events.on(FORM_EVENT, review.onForm);
  const stopRequests = pi.events.on(DOCUMENTS_REQUEST_EVENT, review.onRequest);

  pi.on("session_shutdown", () => {
    stopForms();
    stopRequests();
    review.shutdown();
  });
}
