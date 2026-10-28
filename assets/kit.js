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

/** An element that builds its content once, when it is first attached. */
class Built extends HTMLElement {
  connectedCallback() {
    if (this.built) return;
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
 * value note recommended>Label</pi-choice> children. Without choices it is a text question.
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
      if (other !== null) {
        const box = make("input", { type: "text", placeholder: other || "Other", className: "pi-other" });
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

/** <pi-form title submit="Send">: gathers its <pi-question> answers and sends them to the agent. */
class Form extends Built {
  build() {
    this.titled();
    const status = make("span", { className: "pi-status" });
    const button = make("button", { type: "button", textContent: this.getAttribute("submit") ?? "Send to agent" });
    button.addEventListener("click", async () => {
      const asked = [...this.querySelectorAll("pi-question")];
      const missing = asked.filter((question) => question.hasAttribute("required") && !question.answer);
      if (missing.length > 0) {
        status.textContent = `Unanswered: ${missing.map((question) => question.getAttribute("label") ?? question.name).join(", ")}`;
        return;
      }
      const fields = asked.map((question) => [question.name, question.answer || "(no answer)"]);
      const title = this.querySelector(":scope > .pi-title")?.textContent;
      if (title) fields.unshift(["form", title]);
      button.disabled = true;
      status.textContent = "Sending…";
      try {
        if (!window.piDocReview) throw new Error("this page was not opened by show_doc");
        await window.piDocReview.send(fields);
        status.textContent = "Sent to the agent.";
      } catch (error) {
        button.disabled = false;
        status.textContent = `Not sent: ${error.message}`;
      }
    });
    this.append(make("div", {}, button, status));
  }
}

for (const [tag, element] of [
  ["pi-callout", Callout],
  ["pi-card", Card],
  ["pi-option", Option],
  ["pi-question", Question],
  ["pi-form", Form],
]) {
  if (!customElements.get(tag)) customElements.define(tag, element);
}
