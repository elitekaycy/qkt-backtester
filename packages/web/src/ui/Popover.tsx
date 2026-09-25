import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

interface Props {
  open: boolean; onClose(): void; anchor: RefObject<HTMLElement | null>;
  align?: "start" | "end"; width?: number; label: string; children: ReactNode; className?: string;
}

/**
 * Anchored panel: closes on Escape or an outside press and returns focus to the trigger, moves focus inside on open,
 * flips above the anchor when there is no room, and stays inside the viewport. Rendered in a portal so no parent clips it.
 */
export function Popover({ open, onClose, anchor, align = "start", width, label, children, className = "" }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // keeps the open effect from re-running (and re-focusing the first control) on every parent render
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open || !anchor.current || !ref.current) return;
    const a = anchor.current.getBoundingClientRect(), p = ref.current.getBoundingClientRect();
    const w = width ?? p.width, vw = window.innerWidth, vh = window.innerHeight;
    let left = align === "end" ? a.right - w : a.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    let top = a.bottom + 6;
    if (top + p.height > vh - 8 && a.top - 6 - p.height > 8) top = a.top - 6 - p.height;
    setStyle({ left, top: Math.max(8, top), width, visibility: "visible" });
  }, [open, anchor, align, width, children]);

  useEffect(() => {
    if (!open) return;
    const trigger = anchor.current;
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !trigger?.contains(e.target as Node)) closeRef.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); trigger?.focus(); } };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    const t = setTimeout(() => ref.current?.querySelector<HTMLElement>("[data-autofocus], input, select, button, [tabindex='0']")?.focus({ preventScroll: true }), 30);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key, true); clearTimeout(t); };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(<div ref={ref} id={id} role="dialog" aria-label={label} className={`popover ${className}`} style={style}>{children}</div>, document.body);
}

export interface MenuEntry { id: string; label: string; hint?: string; icon?: ReactNode; onSelect(): void; disabled?: boolean; separatorBefore?: boolean; heading?: string }

/** Keyboard-navigable menu: arrows, Home/End, type-ahead is not needed for these short lists. */
export function Menu({ items, onDone }: { items: MenuEntry[]; onDone(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (dir: 1 | -1 | "first" | "last") => {
    const els = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button.menu-item:not(:disabled)") ?? [])];
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    els[dir === "first" ? 0 : dir === "last" ? els.length - 1 : (i + dir + els.length) % els.length]?.focus();
  };
  return (
    <div ref={ref} role="menu" className="menu" onKeyDown={(e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); } else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (e.key === "Home") { e.preventDefault(); move("first"); } else if (e.key === "End") { e.preventDefault(); move("last"); }
    }}>
      {items.map((m) => (
        <div key={m.id}>
          {m.separatorBefore && <div className="menu-sep" role="separator" />}
          {m.heading && <div className="menu-label">{m.heading}</div>}
          <button role="menuitem" className="menu-item" disabled={m.disabled} onClick={() => { onDone(); m.onSelect(); }}>
            {m.icon && <span className="ico">{m.icon}</span>}<span className="grow">{m.label}</span>{m.hint && <span className="kbd">{m.hint}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
