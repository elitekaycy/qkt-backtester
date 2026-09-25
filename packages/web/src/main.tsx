import { createRoot } from "react-dom/client";
import { App } from "./shell/App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);
