import { useUi, type Pane } from "../state/ui.js";
import { Tip } from "./Tip.js";
import { Maximize2, Minimize2, RotateCcw, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, PanelBottomClose, PanelBottomOpen, PanelTopClose, PanelTopOpen } from "./icons.js";

const NAMES: Record<Pane, string> = { sidebar: "sidebar", editor: "editor", chart: "chart", dock: "output panel" };

/**
 * The same three controls on every pane header: collapse/expand, maximize/restore, reset size.
 * They are idempotent actions on the ui store, so a double click can never leave a pane half-toggled.
 * `edge` tells the collapse chevron which way the pane folds (left sidebar folds left, bottom dock folds down, ...).
 */
export function PaneControls({ pane, edge, size = "sm" }: { pane: Pane; edge?: "left" | "right" | "up" | "down"; size?: "sm" }) {
  const ui = useUi();
  const name = NAMES[pane];
  const collapsed = pane === "sidebar" ? !ui.section : pane === "dock" ? !ui.dockOpen : ui.collapsed[pane];
  const maxed = ui.maxed === pane;
  const dir = edge ?? (pane === "sidebar" ? "left" : pane === "dock" ? "down" : pane === "chart" ? (ui.layout === "row" ? "right" : "down") : "up");
  // panel icons (not bare chevrons) so the collapse control is never mistaken for previous/next
  const Fold = dir === "left" ? (collapsed ? PanelLeftOpen : PanelLeftClose) : dir === "right" ? (collapsed ? PanelRightOpen : PanelRightClose) : dir === "down" ? (collapsed ? PanelBottomOpen : PanelBottomClose) : (collapsed ? PanelTopOpen : PanelTopClose);
  return (
    // shown on hover or keyboard focus of the pane; always shown while collapsed or full screen, so the way back is visible
    <span className={`pane-controls${collapsed || maxed ? " pinned" : ""}`} role="group" aria-label={`${name} controls`}>
      <Tip label={collapsed ? `Expand ${name}` : `Collapse ${name}`} side="bottom">
        <button className={`btn ghost icon ${size}`} aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`} aria-expanded={!collapsed} onClick={() => ui.toggleCollapse(pane)}><Fold size={14} /></button>
      </Tip>
      <Tip label={maxed ? "Restore size (Esc)" : `Full screen ${name}`} side="bottom">
        <button className={`btn ghost icon ${size}`} aria-label={maxed ? `Restore ${name}` : `Full screen ${name}`} aria-pressed={maxed} onClick={() => ui.toggleMax(pane)}>{maxed ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
      </Tip>
      <Tip label={`Reset ${name} size`} side="bottom">
        <button className={`btn ghost icon ${size}`} aria-label={`Reset ${name} size`} onClick={() => ui.resetPane(pane)}><RotateCcw size={13} /></button>
      </Tip>
    </span>
  );
}
