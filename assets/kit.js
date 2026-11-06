// pi-herdr-doc-review page kit: light-DOM custom elements styled by kit.css. A page loads it from the
// page server, which also defines `window.piDocReview.send(fields)` to hand form answers to the agent.

const make = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const okBadge = (text) => {
  const badge = make("pi-badge", { textContent: text || "Recommended" });
  badge.setAttribute("tone", "ok");
  return badge;
};

// The kit's own words follow the page's language, else the browser's. Defined before the elements,
// which build as soon as they are defined.
const zh = /^zh/i.test(document.documentElement.lang || navigator.language);
const words = zh
  ? { feedback: "回饋", comment: "留言", heading: "給 agent 的回饋", hint: "選取頁面上的文字可以針對那段留言。", overall: "整體意見", send: "送給 agent", sending: "傳送中…", sent: "已送給 agent。", empty: "還沒有內容。", remove: "移除", notSent: "沒送出：", other: "其他（自行填寫）", note: "回饋（留白代表沒意見）", pick: "選這個", unanswered: "還沒回答：", resend: "已送給 agent。改了可以再送一次。", zoom: "放大回饋", zoomAll: "逐張放大檢視", previous: "上一張", next: "下一張", close: "關閉", commented: "已回饋", viewing: "←→ 或 ↑↓ 切換　Space／Enter 寫回饋　Esc 關閉　點圖看原尺寸", writing: "Esc 回到檢視", write: "按 Space 或 Enter 寫回饋（留白代表沒意見）" }
  : { feedback: "Feedback", comment: "Comment", heading: "Feedback for the agent", hint: "Select text on the page to comment on it.", overall: "Overall", send: "Send to agent", sending: "Sending…", sent: "Sent to the agent.", empty: "Nothing to send yet.", remove: "Remove", notSent: "Not sent: ", other: "Other (type your own)", note: "Feedback (leave blank for none)", pick: "Pick this", unanswered: "Unanswered: ", resend: "Sent to the agent. Change anything and send again to update it.", zoom: "Zoom & comment", zoomAll: "View one by one", previous: "Previous", next: "Next", close: "Close", commented: "commented", viewing: "←→ or ↑↓ switch · Space/Enter write feedback · Esc close · click the image for full size", writing: "Esc back to viewing", write: "Press Space or Enter to write feedback (leave blank for none)" };

/** An element that builds its content once, when it is first attached. */
class Built extends HTMLElement {
  connectedCallback() {
    // React's pi-kit renders the final markup itself and marks it data-static.
    if (this.built || this.hasAttribute("data-static")) return;
    this.built = true;
    this.build();
  }
  build() {}
  /** Puts the `title` attribute in front of the content as a heading line. */
  titled() {
    const title = this.getAttribute("title");
    if (!title) return;
    this.removeAttribute("title");
    this.prepend(make("span", { className: "pi-title", textContent: title }));
  }
}

class Callout extends Built {
  build() {
    this.titled();
  }
}

class Card extends Built {
  build() {
    this.titled();
  }
}

/** <pi-option title recommended pros="a; b" cons="c; d">: one alternative in a <pi-options> comparison. */
class Option extends Built {
  build() {
    const list = (attribute, className) => {
      const items = (this.getAttribute(attribute) ?? "").split(";").map((item) => item.trim()).filter(Boolean);
      if (items.length > 0) this.append(make("ul", { className }, ...items.map((item) => make("li", { textContent: item }))));
    };
    list("pros", "pi-pros");
    list("cons", "pi-cons");
    this.titled();
    if (this.hasAttribute("recommended")) this.querySelector(":scope > .pi-title")?.append(" ", okBadge(this.getAttribute("recommended")));
  }
}

let questions = 0;

/**
 * <pi-question name label type="single|multi|text" hint required other="Other">, with <pi-choice
 * value note recommended>Label</pi-choice> children. Without choices it is a text question. A choice
 * question ends with a box for the user's own answer, labelled by `other`; `other="false"` drops it.
 */
class Question extends Built {
  build() {
    const id = `pi-q${++questions}`;
    const choices = [...this.querySelectorAll(":scope > pi-choice")];
    const type = this.getAttribute("type") ?? (choices.length > 0 ? "single" : "text");
    this.kind = type;
    const label = make("span", { className: "pi-title", textContent: this.getAttribute("label") ?? this.name });
    const parts = [label];
    const hint = this.getAttribute("hint");
    if (hint) parts.push(make("span", { className: "pi-hint", textContent: hint }));
    if (type === "text") {
      parts.push(make("textarea", { name: id }));
    } else {
      const input = type === "multi" ? "checkbox" : "radio";
      for (const choice of choices) {
        const value = choice.getAttribute("value") ?? choice.textContent.trim();
        const text = make("span", { textContent: choice.textContent.trim() });
        if (choice.hasAttribute("recommended")) text.append(okBadge(choice.getAttribute("recommended")));
        const note = choice.getAttribute("note");
        if (note) text.append(make("small", { textContent: note }));
        parts.push(make("label", { className: "pi-choice" }, make("input", { type: input, name: id, value }), text));
      }
      const other = this.getAttribute("other");
      if (other !== "false") {
        const box = make("input", { type: "text", placeholder: other || words.other, className: "pi-other" });
        parts.push(make("label", { className: "pi-choice" }, make("input", { type: input, name: id, value: "", className: "pi-other-pick" }), box));
        box.addEventListener("input", () => {
          this.querySelector(".pi-other-pick").checked = box.value !== "";
        });
      }
    }
    this.replaceChildren(...parts);
  }
  get name() {
    return this.getAttribute("name") ?? this.getAttribute("label") ?? "answer";
  }
  /** The answer as text, or "" when unanswered. */
  get answer() {
    if (this.kind === "text") return this.querySelector("textarea").value.trim();
    const picked = [...this.querySelectorAll("input:checked")].map((input) =>
      input.classList.contains("pi-other-pick") ? this.querySelector(".pi-other").value.trim() : input.value,
    );
    return picked.filter(Boolean).join(", ");
  }
}

/** Resolves a second after it is called: a send button stays disabled that long so the user sees the send happen. */
const held = () => new Promise((resolve) => setTimeout(resolve, 1000));

/** <pi-form title submit="Send">: gathers its <pi-question> answers and sends them to the agent. */
class Form extends Built {
  build() {
    this.titled();
    const status = make("span", { className: "pi-status" });
    const button = make("button", { type: "button", textContent: this.getAttribute("submit") ?? words.send });
    button.addEventListener("click", async () => {
      const asked = [...this.querySelectorAll("pi-question")];
      const missing = asked.filter((question) => question.hasAttribute("required") && !question.answer);
      if (missing.length > 0) {
        status.textContent = `${words.unanswered}${missing.map((question) => question.getAttribute("label") ?? question.name).join(", ")}`;
        return;
      }
      const fields = asked.map((question) => [question.name, question.answer || "(no answer)"]);
      const title = this.querySelector(":scope > .pi-title")?.textContent;
      if (title) fields.unshift(["form", title]);
      button.disabled = true;
      status.textContent = words.sending;
      const shown = held();
      try {
        if (!window.piDocReview) throw new Error("this page was not opened by show_doc");
        await window.piDocReview.send(fields);
        status.textContent = words.resend;
      } catch (error) {
        status.textContent = words.notSent + error.message;
      } finally {
        // The form stays usable: a changed answer can be sent again, after the pause that shows it went.
        await shown;
        button.disabled = false;
      }
    });
    this.append(make("div", {}, button, status));
  }
}

/** A prototype's URL with `pi-bare`, so the page server shows it as written, without the kit. */
const bare = (page) => {
  const url = new URL(page, location.href);
  url.searchParams.set("pi-bare", "");
  return url.href;
};

/**
 * Item names: an item's own name, else the next letter no item claims (A, B, C…, then numbers);
 * a repeated name gets a number, so every item keeps its own pick value and comment.
 */
const itemNames = (names) => {
  const claimed = new Set(names.filter(Boolean));
  const taken = new Set();
  let next = 0;
  const free = () => {
    for (;;) {
      const name = next < 26 ? String.fromCharCode(65 + next) : String(next + 1);
      next++;
      if (!claimed.has(name)) return name;
    }
  };
  return names.map((name) => {
    const base = name || free();
    let unique = base;
    for (let count = 2; taken.has(unique); count++) unique = `${base}${count}`;
    taken.add(unique);
    return unique;
  });
};

/** An item's name with its label, as the agent reads it: `B (dark header)`. */
const itemName = (name, label) => (label ? `${name} (${label})` : name);

/**
 * <pi-review title submit pick columns> of <pi-item name label image page height>: things the user
 * gives feedback on one by one (an image, an HTML prototype in a frame, or the item's own content),
 * each with a comment box that means "no feedback" when left blank. With `pick` (its value labels the
 * choice), the user also picks one favourite, for an A/B test. Items are named A, B, C… unless they
 * carry a name (see itemNames). Drafts survive the reload an agent's edit causes, kept per page in sessionStorage.
 */
let reviews = 0;
class Review extends Built {
  build() {
    const title = this.getAttribute("title") ?? "";
    // Keyed by position and title, so a review the agent inserts above drops a draft rather than taking it.
    const key = `pi-review:${location.pathname}:${++reviews}:${title}`;
    const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") ?? { picked: "", comments: {} };
    const save = () => sessionStorage.setItem(key, JSON.stringify(saved));
    this.titled();
    const columns = Number(this.getAttribute("columns"));
    const grid = make("div", { className: "pi-review-items" });
    // A column count holds on wide screens; a narrow one stacks the items.
    if (columns > 0) {
      grid.dataset.columns = "";
      grid.style.setProperty("--pi-columns", String(columns));
    }
    const pick = this.getAttribute("pick");
    const group = `${key}:pick`;
    const elements = [...this.querySelectorAll(":scope > pi-item")];
    const names = itemNames(elements.map((item) => item.getAttribute("name") ?? ""));
    const items = elements.map((item, index) => {
      const name = names[index];
      const label = item.getAttribute("label") ?? "";
      const head = make("div", { className: "pi-item-head" }, make("span", { className: "pi-title", textContent: itemName(name, label) }));
      const image = item.getAttribute("image");
      if (image) head.append(make("button", { type: "button", className: "pi-zoom-review", textContent: words.zoom }));
      if (pick !== null) {
        const radio = make("input", { type: "radio", name: group, value: name, checked: saved.picked === name });
        radio.addEventListener("change", () => {
          saved.picked = name;
          save();
        });
        head.append(make("label", { className: "pi-pick" }, radio, pick || words.pick));
      }
      const body = make("div", { className: "pi-item-body" }, ...item.childNodes);
      if (image) body.prepend(make("img", { src: image, alt: itemName(name, label) }));
      const page = item.getAttribute("page");
      if (page) {
        const frame = make("div", { className: "pi-frame" }, make("iframe", { src: bare(page), title: itemName(name, label) }));
        frame.style.height = `${Number(item.getAttribute("height")) || 480}px`;
        body.prepend(frame);
      }
      const note = make("textarea", { placeholder: words.note, value: saved.comments[name] ?? "" });
      note.addEventListener("input", () => {
        saved.comments[name] = note.value;
        save();
      });
      item.replaceChildren(head, body, note);
      grid.append(item);
      return { name: itemName(name, label), value: name, note };
    });
    const status = make("span", { className: "pi-status" });
    const button = make("button", { type: "button", textContent: this.getAttribute("submit") ?? words.send });
    button.addEventListener("click", async () => {
      const picked = items.find((item) => item.value === saved.picked);
      const commented = items.filter((item) => item.note.value.trim());
      if (!picked && commented.length === 0) return void (status.textContent = words.empty);
      const fields = [["pi-kind", "review"], ["title", title || document.title]];
      if (picked) fields.push(["picked", picked.name]);
      for (const item of commented) fields.push(["item", item.name], ["comment", item.note.value.trim()]);
      const silent = items.filter((item) => !item.note.value.trim()).map((item) => item.name);
      if (silent.length > 0) fields.push(["silent", silent.join(", ")]);
      button.disabled = true;
      status.textContent = words.sending;
      const shown = held();
      try {
        if (!window.piDocReview) throw new Error("this page was not opened by show_doc");
        await window.piDocReview.send(fields);
        status.textContent = words.resend;
      } catch (error) {
        status.textContent = words.notSent + error.message;
      } finally {
        await shown;
        button.disabled = false;
      }
    });
    if (elements.some((item) => item.hasAttribute("image"))) {
      this.querySelector(":scope > .pi-title")?.after(make("button", { type: "button", className: "pi-zoom-review pi-zoom-all", textContent: words.zoomAll }));
    }
    this.append(grid, make("div", {}, button, status));
  }
}

for (const [tag, element] of [
  ["pi-callout", Callout],
  ["pi-review", Review],
  ["pi-card", Card],
  ["pi-option", Option],
  ["pi-question", Question],
  ["pi-form", Form],
]) {
  if (!customElements.get(tag)) customElements.define(tag, element);
}

/** Sets a text box's value as typing would, so the page's own listeners (React's too) see the change. */
const typeInto = (box, value) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, value);
  box.dispatchEvent(new Event("input", { bubbles: true }));
};

/**
 * The review viewer: a review's image items one at a time, filling the window, with the item's
 * steps and comment box beside the image. ←/→ or ↑/↓ switch items, Space or Enter goes to the comment
 * box, Esc leaves the box and then closes the viewer, and a click on the image shows it at full size.
 * It works on the review's markup (kit.js and React render the same), and the comment box writes
 * through to the item's own box, so drafts, picks, and sending stay with the review.
 */
function reviewViewer() {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const opener = target.closest(".pi-zoom-review") ?? (target instanceof HTMLImageElement ? target.closest("pi-item .pi-item-body > img") : null);
    const review = opener?.closest("pi-review");
    if (!review) return;
    const items = [...review.querySelectorAll("pi-item")].filter((item) => item.closest("pi-review") === review && item.querySelector(":scope > .pi-item-body > img"));
    if (items.length === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    view(items, Math.max(0, items.indexOf(opener.closest("pi-item"))), opener);
  });

  function view(items, start, opener) {
    let index = start;
    const image = make("img");
    const stage = make("div", { className: "pi-viewer-stage" }, image);
    const count = make("span", { className: "pi-viewer-count" });
    const previous = make("button", { type: "button", textContent: "‹", title: words.previous });
    const next = make("button", { type: "button", textContent: "›", title: words.next });
    const close = make("button", { type: "button", textContent: "×", title: words.close });
    const title = make("span", { className: "pi-title" });
    const body = make("div", { className: "pi-viewer-body" });
    const pick = make("label", { className: "pi-pick" });
    const note = make("textarea", { placeholder: words.write });
    const keys = make("p", { className: "pi-viewer-keys", textContent: words.viewing });
    const side = make("aside", { className: "pi-viewer-side" }, make("div", { className: "pi-viewer-top" }, count, previous, next, close), title, body, pick, note, keys);
    const box = make("div", { className: "pi-viewer", tabIndex: -1 }, stage, side);
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.dataset.piFeedback = "";
    const overflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    const noteOf = (item) => item.querySelector(":scope > textarea");
    const tally = () => {
      const commented = items.filter((each) => noteOf(each)?.value.trim()).length;
      count.textContent = `${index + 1} / ${items.length}　${words.commented} ${commented}`;
    };
    const draw = () => {
      const item = items[index];
      const shown = item.querySelector(":scope > .pi-item-body > img");
      image.src = shown.currentSrc || shown.src;
      image.alt = shown.alt;
      stage.classList.remove("pi-actual");
      stage.scrollTo(0, 0);
      title.textContent = item.querySelector(".pi-item-head .pi-title")?.textContent ?? "";
      body.replaceChildren(...[...item.querySelector(":scope > .pi-item-body").childNodes].filter((node) => node !== shown).map((node) => node.cloneNode(true)));
      const radio = item.querySelector(".pi-pick input");
      pick.hidden = !radio;
      if (radio) pick.replaceChildren(make("input", { type: "checkbox", checked: radio.checked }), radio.parentElement.textContent.trim());
      note.value = noteOf(item)?.value ?? "";
      tally();
      previous.disabled = index === 0;
      next.disabled = index === items.length - 1;
    };
    const go = (step) => {
      const to = Math.min(items.length - 1, Math.max(0, index + step));
      if (to === index) return;
      index = to;
      draw();
    };
    const leaveNote = () => {
      note.blur();
      box.focus();
    };
    const end = () => {
      document.removeEventListener("keydown", onKey, true);
      box.remove();
      document.documentElement.style.overflow = overflow;
      items[index].scrollIntoView({ block: "nearest" });
      if (opener.isConnected) opener.focus({ preventScroll: true });
    };
    const onKey = (event) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target === note) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        return leaveNote();
      }
      const moves = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
      if (event.key in moves) go(moves[event.key]);
      else if (event.key === " " || event.key === "Enter") note.focus();
      else if (event.key === "Escape") end();
      else return;
      event.preventDefault();
      event.stopPropagation();
    };

    note.addEventListener("input", () => {
      const own = noteOf(items[index]);
      if (own) typeInto(own, note.value);
      tally();
    });
    note.addEventListener("focus", () => (keys.textContent = words.writing));
    note.addEventListener("blur", () => (keys.textContent = words.viewing));
    pick.addEventListener("click", (event) => {
      event.preventDefault();
      items[index].querySelector(".pi-pick input")?.click();
      draw();
    });
    previous.addEventListener("click", () => go(-1));
    next.addEventListener("click", () => go(1));
    close.addEventListener("click", end);
    image.addEventListener("click", () => stage.classList.toggle("pi-actual"));
    stage.addEventListener("click", (event) => event.target === stage && end());
    // Mouse clicks on the viewer's buttons leave the keys with the viewer, not the button.
    side.addEventListener("mouseup", (event) => event.target.closest("button") && box.focus());
    document.addEventListener("keydown", onKey, true);
    document.body.append(box);
    draw();
    box.focus();
  }
}

/** Images enlarge on click, unless they are links; a review item's image opens the review viewer instead. */
function zoomImages() {
  document.addEventListener("click", (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.classList.contains("pi-zoomable")) return;
    if (image.closest(".pi-viewer")) return;
    const box = make("div", { className: "pi-lightbox" }, make("img", { src: image.currentSrc || image.src, alt: image.alt }));
    const close = () => {
      box.remove();
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (key) => key.key === "Escape" && close();
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.append(box);
  });
  const mark = () => {
    for (const image of document.querySelectorAll("img:not(.pi-zoomable)")) {
      if (!image.closest("a, .pi-lightbox, .pi-viewer, button")) image.classList.add("pi-zoomable");
    }
  };
  mark();
  new MutationObserver(mark).observe(document.body, { childList: true, subtree: true });
}

/**
 * The feedback panel: comments on selected passages plus an overall note, sent to the agent in one
 * message. Drafts survive the reload an agent's edit causes, kept per page in sessionStorage.
 */
function feedbackPanel() {
  const key = `pi-feedback:${location.pathname}`;
  const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") ?? { items: [], overall: "", open: false };
  const state = { items: saved.items ?? [], overall: saved.overall ?? "", open: Boolean(saved.open) };
  const save = () => sessionStorage.setItem(key, JSON.stringify(state));

  const toggle = make("button", { type: "button", className: "pi-fb-toggle", textContent: words.feedback });
  const panel = make("div", { className: "pi-fb-panel", hidden: !state.open });
  const list = make("div");
  const overall = make("textarea", { placeholder: words.overall, value: state.overall });
  const status = make("span", { className: "pi-fb-status" });
  const send = make("button", { type: "button", className: "pi-fb-send", textContent: words.send });
  panel.append(make("h4", { textContent: words.heading }), make("p", { className: "pi-fb-hint", textContent: words.hint }), list, overall, make("div", {}, send, status));
  const quoteButton = make("button", { type: "button", className: "pi-fb-quote-button", textContent: words.comment, hidden: true });
  for (const node of [toggle, panel, quoteButton]) node.dataset.piFeedback = "";
  document.body.append(panel, toggle, quoteButton);

  const count = () => {
    const filled = state.items.length + (state.overall.trim() ? 1 : 0);
    if (filled > 0) toggle.dataset.count = String(filled);
    else delete toggle.dataset.count;
  };
  const draw = () => {
    list.replaceChildren(
      ...state.items.map((item, index) => {
        const note = make("textarea", { value: item.comment, placeholder: words.comment });
        note.addEventListener("input", () => {
          item.comment = note.value;
          save();
        });
        const remove = make("button", { type: "button", textContent: words.remove });
        remove.addEventListener("click", () => {
          state.items.splice(index, 1);
          save();
          draw();
        });
        return make("div", { className: "pi-fb-item" }, remove, make("blockquote", { textContent: item.quote }), note);
      }),
    );
    count();
  };
  const open = (show) => {
    state.open = show;
    panel.hidden = !show;
    save();
  };
  toggle.addEventListener("click", () => open(panel.hidden));
  overall.addEventListener("input", () => {
    state.overall = overall.value;
    save();
    count();
  });

  const selectedText = () => {
    const selection = getSelection();
    if (!selection || selection.isCollapsed) return "";
    const anchor = selection.anchorNode?.parentElement;
    if (anchor?.closest("[data-pi-feedback], pi-form, input, textarea")) return "";
    return selection.toString().trim();
  };
  document.addEventListener("mouseup", (event) => {
    if (event.target === quoteButton) return;
    setTimeout(() => {
      const text = selectedText();
      if (!text) return void (quoteButton.hidden = true);
      const rect = getSelection().getRangeAt(0).getBoundingClientRect();
      quoteButton.style.left = `${Math.max(8, Math.min(rect.right - 40, innerWidth - 90))}px`;
      quoteButton.style.top = `${Math.max(8, rect.bottom + 8)}px`;
      quoteButton.hidden = false;
    });
  });
  quoteButton.addEventListener("mousedown", (event) => event.preventDefault());
  quoteButton.addEventListener("click", () => {
    const text = selectedText();
    quoteButton.hidden = true;
    if (!text) return;
    state.items.push({ quote: text, comment: "" });
    getSelection().removeAllRanges();
    save();
    draw();
    open(true);
    list.lastElementChild?.querySelector("textarea")?.focus();
  });
  document.addEventListener("scroll", () => (quoteButton.hidden = true), { passive: true });

  send.addEventListener("click", async () => {
    const items = state.items.filter((item) => item.quote || item.comment.trim());
    if (items.length === 0 && !state.overall.trim()) return void (status.textContent = words.empty);
    const fields = [["pi-kind", "feedback"], ["page", document.title || location.pathname.split("/").pop()]];
    for (const item of items) fields.push(["quote", item.quote], ["comment", item.comment.trim()]);
    if (state.overall.trim()) fields.push(["overall", state.overall.trim()]);
    send.disabled = true;
    status.textContent = words.sending;
    const shown = held();
    try {
      await window.piDocReview.send(fields);
      state.items = [];
      state.overall = "";
      overall.value = "";
      save();
      draw();
      status.textContent = words.sent;
    } catch (error) {
      status.textContent = words.notSent + error.message;
    } finally {
      await shown;
      send.disabled = false;
    }
  });
  draw();
}

reviewViewer();
zoomImages();
// A page shown in a review item's frame leaves the feedback panel to the page around it.
if (window.piDocReview && window === window.top) feedbackPanel();
