# pi-herdr-doc-review

Review the documents your [pi](https://pi.dev) agent writes without leaving the terminal. Inside [Herdr](https://herdr.dev), the agent opens them in an editable nvim pane beside its own, and your edits go back to it as review feedback. HTML pages open rendered in your default browser instead, or in a browser pane when you choose [Chawan](https://chawan.net) or [terminal-browser](https://github.com/zenbu-labs/terminal-browser) (Chromium, drawn in the terminal).

## What it does

- **`show_doc` tool.** The agent calls it with the files it wants you to read (a spec, design, plan, report, or ADR) and a one-line reason. They open in one nvim or vim per session, split to the right of the agent's pane, one row per document, and Herdr shows a notification.
- **Specs open on their own.** When the agent writes a [Mini SDD](https://github.com/wayne930242/anchorloop) `docs/specs/<slug>/spec.md` whose header says `Status: proposed`, the folder's `decision.md`, `spec.md`, `design.md`, and `verification.md` open in phase order without a tool call. A phase file written later in that folder joins as a new row.
- **HTML renders, and its forms answer the agent.** `.html` and `.htm` files open in your default browser (`open` on macOS, `xdg-open` elsewhere), one tab per page, or in one browser pane per session running Chawan or terminal-browser, which stacks below the editor pane when both are open; see [Choosing the browser](#choosing-the-browser).
  - **The default browser** loads pages from the same local page server terminal-browser uses (described below), so live reload and form answers work there too. It runs outside Herdr: the session stops serving the pages when it ends, and you close the tabs yourself.
  - **terminal-browser** renders pages with Chromium, JavaScript included, and draws them through the terminal's kitty graphics, one tab per page. Pages load from a local HTTP server that lives with the pane: bound to `127.0.0.1`, behind a random token in every URL, and stopped once you quit the browser. It serves only files in the directories of the pages shown (and below them), so images, stylesheets, scripts, and links kept next to a page load, while a file elsewhere, `../` above the page included, does not, and neither does a dotfile or anything in a dot directory (`.env`, `.git`). Every response forbids loading anything from elsewhere (`Content-Security-Policy: default-src 'self' data: blob:`, with inline scripts and styles allowed, and forms posting only back to the server), so a page's own scripts run but a CDN script or remote image does not: save it next to the page instead. The policy cannot stop a page's own script from navigating to another site, so show only HTML whose scripts you would run. Switch tabs from its tab bar, and quit with `ctrl+q`.
  - **Chawan** (`cha`) renders CSS, tables, and colours as text, one buffer per page, and draws images through the terminal's kitty or sixel graphics (Herdr inside Ghostty or kitty shows them; elsewhere an image stays `[img]`). It runs no JavaScript. Switch pages with `,` and `.`, and quit with `q`.
  - **Images** (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`) open in the same browser pane as a page of their own, since an editor would show their bytes. Chawan shows each in a small page in its scratch directory that fits the image to the pane, since an image opened on its own waits on Chawan's "Open as" prompt. terminal-browser loads the image itself. Images are not listed on the event bus (see [Browser viewers](#browser-viewers)). Any other binary file is refused, and nothing opens.
  - A form with `action="cgi-bin:pi-answer"` (submitted with GET) sends its fields to the agent when you submit it, in either browser: steered into a running turn, or starting a turn when the agent is idle. terminal-browser posts it to the page server, through a small script the server adds to each HTML page; Chawan runs a scratch-directory CGI script that records each submission. In terminal-browser a page's own script can also submit a form without you, which reaches the agent the same way. The tool tells agents to keep questions out of pages and ask them with their question tool instead.
- **Live reload.** When the agent edits a shown document (with `write`, `edit`, or `bash`), the pane reloads it. terminal-browser reloads every tab showing the page, in the background too. Chawan reloads a changed page while it is the current buffer; press `U` to reload another page after switching to it.
- **Your edits become feedback, without blocking.** The tool returns as soon as the pane is open; nothing waits for you. When you `:w` a shown document, the change since the version the agent last saw is sent as a compact zero-context diff (`@@` headers carry line numbers): steered into a running turn, or attached to your next message when the agent is idle, so a save never starts a turn by itself.
- **Safe close.** Quitting the editor or the browser closes its pane, and the next `show_doc` opens a fresh one. When the session ends, the browser quits (and terminal-browser's page server stops), and the editor quits unless a buffer has unsaved edits, in which case it stays open for you.

Outside Herdr, `show_doc` opens nothing and tells the agent to name the files to you instead.

## Markdown pages

`show_doc` with `view: "page"` renders a Markdown file in the browser instead of opening it in the editor; the default, `view: "edit"`, keeps the editor and its review diffs. The page server renders it on every load (with [markdown-it](https://github.com/markdown-it/markdown-it)), so an agent's edit reloads the rendered page. Chawan reads files from disk and cannot show Markdown pages; the default browser and terminal-browser can.

On top of CommonMark, tables, and raw HTML:

| Markdown | Becomes |
| --- | --- |
| `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`, with an optional title after the marker | a `<pi-callout>` |
| a `mermaid` code block | an SVG diagram drawn on the server by [beautiful-mermaid](https://github.com/lukilabs/beautiful-mermaid), in the page's colours |
| a `diff` code block | added, removed, and hunk lines coloured |
| a `cards` block: YAML list of `{title, tone, body}` | a `<pi-grid>` of `<pi-card>` |
| an `options` block: YAML list of `{title, recommended, body, pros, cons}` | a `<pi-options>` comparison |
| a `form` block: `{title, submit, questions: [{name, label, hint, required, type, other, choices}]}`, each choice a label or `{value, label, note, recommended}` | a `<pi-form>` |

`body` fields are Markdown. A block that cannot be drawn shows its error and source in a red callout instead of failing the page. See [`examples/markdown-demo.md`](examples/markdown-demo.md).

## Feedback panel

Every page served to the default browser or terminal-browser has a feedback button. Selecting text offers a comment on that passage; the panel collects these comments and an overall note, and sends them to the agent in one message that quotes each passage above its comment. Drafts are kept per page in the tab's session storage, so they survive the reload an agent's edit causes. Images enlarge on click.

## Page kit

Every HTML page served to the default browser or terminal-browser gets a built-in kit, so the agent writes bare semantic HTML and no styles or scripts. The kit's stylesheet sits in a CSS layer, so any style a page declares itself wins. Chawan loads pages from disk and gets no kit.

| Element | Use |
| --- | --- |
| base styles | headings, tables, code, `details`, light and dark mode |
| `<pi-callout tone="note\|ok\|warn\|risk" title>` | a highlighted note |
| `<pi-grid>` of `<pi-card title tone>` | a grid of summary cards |
| `<pi-badge tone>` | an inline label |
| `<pi-options>` of `<pi-option title recommended pros="a; b" cons="c; d">` | alternatives side by side |
| `<pi-form title submit>` of `<pi-question name label hint required type="single\|multi\|text" other>` with `<pi-choice value note recommended>` | questions whose answers go to the agent when the user sends the form |

A sent `<pi-form>` reaches the agent like any `cgi-bin:pi-answer` form: one message listing each question's `name` and answer, with the form's title first. Pages also get `window.piDocReview.send(fields)` for their own scripts. See [`examples/kit-gallery.html`](examples/kit-gallery.html) for every element beside its markup, and [`examples/kit-demo.html`](examples/kit-demo.html) for a whole page.

## Browser viewers

Other extensions can show the same documents somewhere else, a browser page for one, through pi's event bus (`pi.events`). Every payload carries `version: 1`. Nothing here changes the panes: the browser, the editor, and saving behave as above.

- **`doc-review:documents`** `{version, documents}` is sent in full on every change: a document shown (by `show_doc` or a Mini SDD auto-open), changed by the agent or saved by the user (`revision` goes up), a pane closed (`onScreen: false`), and `[]` when the session ends. Each entry is `{id, path, kind: "html" | "text", display, reason, revision, onScreen}`. `id` is a random UUID that stays the same while the document is listed, `path` is the real path, and `revision` starts at 1. The list keeps the 32 most recently shown documents.
- **`doc-review:documents-request`** `{version}` asks for the list again, for a viewer that starts after documents were shown (a browser page opened later, for one): the current list is sent once on `doc-review:documents`, exactly as the last change sent it, `[]` when nothing has been shown yet. It changes nothing else. A payload with another `version` is ignored, and so is any request after the session has ended.
- **`doc-review:form`** `{version, id, answerId, fields: [[name, value], …]}` answers a form of the HTML document `id`. It reaches the agent as the same message a form submitted in the browser pane produces, steered into a running turn or starting a turn when the agent is idle.
- **`doc-review:form-result`** `{version, id, answerId, accepted, reason?}` is the reply. `reason` is `closed` (no such document listed), `invalid` (wrong version or shape, or not an HTML document), `empty` (no fields, which the browser pane does not send either), or a delivery error. A repeated `answerId` gets its first result back and delivers nothing again (the same `answerId` with another `id` gets `invalid`). A payload without a string `id` and `answerId` gets no reply.

## Requirements

- pi
- Herdr (the pane runs in the agent's Herdr workspace)
- `nvim` or `vim` on `PATH`. Neither needs a remote-control build: the editor polls a command file in its scratch directory every 250 ms, so new rows and reloads arrive within that delay.
- For HTML only, one of:
  - terminal-browser on `PATH` (`brew install terminal-browser`, or see its [install notes](https://github.com/zenbu-labs/terminal-browser#installation)), and a terminal with kitty graphics around Herdr, such as Ghostty or kitty. Without kitty graphics its pane stays blank; use Chawan there.
  - Chawan (`cha`) on `PATH`, for example `brew install chawan`. It runs a start-up script that polls its own command file the same way.

## Choosing the editor

nvim is used when it is on `PATH`, otherwise vim. Set `PI_HERDR_DOC_REVIEW_EDITOR=vim` (or `nvim`) in the environment pi starts in to choose one. nano and other editors are not supported: they cannot run the timer that takes new rows and reloads.

## Choosing the browser

The default browser is used when `open` (macOS) or `xdg-open` is on `PATH`, then Chawan, then terminal-browser, and the tool's reply names the one that rendered the page. The default browser comes first because both terminal browsers render pages poorly next to a real one: Chawan runs no JavaScript and approximates CSS, and terminal-browser streams Chromium's frames through kitty graphics, which is slow in a Herdr pane. Set `PI_HERDR_DOC_REVIEW_BROWSER=external`, `cha`, or `terminal-browser` in the environment pi starts in to choose one; a chosen browser that is not on `PATH` fails the show instead of falling back to the other.

## Install

```bash
pi install npm:pi-herdr-doc-review
```

Then `/reload` in a running session.

## License

MIT
