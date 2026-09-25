import { useRef, useState } from "react";

interface Props {
  /** `v` is a vertical bar you drag left/right; `h` is a horizontal bar you drag up/down. */
  dir: "v" | "h"; value: number; min: number; max: number; onChange(v: number): void; onReset?(): void;
  /** true when growing the pane means dragging toward the start (left/up) of the axis, e.g. a right-hand or bottom pane. */
  invert?: boolean; label: string;
}

/**
 * Resize handle. Pointer-captured drag, arrow keys (Shift = larger steps), Home/End for the limits, double-click to reset.
 * It is a focusable ARIA separator so keyboard and screen-reader users can resize too.
 */
export function Splitter({ dir, value, min, max, onChange, onReset, invert, label }: Props) {
  const [drag, setDrag] = useState(false);
  const start = useRef({ p: 0, v: 0 });
  const hi = Math.max(min, max);
  const clamp = (n: number) => Math.min(hi, Math.max(min, Math.round(n)));
  const end = (e: React.PointerEvent) => { try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* capture already gone (double tap, cancel) */ } setDrag(false); document.body.classList.remove("resizing", "v", "h"); };
  const axis = (e: { clientX: number; clientY: number }) => (dir === "v" ? e.clientX : e.clientY);

  return (
    <div
      className={`splitter ${dir}${drag ? " drag" : ""}`} role="separator" tabIndex={0} aria-label={label} aria-orientation={dir === "v" ? "vertical" : "horizontal"}
      aria-valuenow={value} aria-valuemin={min} aria-valuemax={hi}
      onPointerDown={(e) => {
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic or already-ended pointer */ }
        start.current = { p: axis(e), v: value };
        setDrag(true);
        document.body.classList.add("resizing", dir);
      }}
      onPointerMove={(e) => { if (drag) onChange(clamp(start.current.v + (axis(e) - start.current.p) * (invert ? -1 : 1))); }}
      onPointerUp={end} onPointerCancel={end}
      onDoubleClick={() => onReset?.()}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 48 : 12;
        const grow = dir === "v" ? (invert ? "ArrowLeft" : "ArrowRight") : (invert ? "ArrowUp" : "ArrowDown");
        const shrink = dir === "v" ? (invert ? "ArrowRight" : "ArrowLeft") : (invert ? "ArrowDown" : "ArrowUp");
        if (e.key === grow) { e.preventDefault(); onChange(clamp(value + step)); }
        else if (e.key === shrink) { e.preventDefault(); onChange(clamp(value - step)); }
        else if (e.key === "Home") { e.preventDefault(); onChange(min); }
        else if (e.key === "End") { e.preventDefault(); onChange(hi); }
      }}
    />
  );
}
