import { createRoot } from "react-dom/client";
import { App } from "./shell/App.js";
import "./theme.css";
import "./ui.css";
import "./app.css";
import "./shell.css";
import "./chart.css";
import "./journal.css";
import "./data.css";

createRoot(document.getElementById("root")!).render(<App />);
