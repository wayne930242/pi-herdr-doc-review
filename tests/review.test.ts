import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import docReview, { createDocReview, createPageServer, MAX_DIFF_CHARS } from "../src/index.ts";

const SCRATCH = "/tmp/review-1";
const CONTROL = `${SCRATCH}/commands.vim`;
const READY = `${SCRATCH}/ready`;

const CWD = "/repo";
const SPEC_DIR = "/repo/docs/specs/2026-10-16-review";

function fake(options = {}) {
  const paneId = "paneId" in options ? options.paneId : "w:p1";
  const files = options.files ?? {};
  const fs = new Map(Object.entries(files));
  const calls = [];
  const sent = [];
  const notices = [];
  const watchers = new Map();
  const state = { editorUp: false, browserUp: false, unsaved: 0, splits: 0, removed: [], idle: true, listed: true, servers: [] };
  const installed = options.installed ?? ["nvim", "vim", "cha"];
  const dirs = options.dirs ?? [SCRATCH];
  let made = 0;
  let ids = 0;
  const timers = [];
  let lastDir = SCRATCH;
  const quitEditor = () => {
    state.editorUp = false;
    fs.delete(READY);
  };
  const deps = {
    paneId,
    herdr: "herdr",
    editor: options.editor,
    browser: options.browser,
    servePages: async (onAnswer, allowed) => {
      const server = { base: `http://127.0.0.1:4000/tok${state.servers.length + 1}`, reloads: [], closed: false, onAnswer, allowed };
      state.servers.push(server);
      return { base: server.base, reload: (path) => server.reloads.push(path), close: () => (server.closed = true) };
    },
    onPath: (command) => installed.includes(command),
    pidAlive: (pid) => (state.editorUp && pid === 4242) || (state.browserUp && pid === 5151),
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "herdr" && args[0] === "pane" && args[1] === "split") {
        state.splits++;
        if (state.failSplit) return { status: 1, stdout: "", stderr: "no room" };
        return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `w:p${state.splits + 1}` } } }), stderr: "" };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "run") {
        const isBrowser = args[3].includes(" cha -o ") || args[3].includes(" terminal-browser open ");
        if (isBrowser) state.browserUp = true;
        else state.editorUp = true;
        fs.set(`${lastDir}/ready`, isBrowser ? "5151\n" : "4242\n");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "herdr" && args[1] === "send-keys" && args[3] === "ctrl+q") state.browserUp = false;
      if (command === "herdr") return { status: 0, stdout: "{}", stderr: "" };
      if (command === "terminal-browser" && args[0] === "ls") {
        const browsers = state.listed ? [{ key: "777-1", pane: { tab: "w:t1", pane: `w:p${state.splits + 1}` } }, { key: "888-1", pane: { tab: "w:t1", pane: "w:p99" } }] : [];
        return { status: 0, stdout: JSON.stringify({ browsers }), stderr: "" };
      }
      if (command === "terminal-browser" && args[0] === "new-tab") return { status: 0, stdout: "{}", stderr: "" };
      if (command === "diff") {
        const before = fs.get(args[5]);
        const after = fs.get(args[6]);
        return before === after ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: `-${before}+${after}`, stderr: "" };
      }
      throw new Error(`unexpected ${command}`);
    },
    makeDir: () => {
      lastDir = dirs[Math.min(made++, dirs.length - 1)];
      return lastDir;
    },
    removeDir: (dir) => state.removed.push(dir),
    readFile: (path) => fs.get(path),
    writeFile: (path, content) => fs.set(path, content),
    appendFile: (path, content) => {
      fs.set(path, `${fs.get(path) ?? ""}${content}`);
      if (path === CONTROL && content === "call PiDocReviewClose()\n" && state.unsaved === 0) quitEditor();
      if (path.endsWith("/commands.js") && content === "quit()\n") state.browserUp = false;
    },
    realpath: (path) => path,
    watch: (path, onChange) => {
      watchers.set(path, onChange);
      return () => watchers.delete(path);
    },
    sleep: async () => {},
    every: (ms, tick) => {
      const timer = { ms, tick, running: true };
      timers.push(timer);
      return () => {
        timer.running = false;
      };
    },
    newId: () => `doc-${++ids}`,
  };
  const emitted = [];
  const listeners = new Map();
  const pi = {
    sendMessage: (message, options) => sent.push({ message, options }),
    events: {
      emit: (channel, data) => {
        emitted.push({ channel, data: structuredClone(data) });
        for (const handler of listeners.get(channel) ?? []) handler(data);
      },
      on: (channel, handler) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
        return () => listeners.set(channel, listeners.get(channel).filter((other) => other !== handler));
      },
    },
  };
  const ctx = { cwd: CWD, hasUI: true, isIdle: () => state.idle, ui: { notify: (text, level) => notices.push([text, level]) } };
  const userSaves = (path, content) => {
    fs.set(path, content);
    fs.set(`${SCRATCH}/saves.log`, `${fs.get(`${SCRATCH}/saves.log`)}${path}\n`);
    watchers.get(`${SCRATCH}/saves.log`)();
  };
  const commands = () => (fs.get(CONTROL) ?? "").split("\n").filter(Boolean);
  const userSubmits = (dir, query) => {
    fs.set(`${dir}/answers.log`, `${fs.get(`${dir}/answers.log`) ?? ""}${query}\n`);
    watchers.get(`${dir}/answers.log`)();
  };
  /** The `documents` events so far, and the latest list. */
  const lists = () => emitted.filter((event) => event.channel === "doc-review:documents").map((event) => event.data.documents);
  const results = () => emitted.filter((event) => event.channel === "doc-review:form-result").map((event) => event.data);
  const form = (data) => pi.events.emit("doc-review:form", data);
  return { deps, fs, calls, sent, notices, state, pi, ctx, userSaves, userSubmits, quitEditor, commands, watchers, emitted, listeners, timers, lists, results, form };
}

/** The words a POSIX shell splits `line` into, without running it. */
const shellWords = (line) =>
  spawnSync("sh", ["-c", 'eval "set -- $1"; printf "%s\\0" "$@"', "sh", line], { encoding: "utf8" }).stdout.split("\0").slice(0, -1);

const editorLaunch = (calls) => calls.find((call) => call[0] === "herdr" && call[2] === "run");

// show_doc opens a right split running the editor with every document as a row, and returns at once.
{
  const t = fake({ files: { "/repo/a.md": "A", "/repo/b.md": "B" } });
  const review = createDocReview(t.pi, t.deps);
  review.setContext(t.ctx);
  const result = await review.show(CWD, ["a.md", "/repo/b.md"], "Please read");
  assert.deepEqual(result.opened, ["a.md", "b.md"]);
  assert.deepEqual(t.calls[0], ["herdr", "pane", "split", "w:p1", "--direction", "right", "--no-focus", "--cwd", CWD]);
  const launch = editorLaunch(t.calls).at(-1);
  assert.match(launch, /^nvim -S '\/tmp\/review-1\/review\.vim' -o -- '\/repo\/a\.md' '\/repo\/b\.md'; exit$/, "documents open as stacked rows");
  assert.match(t.fs.get("/tmp/review-1/review.vim"), /BufWritePost \* call writefile\(\[expand\('<afile>:p'\)\], '\/tmp\/review-1\/saves\.log', 'a'\)/);
  const script = t.fs.get(`${SCRATCH}/review.vim`);
  assert.match(script, /call timer_start\(250, function\('s:Poll'\), \{'repeat': -1\}\)/, "the editor polls its command file");
  assert.match(script, /let s:control = '\/tmp\/review-1\/commands\.vim'/);
  assert.match(script, /call writefile\(\[string\(getpid\(\)\)\], '\/tmp\/review-1\/ready'\)/);
  assert.match(script, /autocmd VimLeave \* call delete\('\/tmp\/review-1', 'rf'\)/, "the editor removes its scratch dir when it quits");
  assert.ok(t.calls.some((call) => call[1] === "notification"), "a new document notifies the user");
  assert.equal(t.sent.length, 0, "showing a document sends the agent nothing and waits for nothing");

  // A second show reuses the running editor and adds only a row.
  t.fs.set("/repo/c.md", "C");
  const before = t.state.splits;
  await review.show(CWD, ["c.md"], "One more");
  assert.equal(t.state.splits, before, "the pane is reused");
  assert.ok(t.commands().includes("call PiDocReviewAdd('/repo/c.md')"), "the new document becomes a bottom row");

  // The agent's edit to a shown document queues a reload.
  review.agentWrote("/repo/a.md");
  assert.equal(t.commands().at(-1), "call PiDocReviewReload()");
}

// The user's save reaches the agent as a diff: steered while busy, attached to the next message while idle.
{
  const t = fake({ files: { "/repo/a.md": "old" } });
  const review = createDocReview(t.pi, t.deps);
  review.setContext(t.ctx);
  await review.show(CWD, ["a.md"], "Read");
  t.userSaves("/repo/a.md", "new");
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].options.deliverAs, "nextTurn", "an idle session is not woken by a save");
  assert.ok(!t.sent[0].options.triggerTurn, "a save never starts a turn");
  assert.match(t.sent[0].message.content, /User edited a\.md/);
  assert.match(t.sent[0].message.content, /-old\+new/);
  assert.equal(t.notices.at(-1)[1], "info");

  t.state.idle = false;
  t.userSaves("/repo/a.md", "newer");
  assert.equal(t.sent[1].options.deliverAs, "steer", "a running turn receives the edit at once");
  assert.match(t.sent[1].message.content, /-new\+newer/, "the diff starts from the version last reported");

  t.userSaves("/repo/a.md", "newer");
  assert.equal(t.sent.length, 2, "a save without changes sends nothing");

  // The agent's own write moves the baseline, so the next user diff excludes it.
  t.fs.set("/repo/a.md", "agent");
  review.agentWrote("/repo/a.md");
  t.userSaves("/repo/a.md", "user");
  assert.match(t.sent[2].message.content, /-agent\+user/);

  // A save of a file that was never shown is ignored.
  t.userSaves("/repo/other.md", "x");
  assert.equal(t.sent.length, 3);
}

// Long diffs are truncated with a pointer to the file.
{
  const t = fake({ files: { "/repo/a.md": "x" } });
  const review = createDocReview(t.pi, t.deps);
  review.setContext(t.ctx);
  await review.show(CWD, ["a.md"], "Read");
  t.userSaves("/repo/a.md", "y".repeat(MAX_DIFF_CHARS * 2));
  assert.match(t.sent[0].message.content, /truncated; read a\.md/);
}

// Outside Herdr nothing opens; the tool names the files instead.
{
  const t = fake({ paneId: undefined, files: { "/repo/a.md": "A" } });
  const review = createDocReview(t.pi, t.deps);
  const result = await review.show(CWD, ["a.md"], "Read");
  assert.deepEqual(result.opened, []);
  assert.match(result.text, /Not running inside Herdr.*a\.md/);
  assert.equal(t.calls.length, 0);
}

// A missing file fails the call.
{
  const t = fake();
  const review = createDocReview(t.pi, t.deps);
  await assert.rejects(review.show(CWD, ["nope.md"], "Read"), /cannot read nope\.md/);
}

// A path with a line break would split into two editor commands, so it is refused.
{
  const t = fake();
  const review = createDocReview(t.pi, t.deps);
  await assert.rejects(review.show(CWD, ["a.md\ncall system('x')"], "Read"), /line break/);
}

// A pane the user closed (editor gone) is replaced on the next show.
{
  const t = fake({ files: { "/repo/a.md": "A" } });
  const review = createDocReview(t.pi, t.deps);
  await review.show(CWD, ["a.md"], "Read");
  t.quitEditor();
  await review.show(CWD, ["a.md"], "Read again");
  assert.equal(t.state.splits, 2);
  assert.equal(t.calls.filter((call) => call[1] === "notification").length, 2, "a reopened document notifies again");
}

// Shutdown asks a running editor to quit, which it does only without unsaved edits.
{
  const t = fake({ files: { "/repo/a.md": "A" } });
  const review = createDocReview(t.pi, t.deps);
  await review.show(CWD, ["a.md"], "Read");
  review.closeViewer();
  assert.equal(t.commands().at(-1), "call PiDocReviewClose()");
  assert.equal(t.state.editorUp, false);
  assert.deepEqual(t.state.removed, [], "a running editor removes its own scratch dir");
  review.closeViewer();
  assert.equal(t.commands().filter((line) => line === "call PiDocReviewClose()").length, 1, "closing twice is harmless");

  const u = fake({ files: { "/repo/a.md": "A" } });
  const kept = createDocReview(u.pi, u.deps);
  await kept.show(CWD, ["a.md"], "Read");
  u.state.unsaved = 1;
  kept.closeViewer();
  assert.equal(u.state.editorUp, true, "unsaved edits are never discarded");
  assert.deepEqual(u.state.removed, []);

  // An editor the user already quit leaves nothing to ask, and the scratch dir goes.
  const w = fake({ files: { "/repo/a.md": "A" } });
  const gone = createDocReview(w.pi, w.deps);
  await gone.show(CWD, ["a.md"], "Read");
  w.quitEditor();
  gone.closeViewer();
  assert.deepEqual(w.state.removed, [SCRATCH]);
}

// Editor choice: nvim first, then vim; PI_HERDR_DOC_REVIEW_EDITOR overrides it.
{
  const vimOnly = fake({ installed: ["vim"], files: { "/repo/a.md": "A" } });
  const review = createDocReview(vimOnly.pi, vimOnly.deps);
  const result = await review.show(CWD, ["a.md"], "Read");
  assert.match(editorLaunch(vimOnly.calls).at(-1), /^vim -S /, "vim is used when nvim is missing");
  assert.match(result.text, /editable vim/);

  const chosen = fake({ editor: "vim", files: { "/repo/a.md": "A" } });
  await createDocReview(chosen.pi, chosen.deps).show(CWD, ["a.md"], "Read");
  assert.match(editorLaunch(chosen.calls).at(-1), /^vim -S /, "the environment variable wins over nvim");

  const none = fake({ installed: [], files: { "/repo/a.md": "A" } });
  await assert.rejects(createDocReview(none.pi, none.deps).show(CWD, ["a.md"], "Read"), /needs nvim or vim on PATH/);

  const nano = fake({ editor: "nano", files: { "/repo/a.md": "A" } });
  await assert.rejects(createDocReview(nano.pi, nano.deps).show(CWD, ["a.md"], "Read"), /nano is not supported; use nvim or vim/);

  const missing = fake({ editor: "vim", installed: ["nvim"], files: { "/repo/a.md": "A" } });
  await assert.rejects(createDocReview(missing.pi, missing.deps).show(CWD, ["a.md"], "Read"), /vim is not on PATH/);
}

// The extension: a proposed Mini SDD spec opens its folder's phase files in phase order; later phase files join.
{
  const t = fake({
    files: {
      [`${SPEC_DIR}/spec.md`]: "Status: proposed\n\n# Spec",
      [`${SPEC_DIR}/decision.md`]: "# Decision",
    },
  });
  const handlers = new Map();
  const tools = [];
  docReview({ ...t.pi, on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => tools.push(tool) }, t.deps);
  assert.equal(tools[0].name, "show_doc");
  const toolResult = handlers.get("tool_result");

  await toolResult({ toolName: "write", isError: false, input: { path: "docs/specs/2026-10-16-review/decision.md" } }, t.ctx);
  assert.equal(t.state.splits, 0, "a decision alone does not open the pane");

  await toolResult({ toolName: "write", isError: false, input: { path: "docs/specs/2026-10-16-review/spec.md" } }, t.ctx);
  assert.equal(t.state.splits, 1);
  assert.match(editorLaunch(t.calls).at(-1), /-o -- '.*\/decision\.md' '.*\/spec\.md'; exit$/, "phase files open in phase order");

  t.fs.set(`${SPEC_DIR}/design.md`, "# Design");
  await toolResult({ toolName: "write", isError: false, input: { path: `${SPEC_DIR}/design.md` } }, t.ctx);
  assert.ok(t.commands().includes(`call PiDocReviewAdd('${SPEC_DIR}/design.md')`), "a later phase file becomes a new row");
  assert.equal(t.state.splits, 1);

  // A spec still marked approved elsewhere does not open by itself.
  const other = "/repo/docs/specs/2026-10-01-old/spec.md";
  t.fs.set(other, "Status: approved\n");
  await toolResult({ toolName: "edit", isError: false, input: { path: other } }, t.ctx);
  assert.ok(!t.commands().some((line) => line.includes("2026-10-01-old")));

  // Shell edits move every baseline so the user's next diff excludes them.
  t.fs.set(`${SPEC_DIR}/spec.md`, "Status: proposed\n\nshell");
  await toolResult({ toolName: "bash", isError: false, input: { command: "sed -i ..." } }, t.ctx);
  t.userSaves(`${SPEC_DIR}/spec.md`, "Status: proposed\n\nuser");
  assert.match(t.sent.at(-1).message.content, /shell\+Status: proposed\n\nuser/);
}

// Outside Herdr the auto-open is silent.
{
  const t = fake({ paneId: undefined, files: { [`${SPEC_DIR}/spec.md`]: "Status: proposed\n" } });
  const handlers = new Map();
  docReview({ ...t.pi, on: (event, handler) => handlers.set(event, handler), registerTool: () => {} }, t.deps);
  await handlers.get("tool_result")({ toolName: "write", isError: false, input: { path: `${SPEC_DIR}/spec.md` } }, t.ctx);
  assert.equal(t.calls.length, 0);
  assert.equal(t.notices.length, 0);
}

// HTML opens rendered and view-only in a Chawan pane; text documents keep the editor.
{
  const WEB = "/tmp/review-2";
  const t = fake({ dirs: [SCRATCH, WEB], files: { "/repo/a.md": "A", "/repo/report.html": "<h1>v1</h1>" } });
  const review = createDocReview(t.pi, t.deps);
  review.setContext(t.ctx);
  const result = await review.show(CWD, ["a.md", "report.html"], "Please read");
  assert.deepEqual(result.opened, ["a.md", "report.html"]);
  assert.match(result.text, /a\.md in Herdr pane w:p2 \(editable nvim, one row per document\) and report\.html in Herdr pane w:p3 \(rendered by Chawan, view-only/);
  assert.match(result.text, /saved edits will reach you/);
  const runs = t.calls.filter((call) => call[0] === "herdr" && call[2] === "run").map((call) => call.at(-1));
  assert.match(runs[0], /^nvim .* -- '\/repo\/a\.md'; exit$/, "the HTML page does not open in the editor");
  const splits = t.calls.filter((call) => call[2] === "split");
  assert.deepEqual(splits[1].slice(3, 6), ["w:p2", "--direction", "down"], "the browser pane stacks below the editor pane");
  // Split the command the way the pane's shell does, so the assertion sees the arguments Chawan receives.
  const [sh, flag, inner, ...rest] = shellWords(runs[1].replace(/; exit$/, ""));
  assert.deepEqual([sh, flag, rest], ["sh", "-c", []]);
  const [recordPid, run, cleanUp] = inner.split("; ");
  assert.equal(recordPid, `echo $$ > '${WEB}/ready'`, "the pane's shell records its pid");
  assert.deepEqual(shellWords(run), [
    "cha",
    "-o",
    `start.startup-script='(0, eval)(readFile("${WEB}/review.js"))'`,
    "-o",
    `external.cgi-dir=['${WEB}', '$CHA_LIBEXEC_DIR/cgi-bin']`,
    "-o",
    "buffer.images=true",
    "--",
    "/repo/report.html",
  ]);
  assert.match(t.fs.get(`${WEB}/pi-answer`), /^#!\/bin\/sh\nprintf '%s\\n' "\$QUERY_STRING" >> '\/tmp\/review-2\/answers\.log'\n/, "the answer script records the query string");

  // A submitted form reaches the agent as its fields and, unlike a save, starts a turn when the agent is idle.
  const notices = t.notices.length;
  t.userSubmits(WEB, "q1=%E6%96%B0+skill&note=a%26b+c");
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0].options, { triggerTurn: true });
  assert.equal(t.sent[0].message.content, "User submitted a form in the HTML review pane:\n- q1: 新 skill\n- note: a&b c");
  assert.equal(t.notices.length, notices, "no 'next message' notice: the answers go now");
  t.state.idle = false;
  t.userSubmits(WEB, "q2=yes");
  assert.equal(t.sent[1].options.deliverAs, "steer");
  assert.equal(t.sent[1].message.content, "User submitted a form in the HTML review pane:\n- q2: yes", "only the new submission is sent");
  t.sent.length = 0;
  assert.equal(cleanUp, `rm -rf '${WEB}'`, "the scratch dir goes once Chawan exits");
  const script = t.fs.get(`${WEB}/review.js`);
  assert.match(script, /const control = "\/tmp\/review-2\/commands\.js";/);
  assert.match(script, /setInterval\(\(\) => \{[\s\S]*\(0, eval\)\(line\)[\s\S]*\}, 250\);/, "Chawan polls its command file");
  const browserCommands = () => (t.fs.get(`${WEB}/commands.js`) ?? "").split("\n").filter(Boolean);

  // A second HTML page opens as a new buffer in the running browser.
  t.fs.set("/repo/other.html", "<p>other</p>");
  await review.show(CWD, ["other.html"], "One more");
  assert.equal(t.state.splits, 2, "the browser pane is reused");
  assert.deepEqual(browserCommands(), ['pager.gotoURL("file:///repo/other.html")']);
  await review.show(CWD, ["other.html"], "Again");
  assert.equal(browserCommands().length, 1, "a page already open is not opened twice");

  // The agent's change reloads the page; an unchanged page is left alone, even after a shell command.
  review.agentWrote("/repo/report.html");
  assert.equal(browserCommands().length, 1, "an unchanged page does not reload");
  t.fs.set("/repo/report.html", "<h1>v2</h1>");
  review.agentWrote("/repo/report.html");
  assert.equal(browserCommands().at(-1), 'piDocReviewReload("file:///repo/report.html")');
  review.refreshAfterShell();
  assert.equal(browserCommands().length, 2);
  t.fs.set("/repo/other.html", "<p>shell</p>");
  review.refreshAfterShell();
  assert.equal(browserCommands().at(-1), 'piDocReviewReload("file:///repo/other.html")');
  assert.equal(t.sent.length, 0, "HTML pages send the agent no feedback");

  // Shutdown quits Chawan and stops watching its answers; its pane's shell removes the scratch dir.
  review.closeBrowser();
  assert.equal(browserCommands().at(-1), "quit()");
  assert.equal(t.state.browserUp, false);
  assert.deepEqual(t.state.removed, []);
  assert.ok(!t.watchers.has(`${WEB}/answers.log`), "a closed browser's answers are no longer watched");
}

// An HTML-only show splits right of the agent and promises no edit feedback; without Chawan it fails.
{
  const t = fake({ files: { "/repo/page.htm": "<p>x</p>" } });
  const review = createDocReview(t.pi, t.deps);
  const result = await review.show(CWD, ["page.htm"], "Look");
  assert.deepEqual(t.calls[0], ["herdr", "pane", "split", "w:p1", "--direction", "right", "--no-focus", "--cwd", CWD]);
  assert.doesNotMatch(result.text, /saved edits/);
  assert.equal(review.viewer, undefined, "no editor starts for HTML alone");

  // A browser the user already quit is replaced, and its scratch dir goes.
  t.state.browserUp = false;
  await review.show(CWD, ["page.htm"], "Look again");
  assert.equal(t.state.splits, 2);
  assert.deepEqual(t.state.removed, [SCRATCH]);

  const none = fake({ installed: ["nvim"], files: { "/repo/page.html": "<p>x</p>" } });
  await assert.rejects(createDocReview(none.pi, none.deps).show(CWD, ["page.html"], "Look"), /needs Chawan \(cha\) or terminal-browser on PATH/);
}

// terminal-browser, used when Chawan is missing: pages load from the page server, more pages open as tabs.
{
  const WEB = "/tmp/review-3";
  const t = fake({ dirs: [WEB], installed: ["nvim", "terminal-browser"], files: { "/repo/report.html": "<h1>v1</h1>", "/repo/my page.html": "<p>b</p>" } });
  const review = createDocReview(t.pi, t.deps);
  review.setContext(t.ctx);
  const result = await review.show(CWD, ["report.html", "my page.html"], "Read");
  assert.match(result.text, /in Herdr pane w:p2 \(rendered by terminal-browser, view-only, one tab per page\)/);
  const run = t.calls.find((call) => call[0] === "herdr" && call[2] === "run").at(-1);
  const [, , inner] = shellWords(run.replace(/; exit$/, ""));
  const [recordPid, launch, cleanUp] = inner.split("; ");
  assert.equal(recordPid, `echo $$ > '${WEB}/ready'`);
  assert.deepEqual(shellWords(launch), ["terminal-browser", "open", "http://127.0.0.1:4000/tok1/files/repo/report.html", "--no-merge"]);
  assert.equal(cleanUp, `rm -rf '${WEB}'`);
  assert.ok(![...t.fs.keys()].some((path) => path.startsWith(`${WEB}/`) && path !== `${WEB}/ready`), "no Chawan scratch files");
  const tabs = () => t.calls.filter((call) => call[0] === "terminal-browser" && call[1] === "new-tab");
  assert.deepEqual(tabs(), [["terminal-browser", "new-tab", "--browser", "777-1", "http://127.0.0.1:4000/tok1/files/repo/my%20page.html"]], "the second page opens as a tab of this pane's browser");

  // Another page reuses the browser and the key it found; a page already open is not opened again.
  t.fs.set("/repo/c.html", "<p>c</p>");
  await review.show(CWD, ["c.html", "report.html"], "More");
  assert.equal(t.state.splits, 1);
  assert.equal(tabs().length, 2);
  assert.equal(tabs()[1][4], "http://127.0.0.1:4000/tok1/files/repo/c.html");
  assert.equal(t.calls.filter((call) => call[0] === "terminal-browser" && call[1] === "ls").length, 1);

  // The server serves only the shown pages' directories, below them too, and nothing beside them.
  const [server] = t.state.servers;
  assert.equal(server.allowed("/repo/report.html"), true);
  assert.equal(server.allowed("/repo/img/chart.png"), true);
  assert.equal(server.allowed("/repo/.env"), false, "no dotfile");
  assert.equal(server.allowed("/repo/.git/config"), false, "nor anything in a dot directory");
  assert.equal(server.allowed("/etc/passwd"), false);
  assert.equal(server.allowed("/repository/x.html"), false);
  assert.equal(server.allowed("/repo"), false);

  // A changed page reloads through the server; an unchanged one does not.
  review.agentWrote("/repo/report.html");
  assert.deepEqual(server.reloads, []);
  t.fs.set("/repo/report.html", "<h1>v2</h1>");
  review.agentWrote("/repo/report.html");
  assert.deepEqual(server.reloads, ["/repo/report.html"]);

  // A form posted to the server reaches the agent like a Chawan submission; an empty one does not.
  server.onAnswer("q=%E6%96%B0+skill");
  server.onAnswer("");
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0].options, { triggerTurn: true });
  assert.equal(t.sent[0].message.content, "User submitted a form in the HTML review pane:\n- q: 新 skill");

  // Closing sends ctrl+q to the pane and stops the server; the pane's shell removes the scratch dir.
  review.closeBrowser();
  assert.ok(t.calls.some((call) => call.join(" ") === "herdr pane send-keys w:p2 ctrl+q"));
  assert.equal(server.closed, true);
  assert.deepEqual(t.state.removed, []);
  assert.equal(server.allowed("/repo/report.html"), false, "a closed browser's pages are no longer served");
}

// A browser the user quits stops its page server at the next pane check, not at the next show.
{
  const t = fake({ installed: ["terminal-browser"], files: { "/repo/a.html": "a" } });
  const review = createDocReview(t.pi, t.deps);
  await review.show(CWD, ["a.html"], "Look");
  t.timers.at(-1).tick();
  assert.equal(t.state.servers[0].closed, false, "a running browser is left alone");
  t.state.browserUp = false;
  t.timers.at(-1).tick();
  assert.equal(t.state.servers[0].closed, true);
  assert.equal(review.browser, undefined);
  assert.ok(t.lists().at(-1).every((doc) => !doc.onScreen));
}

// A launch that fails before the pane runs stops the server it started.
{
  const t = fake({ installed: ["terminal-browser"], files: { "/repo/a.html": "a" } });
  t.state.failSplit = true;
  await assert.rejects(createDocReview(t.pi, t.deps).show(CWD, ["a.html"], "Look"), /no room/);
  assert.equal(t.state.servers[0].closed, true);
}

// Chawan is preferred when both are installed; PI_HERDR_DOC_REVIEW_BROWSER picks the browser and fails fast when it cannot be used.
{
  const files = { "/repo/page.html": "<p>x</p>" };
  const both = fake({ installed: ["cha", "terminal-browser"], files });
  const preferred = await createDocReview(both.pi, both.deps).show(CWD, ["page.html"], "Look");
  assert.match(preferred.text, /rendered by Chawan, view-only, one buffer per page/);
  assert.equal(both.state.servers.length, 0, "Chawan needs no page server");
  const chosen = fake({ browser: "terminal-browser", installed: ["cha", "terminal-browser"], files });
  const result = await createDocReview(chosen.pi, chosen.deps).show(CWD, ["page.html"], "Look");
  assert.match(result.text, /rendered by terminal-browser, view-only, one tab per page/);
  const missing = fake({ browser: "cha", installed: ["terminal-browser"], files });
  await assert.rejects(createDocReview(missing.pi, missing.deps).show(CWD, ["page.html"], "Look"), /PI_HERDR_DOC_REVIEW_BROWSER=cha, but cha is not on PATH/);
  assert.equal(missing.state.splits, 0);
  const other = fake({ browser: "lynx", installed: ["lynx"], files });
  await assert.rejects(createDocReview(other.pi, other.deps).show(CWD, ["page.html"], "Look"), /=lynx is not supported; use cha or terminal-browser/);
}

// A terminal-browser that never lists itself fails the second page instead of opening it elsewhere.
{
  const t = fake({ installed: ["terminal-browser"], files: { "/repo/a.html": "a", "/repo/b.html": "b" } });
  t.state.listed = false;
  const review = createDocReview(t.pi, t.deps);
  await assert.rejects(review.show(CWD, ["a.html", "b.html"], "Look"), /was not listed within 15000 ms/);
  assert.equal(t.calls.filter((call) => call[1] === "new-tab").length, 0);
  // The first page did open, so showing it again opens no second copy.
  t.state.listed = true;
  await review.show(CWD, ["a.html", "b.html"], "Again");
  assert.deepEqual(t.calls.filter((call) => call[1] === "new-tab").map((call) => call.at(-1)), ["http://127.0.0.1:4000/tok1/files/repo/b.html"]);
}

// The real page server: files with the page script, answers, reload events, and nothing without the token.
{
  const dir = mkdtempSync(join(tmpdir(), "doc-review-server-"));
  writeFileSync(join(dir, "a b.html"), "<form action=\"cgi-bin:pi-answer\"></form>");
  writeFileSync(join(dir, "pic.png"), Buffer.from([0x89, 0x50]));
  const answers = [];
  const real = realpathSync(dir);
  const server = await createPageServer((query) => answers.push(query), (path) => path.startsWith(`${real}/`));
  symlinkSync("/etc/hosts", join(dir, "escape.html"));
  try {
    const pageUrl = `${server.base}/files${pathToFileURL(join(dir, "a b.html")).pathname}`;
    const page = await fetch(pageUrl);
    assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(page.headers.get("content-security-policy"), "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; form-action 'self'", "pages load nothing from elsewhere");
    const html = await page.text();
    assert.ok(html.startsWith('<form action="cgi-bin:pi-answer"></form>\n<script>'), "the page script follows the page");
    assert.ok(html.includes(JSON.stringify(server.base)));
    const pic = await fetch(`${server.base}/files${pathToFileURL(join(dir, "pic.png")).pathname}`);
    assert.equal(pic.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await pic.arrayBuffer())], [0x89, 0x50], "other files are served as they are");
    assert.equal((await fetch(`${server.base}/files${dir}/missing.html`)).status, 404);
    assert.equal((await fetch(`${server.base}/files/etc/hosts`)).status, 404, "a file outside the allowed directories is not served");
    assert.equal((await fetch(`${server.base}/files${pathToFileURL(join(dir, "escape.html")).pathname}`)).status, 404, "nor is one a symlink leads to");
    const origin = new URL(server.base).origin;
    assert.equal((await fetch(`${origin}/files${pathToFileURL(join(dir, "a b.html")).pathname}`)).status, 404, "no file without the token");
    assert.equal((await fetch(`${origin}/wrong/answer`, { method: "POST", body: "x=1" })).status, 405);

    const posted = await fetch(`${server.base}/answer`, { method: "POST", body: "choice=yes" });
    assert.equal(posted.status, 204);
    assert.deepEqual(answers, ["choice=yes"]);

    const stream = await fetch(`${server.base}/events?page=${encodeURIComponent(new URL(pageUrl).pathname)}`);
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    assert.equal(decoder.decode((await reader.read()).value), ": open\n\n");
    server.reload(join(dir, "other.html"));
    server.reload(join(dir, "a b.html"));
    assert.equal(decoder.decode((await reader.read()).value), "event: reload\ndata:\n\n", "only the changed page's stream hears of it");
    await reader.cancel();
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// The document contract: `documents` lists everything shown, in full, on every change.
{
  const WEB = "/tmp/review-2";
  const t = fake({ dirs: [SCRATCH, WEB], files: { "/repo/a.md": "A", "/repo/report.html": "<h1>v1</h1>" } });
  const review = createDocReview(t.pi, t.deps);
  review.setContext(t.ctx);
  assert.equal(t.emitted.length, 0, "nothing is published before a document is shown");

  await review.show(CWD, ["a.md"], "Read the spec");
  assert.deepEqual(t.emitted.at(-1), {
    channel: "doc-review:documents",
    data: {
      version: 1,
      documents: [{ id: "doc-1", path: "/repo/a.md", kind: "text", display: "a.md", reason: "Read the spec", revision: 1, onScreen: true }],
    },
  });
  await review.show(CWD, ["report.html"], "Read the report");
  assert.deepEqual(
    t.lists().at(-1),
    [
      { id: "doc-1", path: "/repo/a.md", kind: "text", display: "a.md", reason: "Read the spec", revision: 1, onScreen: true },
      { id: "doc-2", path: "/repo/report.html", kind: "html", display: "report.html", reason: "Read the report", revision: 1, onScreen: true },
    ],
    "the full list is sent, not a delta",
  );
  assert.ok(Object.keys(t.lists().at(-1)[0]).every((key) => key !== "seen"), "internal state stays out of the event");

  // Showing a document again keeps its id and reason-updates it; the revision moves only if the file changed.
  const count = t.lists().length;
  await review.show(CWD, ["a.md"], "Read again");
  assert.equal(t.lists().at(-1).find((doc) => doc.path === "/repo/a.md").id, "doc-1");
  assert.equal(t.lists().at(-1).find((doc) => doc.path === "/repo/a.md").revision, 1);
  assert.equal(t.lists().at(-1).at(-1).path, "/repo/a.md", "the document shown last is the newest");
  assert.equal(t.lists().length, count + 1);

  // The agent's change bumps the revision of text and HTML; an unchanged file does not publish.
  const before = t.lists().length;
  review.agentWrote("/repo/a.md");
  assert.equal(t.lists().length, before, "an unchanged document publishes nothing");
  t.fs.set("/repo/a.md", "A2");
  review.agentWrote("/repo/a.md");
  assert.equal(t.lists().at(-1).find((doc) => doc.id === "doc-1").revision, 2);
  t.fs.set("/repo/report.html", "<h1>v2</h1>");
  review.agentWrote("/repo/report.html");
  assert.equal(t.lists().at(-1).find((doc) => doc.id === "doc-2").revision, 2);

  // A shell command that changes files bumps them all in one event.
  t.fs.set("/repo/a.md", "A3");
  t.fs.set("/repo/report.html", "<h1>v3</h1>");
  const beforeShell = t.lists().length;
  review.refreshAfterShell();
  assert.equal(t.lists().length, beforeShell + 1);
  assert.equal(t.lists().at(-1).find((doc) => doc.id === "doc-1").revision, 3);
  assert.equal(t.lists().at(-1).find((doc) => doc.id === "doc-2").revision, 3);

  // The user's save changes the document too.
  t.userSaves("/repo/a.md", "A4");
  assert.equal(t.lists().at(-1).find((doc) => doc.id === "doc-1").revision, 4);

  // Closing a pane marks its documents off screen; the other pane's stay on. The user closing the editor is noticed by the pane check.
  assert.equal(t.timers.filter((timer) => timer.running).length, 1, "one pane check runs while documents are on screen");
  assert.equal(t.timers[0].ms, 1000);
  t.quitEditor();
  t.timers.at(-1).tick();
  assert.deepEqual(t.lists().at(-1).map((doc) => [doc.id, doc.onScreen]), [["doc-2", true], ["doc-1", false]]);
  const afterClose = t.lists().length;
  t.timers.at(-1).tick();
  assert.equal(t.lists().length, afterClose, "a pane check that finds nothing new publishes nothing");
  t.state.browserUp = false;
  t.timers.at(-1).tick();
  assert.ok(t.lists().at(-1).every((doc) => !doc.onScreen));
  assert.equal(t.timers.filter((timer) => timer.running).length, 0, "the pane check stops once nothing is on screen");

  // Showing again after the panes closed puts the document back on screen under the same id.
  await review.show(CWD, ["a.md"], "Back again");
  assert.deepEqual(t.lists().at(-1).map((doc) => [doc.id, doc.onScreen]), [["doc-2", false], ["doc-1", true]]);
  assert.equal(t.timers.filter((timer) => timer.running).length, 1);

  // Shutdown publishes an empty list, stops the pane check, and leaves the existing close behaviour alone.
  review.shutdown();
  assert.deepEqual(t.emitted.at(-1), { channel: "doc-review:documents", data: { version: 1, documents: [] } });
  assert.equal(t.timers.filter((timer) => timer.running).length, 0);
  assert.equal(review.viewer, undefined, "the panes close as before");
  assert.equal(review.browser, undefined);
  assert.equal(review.docs.size, 0);
}

// A pane replaced by a relaunch lists the documents it no longer holds as off screen.
{
  const t = fake({ files: { "/repo/a.md": "A", "/repo/b.md": "B" } });
  const review = createDocReview(t.pi, t.deps);
  await review.show(CWD, ["a.md"], "A");
  t.quitEditor();
  await review.show(CWD, ["b.md"], "B");
  assert.deepEqual(t.lists().at(-1).map((doc) => [doc.display, doc.onScreen]), [["a.md", false], ["b.md", true]]);
}

// A show that finishes after shutdown lists nothing, so the empty list stays the last one and no pane check restarts.
{
  const t = fake({ files: { "/repo/a.md": "A" } });
  const review = createDocReview(t.pi, t.deps);
  let release;
  t.deps.sleep = () => new Promise((done) => (release = done));
  t.deps.pidAlive = () => false;
  const pending = review.show(CWD, ["a.md"], "Read");
  await new Promise((done) => setImmediate(done));
  review.shutdown();
  t.deps.pidAlive = (pid) => pid === 4242;
  release();
  await pending;
  assert.deepEqual(t.emitted.at(-1), { channel: "doc-review:documents", data: { version: 1, documents: [] } });
  assert.equal(t.timers.filter((timer) => timer.running).length, 0);
}

// The list keeps the 32 most recently shown documents.
{
  const files = Object.fromEntries(Array.from({ length: 34 }, (_, index) => [`/repo/d${index}.md`, String(index)]));
  const t = fake({ files });
  const review = createDocReview(t.pi, t.deps);
  for (let index = 0; index < 34; index++) await review.show(CWD, [`d${index}.md`], "Read");
  const list = t.lists().at(-1);
  assert.equal(list.length, 32);
  assert.equal(list[0].display, "d2.md", "the oldest are dropped");
  assert.equal(list.at(-1).display, "d33.md");
}

// A Mini SDD auto-open publishes its phase files with the auto-open reason, without a show_doc call.
{
  const t = fake({ files: { [`${SPEC_DIR}/spec.md`]: "Status: proposed\n", [`${SPEC_DIR}/decision.md`]: "# D" } });
  const handlers = new Map();
  docReview({ ...t.pi, on: (event, handler) => handlers.set(event, handler), registerTool: () => {} }, t.deps);
  await handlers.get("tool_result")({ toolName: "write", isError: false, input: { path: `${SPEC_DIR}/spec.md` } }, t.ctx);
  assert.deepEqual(t.lists().at(-1).map((doc) => [doc.display, doc.reason, doc.onScreen]), [
    ["docs/specs/2026-10-16-review/decision.md", "Spec proposed for approval", true],
    ["docs/specs/2026-10-16-review/spec.md", "Spec proposed for approval", true],
  ]);
}

// Outside Herdr nothing opens and nothing is published.
{
  const t = fake({ paneId: undefined, files: { "/repo/a.md": "A" } });
  await createDocReview(t.pi, t.deps).show(CWD, ["a.md"], "Read");
  assert.equal(t.emitted.length, 0);
  assert.equal(t.timers.length, 0);
}

// A form event is delivered exactly like a Chawan submission of the same fields, and answered on the result event.
{
  const WEB = "/tmp/review-2";
  const t = fake({ dirs: [SCRATCH, WEB], files: { "/repo/report.html": "<form>", "/repo/a.md": "A" } });
  const review = createDocReview(t.pi, t.deps);
  review.setContext(t.ctx);
  t.pi.events.on("doc-review:form", review.onForm);
  await review.show(CWD, ["report.html", "a.md"], "Read");
  const html = t.lists().at(-1).find((doc) => doc.kind === "html").id;
  const text = t.lists().at(-1).find((doc) => doc.kind === "text").id;

  // The Chawan path for the same fields, idle.
  t.userSubmits(WEB, "q1=%E6%96%B0+skill&note=a%26b+c");
  const chawan = t.sent.pop();
  t.form({ version: 1, id: html, answerId: "a1", fields: [["q1", "新 skill"], ["note", "a&b c"]] });
  assert.equal(t.sent.length, 1);
  assert.deepEqual(t.sent[0], chawan, "same message and same options as the CGI path, idle");
  assert.deepEqual(t.sent[0].options, { triggerTurn: true });
  assert.deepEqual(t.results().at(-1), { version: 1, id: html, answerId: "a1", accepted: true });

  // Busy: steered.
  t.state.idle = false;
  t.sent.length = 0;
  t.userSubmits(WEB, "q2=yes");
  const chawanBusy = t.sent.pop();
  t.form({ version: 1, id: html, answerId: "a2", fields: [["q2", "yes"]] });
  assert.deepEqual(t.sent[0], chawanBusy, "same message and same options as the CGI path, busy");
  assert.equal(t.sent[0].options.deliverAs, "steer");
  t.state.idle = true;
  t.sent.length = 0;

  // A repeated answerId replays the result and delivers nothing more.
  const results = t.results().length;
  t.form({ version: 1, id: html, answerId: "a2", fields: [["q2", "yes"]] });
  assert.equal(t.sent.length, 0, "a replayed answer is not delivered twice");
  assert.equal(t.results().length, results + 1);
  assert.deepEqual(t.results().at(-1), { version: 1, id: html, answerId: "a2", accepted: true }, "the first result is replayed");
  t.form({ version: 1, id: "doc-unknown", answerId: "a2", fields: [["q2", "yes"]] });
  assert.equal(t.sent.length, 0);
  assert.equal(t.results().at(-1).accepted, false, "the same answerId for another document is refused");

  // An unknown id is closed, and is remembered like any other result.
  t.form({ version: 1, id: "nope", answerId: "a3", fields: [["x", "y"]] });
  assert.deepEqual(t.results().at(-1), { version: 1, id: "nope", answerId: "a3", accepted: false, reason: "closed" });
  assert.equal(t.sent.length, 0);

  // Text documents take no forms; bad payloads are refused; an empty form is dropped as a Chawan one is.
  t.form({ version: 1, id: text, answerId: "a4", fields: [["x", "y"]] });
  assert.equal(t.results().at(-1).reason, "invalid");
  t.form({ version: 2, id: html, answerId: "a5", fields: [["x", "y"]] });
  assert.equal(t.results().at(-1).reason, "invalid");
  t.form({ version: 1, id: html, answerId: "a6", fields: [["x"]] });
  assert.equal(t.results().at(-1).reason, "invalid");
  t.form({ version: 1, id: html, answerId: "a7", fields: "x=y" });
  assert.equal(t.results().at(-1).reason, "invalid");
  t.form({ version: 1, id: html, answerId: "a8", fields: [] });
  assert.deepEqual(t.results().at(-1), { version: 1, id: html, answerId: "a8", accepted: false, reason: "empty" });
  assert.equal(t.sent.length, 0, "refused forms deliver nothing");
  const refused = t.results().length;
  t.form(null);
  t.form({ version: 1, fields: [] });
  t.form({ version: 1, id: html, answerId: 7, fields: [] });
  assert.equal(t.results().length, refused, "a payload that cannot be answered is ignored");

  // A delivery that throws is reported as not accepted.
  t.pi.sendMessage = () => {
    throw new Error("boom");
  };
  t.form({ version: 1, id: html, answerId: "a9", fields: [["x", "y"]] });
  assert.deepEqual(t.results().at(-1), { version: 1, id: html, answerId: "a9", accepted: false, reason: "delivery failed: boom" });

  // After shutdown the document is unknown.
  review.shutdown();
  t.form({ version: 1, id: html, answerId: "a10", fields: [["x", "y"]] });
  assert.equal(t.results().at(-1).reason, "closed");
}

// The remembered answers are bounded.
{
  const t = fake({ files: { "/repo/p.html": "<form>" } });
  const review = createDocReview(t.pi, t.deps);
  await review.show(CWD, ["p.html"], "Read");
  const id = t.lists().at(-1)[0].id;
  for (let index = 0; index < 300; index++) review.onForm({ version: 1, id, answerId: `n${index}`, fields: [["x", String(index)]] });
  assert.equal(t.sent.length, 300);
  review.onForm({ version: 1, id, answerId: "n299", fields: [["x", "299"]] });
  assert.equal(t.sent.length, 300, "a recent answer still replays");
}

// The extension listens for forms from start-up and stops, with everything else, at shutdown.
{
  const t = fake({ files: { "/repo/p.html": "<form>" } });
  const handlers = new Map();
  docReview({ ...t.pi, on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => handlers.set("tool", tool) }, t.deps);
  assert.equal(t.listeners.get("doc-review:form").length, 1);
  handlers.get("session_start")?.({}, t.ctx);
  await handlers.get("tool").execute("call", { paths: ["p.html"], reason: "Read" }, undefined, undefined, t.ctx);
  const id = t.lists().at(-1)[0].id;
  t.form({ version: 1, id, answerId: "e1", fields: [["x", "y"]] });
  assert.equal(t.sent.length, 1);
  assert.equal(t.results().at(-1).accepted, true);
  handlers.get("session_shutdown")({}, t.ctx);
  assert.equal(t.listeners.get("doc-review:form").length, 0, "the form listener is removed at shutdown");
  assert.equal(t.timers.filter((timer) => timer.running).length, 0, "no pane check outlives the session");
  t.form({ version: 1, id, answerId: "e2", fields: [["x", "y"]] });
  assert.equal(t.sent.length, 1, "a form after shutdown reaches nobody");
  assert.deepEqual(t.emitted.filter((event) => event.channel === "doc-review:documents").at(-1).data.documents, []);
}

// A viewer that starts late asks for the list and gets exactly the last one published.
{
  const t = fake({ dirs: [SCRATCH, "/tmp/review-2"], files: { "/repo/a.md": "A", "/repo/p.html": "<h1>x</h1>" } });
  const handlers = new Map();
  docReview({ ...t.pi, on: (event, handler) => handlers.set(event, handler), registerTool: (tool) => handlers.set("tool", tool) }, t.deps);
  const request = (data) => t.pi.events.emit("doc-review:documents-request", data);
  assert.equal(t.listeners.get("doc-review:documents-request").length, 1);
  handlers.get("session_start")?.({}, t.ctx);

  // Nothing open: the empty list.
  request({ version: 1 });
  assert.deepEqual(t.emitted.at(-1), { channel: "doc-review:documents", data: { version: 1, documents: [] } });

  await handlers.get("tool").execute("call", { paths: ["a.md", "p.html"], reason: "Read" }, undefined, undefined, t.ctx);
  const published = t.lists().at(-1);
  const before = t.lists().length;
  const running = () => t.timers.filter((timer) => timer.running).length;
  assert.equal(running(), 1);
  request({ version: 1 });
  assert.equal(t.lists().length, before + 1, "one list per request");
  assert.deepEqual(t.lists().at(-1), published, "the list is the one last published");
  assert.equal(running(), 1, "a request neither starts nor stops the pane check");
  assert.equal(t.sent.length, 0);

  // Other versions and shapes are ignored.
  for (const data of [{ version: 2 }, { version: "1" }, {}, undefined, null, "1"]) request(data);
  assert.equal(t.lists().length, before + 1);

  // A document whose pane closed stays listed, off screen, and the request repeats exactly that list.
  t.quitEditor();
  t.timers.at(-1).tick();
  const closed = t.lists().at(-1);
  assert.equal(closed.filter((doc) => !doc.onScreen).length, 1);
  const afterClose = t.lists().length;
  request({ version: 1 });
  assert.equal(t.lists().length, afterClose + 1);
  assert.deepEqual(t.lists().at(-1), closed);
  assert.equal(running(), 1, "the other pane is still checked");

  // After shutdown the listener is gone.
  handlers.get("session_shutdown")({}, t.ctx);
  assert.equal(t.listeners.get("doc-review:documents-request").length, 0, "the request listener is removed at shutdown");
  const after = t.lists().length;
  request({ version: 1 });
  assert.equal(t.lists().length, after, "no list is published after shutdown");
  assert.deepEqual(t.lists().at(-1), []);
}

// The handler itself publishes nothing once the session is over, even if it is still called.
{
  const t = fake({ files: { "/repo/a.md": "A" } });
  const review = createDocReview(t.pi, t.deps);
  await review.show(CWD, ["a.md"], "Read");
  review.shutdown();
  const count = t.lists().length;
  review.onRequest({ version: 1 });
  assert.equal(t.lists().length, count);
}

console.log("pi-doc-review: ok");
