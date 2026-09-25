import puppeteer from "puppeteer-core";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text().slice(0, 200)); });
await page.goto("http://127.0.0.1:5199/", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 2500));
const probe = await page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__spike, dock: undefined })));
console.log(JSON.stringify(probe, null, 1));
// collapsibility: hide/show a dockview group and check layout adapts
const collapse = await page.evaluate(async () => {
  const api = window.__dock; const before = api.panels.map((p) => p.api.isVisible);
  api.getPanel("results").group.api.setSize({ width: 0 });
  api.getPanel("terminal").api.setActive();
  const g = api.getPanel("chart").group;
  const w0 = g.api.width; g.api.setSize({ width: Math.round(w0 * 1.5) });
  await new Promise((r) => setTimeout(r, 300));
  return { chartWidthBefore: w0, chartWidthAfter: g.api.width, resultsWidth: api.getPanel("results").group.api.width };
});
console.log("layout resize:", JSON.stringify(collapse));
await page.screenshot({ path: "/tmp/spike.png" });
console.log("errors:", JSON.stringify(errs));
await browser.close();
