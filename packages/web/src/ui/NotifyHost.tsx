// Draws the toasts `notify` sends (notify.ts): sonner positions and stacks them unstyled, notify.css draws them with the
// studio's own tokens. Mounted once in the shell.
import { Toaster } from "sonner";
import { CircleCheck, CircleX, Info, TriangleAlert, X } from "./icons.js";
import { MAX_VISIBLE } from "./notify.js";
import "./notify.css";

const ICONS = {
  success: <CircleCheck size={16} aria-hidden="true" />,
  info: <Info size={16} aria-hidden="true" />,
  warning: <TriangleAlert size={16} aria-hidden="true" />,
  error: <CircleX size={16} aria-hidden="true" />,
  close: <X size={12} aria-hidden="true" />,
};

const CLASSES = {
  toast: "qn", title: "qn-title", description: "qn-desc", content: "qn-content", icon: "qn-icon",
  actionButton: "qn-action", closeButton: "qn-close",
  success: "qn-ok", info: "qn-info", warning: "qn-warn", error: "qn-error",
};

/** Mount once. Bottom-right above the status bar; every toast closable; they stack and fan out on hover. */
export function NotifyHost({ theme }: { theme: "dark" | "light" }) {
  return (
    <Toaster
      className="qn-host"
      position="bottom-right"
      theme={theme}
      closeButton
      visibleToasts={MAX_VISIBLE}
      gap={8}
      style={{ "--width": "380px", zIndex: "var(--z-toast)" } as React.CSSProperties}
      offset={{ bottom: "calc(var(--status-h) + 12px)", right: 16 }}
      mobileOffset={{ bottom: "calc(var(--status-h) + 8px)" }}
      icons={ICONS}
      containerAriaLabel="Notifications"
      toastOptions={{ unstyled: true, classNames: CLASSES, closeButtonAriaLabel: "Close notification" }}
    />
  );
}
