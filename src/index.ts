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
 * HTML files open rendered and view-only in one Chawan (`cha`) pane per session instead, one buffer
 * per page. Chawan runs a start-up script that polls its own command file the same way, so new
 * pages and reloads after the agent changes a page arrive without restarting it. A form whose action
 * is `cgi-bin:pi-answer` sends its fields to the agent the same way a save does: Chawan runs that
 * local CGI script from the scratch directory, which appends the query string to an answers file.
 * Chawan blocks a POST from a `file:` page to `cgi-bin:`, so the form submits with GET.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MINI_SDD_FILE = /(^|\/)docs\/specs\/[^/]+\/(decision|spec|design|verification)\.md$/;
export const MINI_SDD_PHASES = ["decision.md", "spec.md", "design.md", "verification.md"];
export const PROPOSED_STATUS = /^Status:\s*proposed\b/m;
export const MAX_DIFF_CHARS = 20_000;
const MESSAGE_TYPE = "doc-review";
export const EDITOR_ENV = "PI_HERDR_DOC_REVIEW_EDITOR";
export const EDITORS = ["nvim", "vim"];
export const POLL_MS = 250;
export const HTML_FILE = /\.html?$/i;
export const BROWSER = "cha";
/** The local CGI script an HTML form names as `action="cgi-bin:pi-answer"` to send its fields to the agent. */
export const ANSWER_CGI = "pi-answer";
const READY_WAIT_MS = 5000;
const READY_POLL_MS = 100;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface DocReviewDeps {
  paneId: string | undefined;
  herdr: string;
  /** The editor the user chose through PI_HERDR_DOC_REVIEW_EDITOR, if any. */
  editor: string | undefined;
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
}

const defaultDeps: DocReviewDeps = {
  paneId: process.env.HERDR_PANE_ID,
  herdr: process.env.HERDR_BIN_PATH ?? "herdr",
  editor: process.env[EDITOR_ENV],
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

interface Browser {
  pane: string;
  dir: string;
  control: string;
  ready: string;
  answers: string;
  answersOffset: number;
  stopWatch: () => void;
}

interface ShownDoc {
  display: string;
  snapshot: string;
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

/** The local CGI script behind `cgi-bin:pi-answer`: it records one submitted form and confirms it. */
export function answerScript(answers: string): string {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$QUERY_STRING" >> ${shellQuote(answers)}`,
    "printf 'Content-Type: text/html; charset=utf-8\\n\\n<p>Sent to the agent. Press , to return to the page.</p>\\n'",
    "",
  ].join("\n");
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

export function createDocReview(pi: ExtensionAPI, deps: DocReviewDeps = defaultDeps) {
  let viewer: Viewer | undefined;
  let browser: Browser | undefined;
  let ctx: ExtensionContext | undefined;
  const shown = new Map<string, ShownDoc>();
  /** HTML pages on screen, with the content the browser last loaded. */
  const pages = new Map<string, string>();

  const alive = (ready: string): boolean => {
    const pid = Number(deps.readFile(ready)?.trim());
    return Number.isInteger(pid) && pid > 0 && deps.pidAlive(pid);
  };
  const viewerAlive = (): boolean => viewer !== undefined && alive(viewer.ready);
  const browserAlive = (): boolean => browser !== undefined && alive(browser.ready);
  /** Queues an Ex command for the editor, or a JavaScript line for the browser; it runs on the next poll. */
  const command = (target: { control: string }, line: string): void => deps.appendFile(target.control, `${line}\n`);
  /** Reloads the HTML pages whose content changed since the browser last loaded them. */
  const reloadPages = (paths: Iterable<string>): void => {
    for (const path of paths) {
      const before = pages.get(path);
      const content = deps.readFile(path);
      if (before === undefined || content === undefined || content === before) continue;
      pages.set(path, content);
      if (browser && browserAlive()) command(browser, `piDocReviewReload(${JSON.stringify(pathToFileURL(path).href)})`);
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
    if (!current) return;
    current.stopWatch();
    // The editor quits only without unsaved edits, and removes its scratch directory as it leaves.
    if (alive(current.ready)) command(current, "call PiDocReviewClose()");
    else deps.removeDir(current.dir);
  };

  /** Each submitted form is one query string line in the answers file. */
  const readAnswers = (): void => {
    if (!browser) return;
    const log = deps.readFile(browser.answers) ?? "";
    const fresh = log.slice(browser.answersOffset);
    browser.answersOffset = log.length;
    for (const line of fresh.split("\n").filter(Boolean)) {
      const fields = [...new URLSearchParams(line)].map(([name, value]) => `- ${name}: ${value}`);
      deliver(`User submitted a form in the HTML review pane:\n${fields.join("\n") || "(no fields)"}`, "Your form answers", true);
    }
  };

  const closeBrowser = (): void => {
    const current = browser;
    browser = undefined;
    pages.clear();
    if (!current) return;
    current.stopWatch();
    // The pane's shell removes the scratch directory once Chawan exits.
    if (alive(current.ready)) command(current, "quit()");
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

  const launchBrowser = async (cwd: string, paths: string[]): Promise<void> => {
    closeBrowser();
    if (!deps.onPath(BROWSER)) throw new Error(`HTML review needs Chawan (${BROWSER}) on PATH`);
    const pane = splitPane(cwd, viewer && viewerAlive() ? viewer : undefined);
    const dir = deps.makeDir();
    const control = join(dir, "commands.js");
    const ready = join(dir, "ready");
    const script = join(dir, "review.js");
    // The script path sits inside a TOML literal string, which cannot hold a single quote.
    if (script.includes("'")) throw new Error(`cannot start ${BROWSER} from a scratch path containing a quote: ${script}`);
    const answers = join(dir, "answers.log");
    deps.writeFile(control, "");
    deps.writeFile(answers, "");
    deps.writeFile(script, browserScript(control));
    deps.writeFile(join(dir, ANSWER_CGI), answerScript(answers), 0o755);
    browser = { pane, dir, control, ready, answers, answersOffset: 0, stopWatch: deps.watch(answers, readAnswers) };
    const startup = `start.startup-script='(0, eval)(readFile(${JSON.stringify(script)}))'`;
    // The scratch dir serves the answer script; Chawan's own directory serves file: and its other schemes.
    const cgiDirs = `external.cgi-dir=['${dir}', '$CHA_LIBEXEC_DIR/cgi-bin']`;
    const inner = `echo $$ > ${shellQuote(ready)}; ${BROWSER} -o ${shellQuote(startup)} -o ${shellQuote(cgiDirs)} -- ${paths.map(shellQuote).join(" ")}; rm -rf ${shellQuote(dir)}`;
    // `exit` closes the pane when the user quits Chawan; the next HTML show opens a fresh one.
    herdr("pane", "run", pane, `sh -c ${shellQuote(inner)}; exit`);
    herdr("pane", "rename", pane, "html review");
    await waitReady(ready, BROWSER, pane);
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
    if (browser && running) {
      for (const doc of fresh) command(browser, `pager.gotoURL(${JSON.stringify(pathToFileURL(doc.absolute).href)})`);
      reloadPages(docs.map((doc) => doc.absolute));
    } else {
      await launchBrowser(cwd, docs.map((doc) => doc.absolute));
    }
    for (const doc of fresh) pages.set(doc.absolute, doc.content);
    return fresh;
  };

  const show = async (cwd: string, paths: string[], reason: string): Promise<ShowResult> => {
    const docs = paths.map((path) => {
      if (/[\n\r]/.test(path)) throw new Error(`cannot open a path containing a line break: ${JSON.stringify(path)}`);
      const absolute = deps.realpath(isAbsolute(path) ? path : resolve(cwd, path));
      const content = deps.readFile(absolute);
      if (content === undefined) throw new Error(`cannot read ${path}`);
      const rel = relative(deps.realpath(cwd), absolute);
      return { absolute, content, display: rel.startsWith("..") ? absolute : rel };
    });
    const names = docs.map((doc) => doc.display).join(", ");
    if (!deps.paneId) return { opened: [], text: `Not running inside Herdr, so no review pane opened. Tell the user to read: ${names}` };
    const texts = docs.filter((doc) => !HTML_FILE.test(doc.absolute));
    const htmls = docs.filter((doc) => HTML_FILE.test(doc.absolute));
    const fresh = [...(texts.length > 0 ? await showText(cwd, texts) : []), ...(htmls.length > 0 ? await showHtml(cwd, htmls) : [])];
    if (fresh.length > 0) herdr("notification", "show", "Document ready for review", "--body", `${reason}: ${names}`, "--sound", "request");
    const list = (group: typeof docs) => group.map((doc) => doc.display).join(", ");
    const opened = [
      ...(texts.length > 0 ? [`${list(texts)} in Herdr pane ${viewer?.pane} (editable ${viewer?.editor}, one row per document)`] : []),
      ...(htmls.length > 0 ? [`${list(htmls)} in Herdr pane ${browser?.pane} (rendered by Chawan, view-only, one buffer per page)`] : []),
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
    const doc = shown.get(path);
    if (!doc) return;
    doc.snapshot = deps.readFile(path) ?? doc.snapshot;
    reload();
  };

  const refreshAfterShell = (): void => {
    reloadPages([...pages.keys()]);
    if (shown.size === 0) return;
    for (const [path, doc] of shown) doc.snapshot = deps.readFile(path) ?? doc.snapshot;
    reload();
  };

  return {
    show,
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
        "Open documents the user should review in a pane beside this session (Herdr only; elsewhere it returns the paths to name to the user). " +
        "Text documents open in one editable nvim or vim pane, one row per document, and the user's saved edits come back to you as a diff. " +
        "HTML files (.html, .htm) open rendered in one Chawan pane, one buffer per page; Chawan runs no JavaScript. " +
        "Pages are for reading: ask the user's questions with your question tool, not in a form on the page. " +
        "Use it whenever the user must understand or confirm written material: a spec, design, plan, report, or comparison; write material meant for understanding as HTML. " +
        "It returns at once without waiting for the user. Documents stay open and reload when you edit them.",
      parameters: Type.Object({
        paths: Type.Array(Type.String({ description: "File path, absolute or relative to the working directory" }), { minItems: 1 }),
        reason: Type.String({ description: "One short line telling the user what to review, e.g. 'Spec ready for approval'" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        review.setContext(ctx);
        const result = await review.show(ctx.cwd, params.paths, params.reason);
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

  pi.on("session_shutdown", () => {
    review.closeViewer();
    review.closeBrowser();
  });
}
