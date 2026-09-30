import { beforeEach, describe, expect, it } from "vitest";
import { chatDockHeight, useUi } from "./ui.js";

const ui = () => useUi.getState();
beforeEach(() => ui().reset());

describe("asking for a pane leaves a maximized one", () => {
  it("a rail icon with the chart maximized shows that section instead of doing nothing", () => {
    ui().set({ section: "files" }); ui().maximize("chart");
    ui().toggleSection("data");
    expect(ui().maxed).toBeNull();
    expect(ui().section).toBe("data");
  });
  it("the icon of the section already chosen brings the hidden sidebar back rather than closing it", () => {
    ui().set({ section: "files" }); ui().maximize("editor");
    ui().toggleSection("files");
    expect([ui().maxed, ui().section]).toEqual([null, "files"]);
  });
  it("without a maximized pane the icon still toggles the sidebar", () => {
    ui().set({ section: "files" });
    ui().toggleSection("files");
    expect(ui().section).toBeNull();
  });
  it("a maximized sidebar: its own icons switch sections and keep it maximized", () => {
    ui().set({ section: "files" }); ui().maximize("sidebar");
    ui().toggleSection("runs");
    expect([ui().maxed, ui().section]).toEqual(["sidebar", "runs"]);
  });
  it("shortcuts, the palette and 'Open Data' use showSection", () => {
    ui().maximize("dock");
    ui().showSection("data");
    expect([ui().maxed, ui().section]).toEqual([null, "data"]);
  });
  it("opening a dock tab leaves a maximized chart, opens the dock and closes the journal", () => {
    ui().maximize("chart"); ui().set({ dockOpen: false, journalOpen: true });
    ui().showDock("terminal");
    expect([ui().maxed, ui().dockOpen, ui().dockTab, ui().journalOpen]).toEqual([null, true, "terminal", false]);
  });
  it("reveal un-collapses the pane and keeps a maximize of that same pane", () => {
    ui().set({ collapsed: { editor: false, chart: true } }); ui().maximize("editor");
    ui().reveal("chart");
    expect([ui().maxed, ui().collapsed.chart]).toEqual([null, false]);
    ui().maximize("chart");
    ui().reveal("chart");
    expect(ui().maxed).toBe("chart");
  });
  it("the journal opens over the workbench even when the sidebar was maximized", () => {
    ui().maximize("sidebar");
    ui().openJournal("trades");
    expect([ui().maxed, ui().journalOpen, ui().journalSection]).toEqual([null, true, "trades"]);
  });
});

describe("the Chat tab needs room for a conversation", () => {
  it("opening it raises a short dock to 420px, as far as the window allows", () => {
    expect(chatDockHeight(260, 1000)).toBe(420);
    expect(chatDockHeight(260, 600)).toBe(320);
  });
  it("never shrinks a taller dock", () => {
    expect(chatDockHeight(500, 1000)).toBe(500);
    expect(chatDockHeight(300, 400)).toBe(300);
  });
  it("showDock('chat') applies it; other tabs leave the height alone", () => {
    ui().set({ dockH: 200 });
    ui().showDock("pipeline");
    expect(ui().dockH).toBe(200);
    ui().showDock("chat");
    expect(ui().dockH).toBe(420);
  });
});
