// The `pi-kit` module a React page imports: the page kit as React components, and `send` to hand the
// agent anything the page collects. The components render the kit's final markup themselves and mark
// it `data-static`, so kit.js leaves the DOM React owns alone.

import { Children, createContext, isValidElement, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

export type Tone = "note" | "ok" | "warn" | "risk";

declare global {
  interface Window {
    piDocReview?: { base: string; send: (fields: [string, string][] | Record<string, string>) => Promise<void> };
  }
}

/** Sends fields to the agent as one message, like a submitted form. */
export function send(fields: [string, string][] | Record<string, string>): Promise<void> {
  if (!window.piDocReview) return Promise.reject(new Error("this page was not opened by show_doc"));
  return window.piDocReview.send(Array.isArray(fields) ? fields : Object.entries(fields));
}

/** The kit's own words follow the page's language, else the browser's, as kit.js does. */
const inChinese = (): boolean => /^zh/i.test(document.documentElement.lang || navigator.language);
const kitWords = () =>
  inChinese()
    ? { send: "送給 agent", sending: "傳送中…", resend: "已送給 agent。改了可以再送一次。", notSent: "沒送出：", unanswered: "還沒回答：", empty: "還沒有內容。", other: "其他（自行填寫）", note: "回饋（留白代表沒意見）", pick: "選這個" }
    : { send: "Send to agent", sending: "Sending…", resend: "Sent to the agent. Change anything and send again to update it.", notSent: "Not sent: ", unanswered: "Unanswered: ", empty: "Nothing to send yet.", other: "Other (type your own)", note: "Feedback (leave blank for none)", pick: "Pick this" };

const render = async (kind: "markdown" | "mermaid", source: string): Promise<string> => {
  if (!window.piDocReview) throw new Error("this page was not opened by show_doc");
  const response = await fetch(`${window.piDocReview.base}/render/${kind}`, { method: "POST", body: source });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `HTTP ${response.status}`);
  return text;
};

const childText = (children: ReactNode): string => Children.toArray(children).filter((child) => typeof child === "string" || typeof child === "number").join("");

/** HTML the page server rendered, or the error that stopped it. */
function Rendered({ kind, source }: { kind: "markdown" | "mermaid"; source: string }) {
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    render(kind, source).then(
      (text) => live && setHtml(text),
      (failure: Error) => live && setError(failure.message),
    );
    return () => {
      live = false;
    };
  }, [kind, source]);
  if (error) return <Callout tone="risk" title={`This ${kind} could not be rendered`}>{error}</Callout>;
  // The server's HTML carries its own wrapper: a diagram comes inside its figure.
  return <div dangerouslySetInnerHTML={{ __html: html ?? "" }} />;
}

/** Markdown rendered by the page server, with the same blocks a Markdown page has. */
export function Markdown({ children }: { children: ReactNode }) {
  return <Rendered kind="markdown" source={childText(children)} />;
}

/** A mermaid diagram drawn by the page server. */
export function Mermaid({ children }: { children: ReactNode }) {
  return <Rendered kind="mermaid" source={childText(children)} />;
}

const Title = ({ children }: { children?: ReactNode }) => (children ? <span className="pi-title">{children}</span> : null);

export function Callout({ tone = "note", title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <pi-callout data-static="" tone={tone}>
      <Title>{title}</Title>
      {children}
    </pi-callout>
  );
}

export function Grid({ children }: { children?: ReactNode }) {
  return <pi-grid>{children}</pi-grid>;
}

export function Card({ tone, title, children }: { tone?: Tone; title?: ReactNode; children?: ReactNode }) {
  return (
    <pi-card data-static="" tone={tone}>
      <Title>{title}</Title>
      {children}
    </pi-card>
  );
}

export function Badge({ tone, children }: { tone?: Tone; children?: ReactNode }) {
  return <pi-badge tone={tone}>{children}</pi-badge>;
}

export function Options({ children }: { children?: ReactNode }) {
  return <pi-options>{children}</pi-options>;
}

export function Option({ title, recommended, pros = [], cons = [], children }: { title?: ReactNode; recommended?: boolean | string; pros?: ReactNode[]; cons?: ReactNode[]; children?: ReactNode }) {
  return (
    <pi-option data-static="" recommended={recommended ? "" : undefined}>
      <span className="pi-title">
        {title}
        {recommended ? (
          <>
            {" "}
            <Badge tone="ok">{recommended === true ? "Recommended" : recommended}</Badge>
          </>
        ) : null}
      </span>
      {children}
      {pros.length > 0 && (
        <ul className="pi-pros">
          {pros.map((pro, index) => (
            <li key={index}>{pro}</li>
          ))}
        </ul>
      )}
      {cons.length > 0 && (
        <ul className="pi-cons">
          {cons.map((con, index) => (
            <li key={index}>{con}</li>
          ))}
        </ul>
      )}
    </pi-option>
  );
}

interface Asked {
  label: string;
  required: boolean;
  answer: () => string;
}
const FormContext = createContext<Map<string, Asked> | undefined>(undefined);

/** Questions whose answers go to the agent as one message when the user sends the form. */
export function Form({ title, submit, onSent, children }: { title?: string; submit?: string; onSent?: () => void; children?: ReactNode }) {
  const asked = useRef(new Map<string, Asked>()).current;
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const sendForm = async () => {
    const missing = [...asked.values()].filter((question) => question.required && !question.answer());
    const words = kitWords();
    if (missing.length > 0) return setStatus(`${words.unanswered}${missing.map((question) => question.label).join(", ")}`);
    const fields: [string, string][] = [...asked].map(([name, question]) => [name, question.answer() || "(no answer)"]);
    if (title) fields.unshift(["form", title]);
    setBusy(true);
    setStatus(words.sending);
    // The button stays disabled at least a second so the user sees the send happen.
    const shown = new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await send(fields);
      setStatus(words.resend);
      onSent?.();
    } catch (error) {
      setStatus(`${words.notSent}${(error as Error).message}`);
    } finally {
      // The form stays usable: a changed answer can be sent again.
      await shown;
      setBusy(false);
    }
  };
  return (
    <FormContext.Provider value={asked}>
      <pi-form data-static="">
        <Title>{title}</Title>
        {children}
        <div>
          <button type="button" disabled={busy} onClick={sendForm}>
            {submit ?? kitWords().send}
          </button>
          <span className="pi-status">{status}</span>
        </div>
      </pi-form>
    </FormContext.Provider>
  );
}

/** One answer for a `<Question>`; it renders nothing itself. */
export function Choice(_props: { value?: string; note?: string; recommended?: boolean | string; children?: ReactNode }) {
  return null;
}

type ChoiceProps = Parameters<typeof Choice>[0];

/** A choice question ends with a box for the user's own answer, labelled by `other`; `other={false}` drops it. */
export function Question({ name, label, hint, required = false, type, other, children }: { name?: string; label: string; hint?: string; required?: boolean; type?: "single" | "multi" | "text"; other?: string | false; children?: ReactNode }) {
  const asked = useContext(FormContext);
  const id = useId();
  const choices = Children.toArray(children).filter((child) => isValidElement(child) && child.type === Choice).map((child) => (child as { props: ChoiceProps }).props);
  const kind = type ?? (choices.length > 0 ? "single" : "text");
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [otherText, setOtherText] = useState("");
  const answer = (): string => {
    if (kind === "text") return text.trim();
    return picked.map((value) => (value === "\0other" ? otherText.trim() : value)).filter(Boolean).join(", ");
  };
  const key = name ?? label;
  if (asked) asked.set(key, { label, required, answer });
  useEffect(() => () => void asked?.delete(key), [asked, key]);
  const pick = (value: string, on: boolean) => setPicked((current) => (kind === "multi" ? (on ? [...current, value] : current.filter((item) => item !== value)) : [value]));
  const input = kind === "multi" ? "checkbox" : "radio";
  return (
    <pi-question data-static="" required={required ? "" : undefined}>
      <span className="pi-title">{label}</span>
      {hint && <span className="pi-hint">{hint}</span>}
      {kind === "text" ? (
        <textarea value={text} onChange={(event) => setText(event.target.value)} />
      ) : (
        <>
          {choices.map((choice, index) => {
            const value = choice.value ?? childText(choice.children);
            return (
              <label className="pi-choice" key={index}>
                <input type={input} name={id} checked={picked.includes(value)} onChange={(event) => pick(value, event.target.checked)} />
                <span>
                  {choice.children}
                  {choice.recommended ? <Badge tone="ok">{choice.recommended === true ? "Recommended" : choice.recommended}</Badge> : null}
                  {choice.note && <small>{choice.note}</small>}
                </span>
              </label>
            );
          })}
          {other !== false && other !== "false" && (
            <label className="pi-choice">
              <input type={input} name={id} checked={picked.includes("\0other")} onChange={(event) => pick("\0other", event.target.checked)} />
              <input
                type="text"
                placeholder={other || kitWords().other}
                value={otherText}
                onChange={(event) => {
                  setOtherText(event.target.value);
                  if (event.target.value && !picked.includes("\0other")) pick("\0other", true);
                }}
              />
            </label>
          )}
        </>
      )}
    </pi-question>
  );
}

/** One thing under review in a `<Review>`: an image, an HTML prototype in a frame, or its children; it renders nothing itself. */
export function Item(_props: { name?: string; label?: string; image?: string; page?: string; height?: number; children?: ReactNode }) {
  return null;
}

type ItemProps = Parameters<typeof Item>[0];

/** A prototype's URL with `pi-bare`, so the page server shows it as written, without the kit. */
const bare = (page: string): string => {
  const url = new URL(page, location.href);
  url.searchParams.set("pi-bare", "");
  return url.href;
};

/**
 * Item names: an item's own name, else the next letter no item claims (A, B, C…, then numbers);
 * a repeated name gets a number, so every item keeps its own pick value and comment.
 */
const itemNames = (names: string[]): string[] => {
  const claimed = new Set(names.filter(Boolean));
  const taken = new Set<string>();
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

const itemName = (name: string, label?: string): string => (label ? `${name} (${label})` : name);

/**
 * Items the user comments on one by one, a blank comment meaning no feedback; with `pick` (true, or
 * the choice's label) the user also picks a favourite, for an A/B test. Items are named A, B, C…
 * unless they carry a name. Drafts survive the reload an agent's edit causes, kept in sessionStorage.
 */
export function Review({ title, submit, pick, columns, children }: { title?: string; submit?: string; pick?: boolean | string; columns?: number; children?: ReactNode }) {
  const words = kitWords();
  // As in kit.js, a pick attribute turns picking on even when empty.
  const picking = pick !== undefined && pick !== false;
  const props = Children.toArray(children)
    .filter((child) => isValidElement(child) && child.type === Item)
    .map((child) => (child as { props: ItemProps }).props);
  const names = itemNames(props.map((item) => item.name ?? ""));
  const items = props.map((item, index) => ({ ...item, value: names[index] }));
  // useId follows the review's place in the page, so two reviews never share a draft.
  const key = `pi-review:${location.pathname}:${useId()}:${title ?? ""}`;
  const [saved, setSaved] = useState<{ picked: string; comments: Record<string, string> }>(() => JSON.parse(sessionStorage.getItem(key) ?? "null") ?? { picked: "", comments: {} });
  useEffect(() => sessionStorage.setItem(key, JSON.stringify(saved)), [key, saved]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const group = useId();
  const sendReview = async () => {
    const comment = (value: string) => (saved.comments[value] ?? "").trim();
    const picked = items.find((item) => item.value === saved.picked);
    const commented = items.filter((item) => comment(item.value));
    if (!picked && commented.length === 0) return setStatus(words.empty);
    const fields: [string, string][] = [["pi-kind", "review"], ["title", title || document.title]];
    if (picked) fields.push(["picked", itemName(picked.value, picked.label)]);
    for (const item of commented) fields.push(["item", itemName(item.value, item.label)], ["comment", comment(item.value)]);
    const silent = items.filter((item) => !comment(item.value)).map((item) => itemName(item.value, item.label));
    if (silent.length > 0) fields.push(["silent", silent.join(", ")]);
    setBusy(true);
    setStatus(words.sending);
    // The button stays disabled at least a second so the user sees the send happen.
    const shown = new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      await send(fields);
      setStatus(words.resend);
    } catch (error) {
      setStatus(`${words.notSent}${(error as Error).message}`);
    } finally {
      await shown;
      setBusy(false);
    }
  };
  return (
    <pi-review data-static="">
      <Title>{title}</Title>
      <div className="pi-review-items" data-columns={columns ? "" : undefined} style={columns ? ({ "--pi-columns": String(columns) } as CSSProperties) : undefined}>
        {items.map((item) => (
          <pi-item key={item.value}>
            <div className="pi-item-head">
              <span className="pi-title">{itemName(item.value, item.label)}</span>
              {picking ? (
                <label className="pi-pick">
                  <input type="radio" name={group} checked={saved.picked === item.value} onChange={() => setSaved((current) => ({ ...current, picked: item.value }))} />
                  {pick === true || pick === "" ? words.pick : pick}
                </label>
              ) : null}
            </div>
            <div className="pi-item-body">
              {item.image && <img src={item.image} alt={itemName(item.value, item.label)} />}
              {item.page && (
                <div className="pi-frame" style={{ height: `${item.height || 480}px` }}>
                  <iframe src={bare(item.page)} title={itemName(item.value, item.label)} />
                </div>
              )}
              {item.children}
            </div>
            <textarea
              placeholder={words.note}
              value={saved.comments[item.value] ?? ""}
              onChange={(event) => {
                const text = event.target.value;
                setSaved((current) => ({ ...current, comments: { ...current.comments, [item.value]: text } }));
              }}
            />
          </pi-item>
        ))}
      </div>
      <div>
        <button type="button" disabled={busy} onClick={sendReview}>
          {submit ?? words.send}
        </button>
        <span className="pi-status">{status}</span>
      </div>
    </pi-review>
  );
}
