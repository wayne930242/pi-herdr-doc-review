# pi-herdr-doc-review

Review the documents your [pi](https://pi.dev) agent writes without leaving the terminal. Inside [Herdr](https://herdr.dev), the agent opens them in an editable nvim pane beside its own, and your edits go back to it as review feedback. HTML pages open rendered in a [Chawan](https://chawan.net) pane instead.

## What it does

- **`show_doc` tool.** The agent calls it with the files it wants you to read (a spec, design, plan, report, or ADR) and a one-line reason. They open in one nvim or vim per session, split to the right of the agent's pane, one row per document, and Herdr shows a notification.
- **Specs open on their own.** When the agent writes a [Mini SDD](https://github.com/wayne930242/aaaav) `docs/specs/<slug>/spec.md` whose header says `Status: proposed`, the folder's `decision.md`, `spec.md`, `design.md`, and `verification.md` open in phase order without a tool call. A phase file written later in that folder joins as a new row.
- **HTML renders, view-only.** `.html` and `.htm` files open in one Chawan (`cha`) pane per session, one buffer per page, with CSS, tables, and colours rendered as text. It stacks below the editor pane when both are open. Switch pages with `,` and `.`, and quit with `q`. HTML sends no edit feedback.
- **Live reload.** When the agent edits a shown document (with `write`, `edit`, or `bash`), the pane reloads it. Chawan reloads a changed page while it is the current buffer; press `U` to reload another page after switching to it.
- **Your edits become feedback, without blocking.** The tool returns as soon as the pane is open; nothing waits for you. When you `:w` a shown document, the change since the version the agent last saw is sent as a compact zero-context diff (`@@` headers carry line numbers): steered into a running turn, or attached to your next message when the agent is idle, so a save never starts a turn by itself.
- **Safe close.** Quitting the editor or Chawan closes its pane, and the next `show_doc` opens a fresh one. When the session ends, Chawan quits, and the editor quits unless a buffer has unsaved edits, in which case it stays open for you.

Outside Herdr, `show_doc` opens nothing and tells the agent to name the files to you instead.

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
