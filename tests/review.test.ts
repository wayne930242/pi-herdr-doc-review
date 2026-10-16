import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import docReview, { createDocReview, MAX_DIFF_CHARS } from "../src/index.ts";

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
  const state = { editorUp: false, browserUp: false, unsaved: 0, splits: 0, removed: [], idle: true };
  const installed = options.installed ?? ["nvim", "vim", "cha"];
  const dirs = options.dirs ?? [SCRATCH];
  let made = 0;
  let lastDir = SCRATCH;
  const quitEditor = () => {
    state.editorUp = false;
    fs.delete(READY);
  };
  const deps = {
    paneId,
    herdr: "herdr",
    editor: options.editor,
    onPath: (command) => installed.includes(command),
    pidAlive: (pid) => (state.editorUp && pid === 4242) || (state.browserUp && pid === 5151),
    run: (command, args) => {
      calls.push([command, ...args]);
      if (command === "herdr" && args[0] === "pane" && args[1] === "split") {
        state.splits++;
        return { status: 0, stdout: JSON.stringify({ result: { pane: { pane_id: `w:p${state.splits + 1}` } } }), stderr: "" };
      }
      if (command === "herdr" && args[0] === "pane" && args[1] === "run") {
        const isBrowser = args[3].includes(" cha -o ");
        if (isBrowser) state.browserUp = true;
        else state.editorUp = true;
        fs.set(`${lastDir}/ready`, isBrowser ? "5151\n" : "4242\n");
        return { status: 0, stdout: "", stderr: "" };
      }
      if (command === "herdr") return { status: 0, stdout: "{}", stderr: "" };
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
  };
  const pi = { sendMessage: (message, options) => sent.push({ message, options }) };
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
  return { deps, fs, calls, sent, notices, state, pi, ctx, userSaves, userSubmits, quitEditor, commands, watchers };
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
    "--",
    "/repo/report.html",
  ]);
  assert.match(t.fs.get(`${WEB}/pi-answer`), /^#!\/bin\/sh\nprintf '%s\\n' "\$QUERY_STRING" >> '\/tmp\/review-2\/answers\.log'\n/, "the answer script records the query string");

  // A submitted form reaches the agent as its fields, like a save.
  t.userSubmits(WEB, "q1=%E6%96%B0+skill&note=a%26b+c");
  assert.equal(t.sent.length, 1);
  assert.equal(t.sent[0].options.deliverAs, "nextTurn");
  assert.equal(t.sent[0].message.content, "User submitted a form in the HTML review pane:\n- q1: 新 skill\n- note: a&b c");
  assert.match(t.notices.at(-1)[0], /^Your form answers go to the agent/);
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
  await assert.rejects(createDocReview(none.pi, none.deps).show(CWD, ["page.html"], "Look"), /needs Chawan \(cha\) on PATH/);
}

console.log("pi-doc-review: ok");
