# pi-herdr-doc-review

Review the documents your [pi](https://pi.dev) agent writes without leaving the terminal. Inside [Herdr](https://herdr.dev), the agent opens them in an editable nvim pane beside its own, and your edits go back to it as review feedback. HTML pages open rendered in a [Chawan](https://chawan.net) pane instead.

## What it does

- **`show_doc` tool.** The agent calls it with the files it wants you to read (a spec, design, plan, report, or ADR) and a one-line reason. They open in one nvim or vim per session, split to the right of the agent's pane, one row per document, and Herdr shows a notification.
- **Specs open on their own.** When the agent writes a [Mini SDD](https://github.com/wayne930242/aaaav) `docs/specs/<slug>/spec.md` whose header says `Status: proposed`, the folder's `decision.md`, `spec.md`, `design.md`, and `verification.md` open in phase order without a tool call. A phase file written later in that folder joins as a new row.
- **HTML renders, and its forms answer the agent.** `.html` and `.htm` files open in one Chawan (`cha`) pane per session, one buffer per page, with CSS, tables, and colours rendered as text. It stacks below the editor pane when both are open. Switch pages with `,` and `.`, and quit with `q`. A form with `action="cgi-bin:pi-answer"` (GET) sends its fields to the agent when you submit it: steered into a running turn, or starting a turn when the agent is idle; a scratch-directory CGI script records each submission. The tool tells agents to keep questions out of pages and ask them with their question tool instead. Chawan runs no JavaScript in pages.
- **Live reload.** When the agent edits a shown document (with `write`, `edit`, or `bash`), the pane reloads it. Chawan reloads a changed page while it is the current buffer; press `U` to reload another page after switching to it.
- **Your edits become feedback, without blocking.** The tool returns as soon as the pane is open; nothing waits for you. When you `:w` a shown document, the change since the version the agent last saw is sent as a compact zero-context diff (`@@` headers carry line numbers): steered into a running turn, or attached to your next message when the agent is idle, so a save never starts a turn by itself.
- **Safe close.** Quitting the editor or Chawan closes its pane, and the next `show_doc` opens a fresh one. When the session ends, Chawan quits, and the editor quits unless a buffer has unsaved edits, in which case it stays open for you.

Outside Herdr, `show_doc` opens nothing and tells the agent to name the files to you instead.

## Browser viewers

Other extensions can show the same documents somewhere else, a browser page for one, through pi's event bus (`pi.events`). Every payload carries `version: 1`. Nothing here changes the panes: Chawan, nvim, and saving behave as above.

- **`doc-review:documents`** `{version, documents}` is sent in full on every change: a document shown (by `show_doc` or a Mini SDD auto-open), changed by the agent or saved by the user (`revision` goes up), a pane closed (`onScreen: false`), and `[]` when the session ends. Each entry is `{id, path, kind: "html" | "text", display, reason, revision, onScreen}`. `id` is a random UUID that stays the same while the document is listed, `path` is the real path, and `revision` starts at 1. The list keeps the 32 most recently shown documents.
- **`doc-review:form`** `{version, id, answerId, fields: [[name, value], …]}` answers a form of the HTML document `id`. It reaches the agent as the same message a Chawan submission produces, steered into a running turn or starting a turn when the agent is idle.
- **`doc-review:form-result`** `{version, id, answerId, accepted, reason?}` is the reply. `reason` is `closed` (no such document listed), `invalid` (wrong version or shape, or not an HTML document), `empty` (no fields, which Chawan does not send either), or a delivery error. A repeated `answerId` gets its first result back and delivers nothing again (the same `answerId` with another `id` gets `invalid`). A payload without a string `id` and `answerId` gets no reply.

## Requirements

- pi
- Herdr (the pane runs in the agent's Herdr workspace)
- `nvim` or `vim` on `PATH`. Neither needs a remote-control build: the editor polls a command file in its scratch directory every 250 ms, so new rows and reloads arrive within that delay.
- For HTML only: Chawan (`cha`) on `PATH`, for example `brew install chawan`. It runs a start-up script that polls its own command file the same way.

## Choosing the editor

nvim is used when it is on `PATH`, otherwise vim. Set `PI_HERDR_DOC_REVIEW_EDITOR=vim` (or `nvim`) in the environment pi starts in to choose one. nano and other editors are not supported: they cannot run the timer that takes new rows and reloads.

## Install

```bash
pi install npm:pi-herdr-doc-review
```

Then `/reload` in a running session.

## License

MIT
