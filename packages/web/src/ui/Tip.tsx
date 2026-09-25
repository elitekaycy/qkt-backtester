import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactElement } from "react";

interface Props { label: string; kbd?: string; side?: "right" | "bottom" | "top" | "left"; children: ReactElement<Record<string, unknown>> }

/**
 * Tooltip that follows the accessibility rules: shown on hover after a short delay and immediately on keyboard focus,
 * dismissed with Escape, linked to its trigger with aria-describedby, and never the only place a label lives.
 */
export function Tip({ label, kbd, side = "bottom", children }: Props) {
  const id = useId();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const el = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const show = (delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.current?.getBoundingClientRect();
      if (!r) return;
      const gap = 8;
      setPos(side === "right" ? { x: r.right + gap, y: r.top + r.height / 2 } : side === "left" ? { x: r.left - gap, y: r.top + r.height / 2 }
        : side === "top" ? { x: r.left + r.width / 2, y: r.top - gap } : { x: r.left + r.width / 2, y: r.bottom + gap });
    }, delay);
  };
  const hide = () => { clearTimeout(timer.current); setPos(null); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!pos) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [pos]);

  if (!isValidElement(children)) return children;
  // React 19 passes `ref` as a prop; forward it so a caller's own ref (e.g. a popover anchor) keeps working
  const own = (children.props as { ref?: React.Ref<HTMLElement> }).ref;
  const child = cloneElement(children, {
    ref: (n: HTMLElement | null) => {
      el.current = n;
      if (typeof own === "function") own(n); else if (own) (own as React.MutableRefObject<HTMLElement | null>).current = n;
    },
    onMouseEnter: (e: unknown) => { show(450); (children.props.onMouseEnter as ((e: unknown) => void) | undefined)?.(e); },
    onMouseLeave: (e: unknown) => { hide(); (children.props.onMouseLeave as ((e: unknown) => void) | undefined)?.(e); },
    onFocus: (e: React.FocusEvent) => { if ((e.target as HTMLElement).matches?.(":focus-visible")) show(0); (children.props.onFocus as ((e: unknown) => void) | undefined)?.(e); },
    onBlur: (e: unknown) => { hide(); (children.props.onBlur as ((e: unknown) => void) | undefined)?.(e); },
    onPointerDown: (e: unknown) => { hide(); (children.props.onPointerDown as ((e: unknown) => void) | undefined)?.(e); },
    "aria-describedby": pos ? id : undefined,
  });
  const tf = side === "right" ? "translate(0,-50%)" : side === "left" ? "translate(-100%,-50%)" : side === "top" ? "translate(-50%,-100%)" : "translate(-50%,0)";
  return (
    <>
      {child}
      {pos && <span id={id} role="tooltip" className="tip" style={{ left: pos.x, top: pos.y, transform: tf }}>{label}{kbd && <span className="kbd">{kbd}</span>}</span>}
    </>
  );
}
