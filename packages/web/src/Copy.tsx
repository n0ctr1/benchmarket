import { useState } from "react";

/** A command or config block that copies itself to the clipboard when clicked. */
export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard blocked: select the text so the viewer can copy it by hand.
      const sel = window.getSelection();
      const el = document.activeElement?.querySelector?.("code");
      if (sel && el) sel.selectAllChildren(el);
    }
    setDone(true);
    setTimeout(() => setDone(false), 1600);
  };
  return (
    <button type="button" className="cmd copy" onClick={copy} aria-label={label ? `Copy ${label}` : "Copy to clipboard"} title="Click to copy">
      <code>{text}</code>
      <span className="copy-tag" aria-live="polite">
        {done ? "copied" : "copy"}
      </span>
    </button>
  );
}
