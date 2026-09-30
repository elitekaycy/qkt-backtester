import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { provideQktLanguageForTests } from "../src/qkt-lang.js";
import { haveQkt, qktBin } from "./helpers.js";

// The CI unit job has no qkt binary: give the studio the language from the fixture captured from a real one, so the
// tests that only exercise routes boot. With a binary (QKT_BIN), the real language is loaded and this does nothing.
if (!haveQkt) {
  const doc = JSON.parse(readFileSync(fileURLToPath(new URL("../../core/test/fixtures/qkt-vocabulary.json", import.meta.url)), "utf8"));
  provideQktLanguageForTests(qktBin, doc);
}
