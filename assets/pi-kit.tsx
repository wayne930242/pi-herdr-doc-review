// The `pi-kit` module a React page imports: the page kit as React components, and `send` to hand the
// agent anything the page collects. The components render the kit's final markup themselves and mark
// it `data-static`, so kit.js leaves the DOM React owns alone.

import { Children, createContext, isValidElement, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

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
export function Form({ title, submit = "Send to agent", onSent, children }: { title?: string; submit?: string; onSent?: () => void; children?: ReactNode }) {
  const asked = useRef(new Map<string, Asked>()).current;
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const sendForm = async () => {
    const missing = [...asked.values()].filter((question) => question.required && !question.answer());
    if (missing.length > 0) return setStatus(`Unanswered: ${missing.map((question) => question.label).join(", ")}`);
    const fields: [string, string][] = [...asked].map(([name, question]) => [name, question.answer() || "(no answer)"]);
    if (title) fields.unshift(["form", title]);
    setBusy(true);
    setStatus("Sending…");
    try {
      await send(fields);
      setStatus("Sent to the agent.");
      onSent?.();
    } catch (error) {
      setBusy(false);
      setStatus(`Not sent: ${(error as Error).message}`);
    }
  };
  return (
    <FormContext.Provider value={asked}>
      <pi-form data-static="">
        <Title>{title}</Title>
        {children}
        <div>
          <button type="button" disabled={busy} onClick={sendForm}>
            {submit}
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

export function Question({ name, label, hint, required = false, type, other, children }: { name?: string; label: string; hint?: string; required?: boolean; type?: "single" | "multi" | "text"; other?: string; children?: ReactNode }) {
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
          {other !== undefined && (
            <label className="pi-choice">
              <input type={input} name={id} checked={picked.includes("\0other")} onChange={(event) => pick("\0other", event.target.checked)} />
              <input
                type="text"
                placeholder={other || "Other"}
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
