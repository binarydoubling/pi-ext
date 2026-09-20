import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { AskUserQuestionComponent, type TUILike } from "./component.ts";
import { normalizeInput, type Question, type Option, type Result } from "./schema.ts";

initTheme("dark", false);
const themeUrl = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
const { loadThemeFromPath } = await import(themeUrl.href);
// Golden ANSI must not depend on the calling terminal's color capabilities.
const theme = loadThemeFromPath(fileURLToPath(new URL("dark.json", themeUrl)), "truecolor");
const k = { enter: "\r", esc: "\x1b", left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", save: "\x13", cancel: "\x03", pageDown: "\x1b[6~", pageUp: "\x1b[5~", newline: "\x1b[13;2u" };
const choice = { id: "pick", header: "Pick", question: "Choose", options: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] };
type Explain = (q: Question, o: Option, signal: AbortSignal) => Promise<string>;
function setup(questions: unknown[] = [choice], explain?: Explain) {
  const results: Result[] = [];
  let renders = 0;
  const tui: TUILike = { requestRender: () => { renders++; }, terminal: { rows: 24, columns: 80 } };
  const ui = new AskUserQuestionComponent(normalizeInput({ questions }), tui, theme, result => results.push(result), explain);
  ui.focused = true;
  const press = (...inputs: string[]) => inputs.forEach(input => {
    const before = renders;
    ui.handleInput(input);
    if (!results.length) assert.ok(renders > before, "each input requests a render");
  });
  const view = (width = 80) => ui.render(width).map(stripVTControlCharacters).join("\n");
  const paste = (text: string) => press(`\x1b[200~${text}\x1b[201~`);
  return { ui, tui, results, press, view, paste, renders: () => renders };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("single question stays compact but requires review; navigation never confirms", () => {
  const h = setup([{ ...choice, default: "b" }]);
  assert.doesNotMatch(h.view(), /Submit|Draft:/);
  assert.match(h.view(), /> ✓ 2\. Beta/);
  h.press(k.right, k.enter);
  assert.equal(h.results.length, 0);
  assert.match(h.view(), /Confirm or explicitly skip/);
  h.press(k.left, k.enter);
  assert.equal(h.results.length, 0, "confirm advances to review without submitting");
  assert.match(h.view(), /Ready to submit/);
  assert.match(h.view(), /Press Enter to submit/);
  h.press(k.save);
  assert.equal(h.results[0].answers[0].value, "b");
  h.ui.abort(); h.ui.handleInput(k.enter);
  assert.equal(h.results.length, 1);
});

test("multi requires a selection and explicit confirmation; Other is additive", () => {
  const h = setup([{ ...choice, type: "multi" }]);
  h.press(k.enter);
  assert.match(h.view(), /Select a choice/);
  h.press(" ", k.down, " ", k.down, "\t"); h.paste("custom"); h.press(k.save);
  assert.match(h.view(), /\[✓\] 1\. Alpha/);
  assert.match(h.view(), /\[✓\] 2\. Beta/);
  assert.match(h.view(), /       "custom"/);
  h.press(k.right, k.enter);
  assert.equal(h.results.length, 0);
  h.press(k.left, k.enter, k.enter);
  assert.deepEqual(h.results[0].answers[0], { id: "pick", value: ["a", "b"], other: "custom", skipped: false });
});

test("optional fields need explicit skip and required fields cannot skip", () => {
  const h = setup([choice, { id: "extra", question: "Extra", type: "text", required: false }]);
  h.press("s"); assert.match(h.view(), /This question is required/);
  h.press(k.enter, k.right, k.enter); assert.equal(h.results.length, 0);
  h.press(k.left, "s", k.enter);
  assert.equal(h.results[0].answers[1].skipped, true);
  assert.equal(h.results[0].answers[1].value, null);
});

test("date, datetime and time validate locally before confirmation", () => {
  for (const [type, invalid, valid] of [["date", "2025-02-29", "2024-02-29"], ["datetime", "2024-02-29 24:00", "2024-02-29 23:59"], ["time", "9:00", "09:00"]]) {
    const h = setup([{ question: "When?", type }]);
    h.press(k.enter); h.paste(invalid); h.press(k.enter);
    assert.match(h.view(), /Enter a real/);
    h.press(k.esc, "e"); h.paste(valid); h.press(k.save, k.enter);
    assert.equal(h.results[0].answers[0].value, valid);
  }
});

test("expanded large pastes and multiline notes save in full", () => {
  const h = setup([{ question: "Text", type: "text" }]);
  const text = Array.from({ length: 16 }, (_, i) => `long line ${i}`).join("\n");
  h.press(k.enter); h.paste(text); assert.match(h.view(), /paste #/);
  h.press(k.save, k.left, "n"); h.paste("first"); h.press(k.newline); h.paste("second"); h.press(k.enter);
  h.press(k.right);
  assert.match(h.view(), /Ready to submit/, "notes do not invalidate a confirmed answer");
  h.press(k.enter);
  assert.equal(h.results[0].answers[0].value, text);
  assert.equal(h.results[0].answers[0].note, "first\nsecond");
});

test("Esc in editor discards only that draft, including undo history", () => {
  const h = setup([{ question: "Text", type: "text", default: "original" }]);
  h.press(k.enter, k.left, "e"); h.paste(" secret draft"); h.press(k.esc);
  assert.equal(h.results.length, 0); assert.doesNotMatch(h.view(), /secret draft/);
  h.press("n", "\x1a"); // Ctrl+Z must not resurrect a discarded answer-editor draft in a note.
  assert.doesNotMatch(h.view(), /secret draft/);
  h.press(k.esc, k.right, k.enter);
  assert.equal(h.results[0].answers[0].value, "original");
  assert.equal(h.results[0].answers[0].note, undefined);
});

test("saved custom answer can be edited and replaces a single selection", () => {
  const h = setup();
  h.press(k.enter, k.left, "e"); h.paste("custom"); h.press(k.enter, k.left, "e");
  h.paste(" revised"); h.press(k.enter, k.enter);
  assert.equal(h.results[0].answers[0].value, null);
  assert.equal(h.results[0].answers[0].other, "custom revised");
});

test("dependent tabs appear only after confirmation and reset on parent change", () => {
  const h = setup([choice,
    { id: "child", question: "Follow-up", type: "text", default: "child default", when: { questionId: "pick", equals: "a" } },
    { id: "leaf", question: "Leaf", type: "text", default: "leaf default", when: { questionId: "child", equals: "child default" } },
  ]);
  assert.doesNotMatch(h.view(), /Q2/);
  h.press(k.enter); assert.match(h.view(), /Follow-up/);
  h.press(k.enter, k.enter, k.right, k.down, k.enter);
  assert.match(h.view(), /Ready to submit/);
  h.press(k.enter);
  assert.deepEqual(h.results[0].hiddenQuestionIds, ["child", "leaf"]);
  assert.equal(h.results[0].answers.length, 1);
});

test("toggling confirmed multi parent invalidates descendants even if condition still matches", () => {
  const h = setup([{ ...choice, type: "multi" }, { id: "child", question: "Follow-up", type: "text", default: "draft", when: { questionId: "pick", equals: "a" } }]);
  h.press(" ", k.enter, k.enter, k.right, k.down, " ");
  assert.doesNotMatch(h.view(), /Q2/);
  h.press(k.enter, k.right, k.enter);
  assert.equal(h.results.length, 0, "revealed default still needs confirmation");
  h.press(k.left, k.enter, k.enter);
  assert.equal(h.results[0].answers[1].value, "draft");
});

test("Esc outside and Ctrl+C anywhere return empty cancellation, never partial answers", () => {
  for (const key of [k.esc, k.cancel]) for (const mode of ["question", "review", "editor"]) {
    if (mode === "editor" && key === k.esc) continue;
    const h = setup(); h.press(k.enter);
    if (mode !== "review") h.press(k.left);
    if (mode === "editor") { h.press("e"); h.paste("private draft"); }
    h.press(key);
    assert.deepEqual(h.results, [{ status: "cancelled", cancelled: true, answers: [], hiddenQuestionIds: [] }]);
    h.ui.abort(); assert.equal(h.results.length, 1);
  }
});

test("abort finishes once; dispose closes silently and drops draft", () => {
  const a = setup(); a.press("e"); a.paste("private draft"); a.ui.abort(); a.ui.abort();
  assert.deepEqual(a.results, [{ status: "aborted", cancelled: true, answers: [], hiddenQuestionIds: [] }]);
  const b = setup(); b.press("e"); b.paste("private draft"); b.ui.dispose(); b.ui.abort(); b.ui.handleInput(k.enter);
  assert.deepEqual(b.results, []); assert.deepEqual(b.ui.render(80), []);
});

test("explain is opt-in, one at a time, sanitized Markdown with generic errors", async () => {
  let calls = 0;
  let resolve!: (value: string) => void;
  const h = setup([{ ...choice, description: "**Question description**", options: [{ id: "a", label: "Alpha", description: "**Option description**", preview: "`Preview code`" }, choice.options[1]] }], () => { calls++; return new Promise(r => { resolve = r; }); });
  assert.match(h.view(), /Question description/); assert.match(h.view(), /Option description/); assert.match(h.view(), /Preview code/);
  assert.equal(calls, 0); h.press("?", "?"); await flush(); assert.equal(calls, 1);
  resolve("**Explanation**\x1b[2J"); await flush(); assert.match(h.view(), /Explanation/);
  assert.ok(!h.ui.render(80).join("\n").includes("\x1b[2J")); h.ui.dispose();
  const bad = setup([choice], async () => { throw new Error("secret provider credentials"); });
  bad.press("?"); await flush(); assert.match(bad.view(), /Explanation unavailable/);
  assert.doesNotMatch(bad.view(), /secret|credentials/); bad.ui.dispose();
});

test("selection, tab, editor and close abort explanations and ignore late replies", async () => {
  for (const action of ["selection", "tab", "editor", "cancel", "abort", "dispose"]) {
    let signal!: AbortSignal;
    let resolve!: (value: string) => void;
    const h = setup([choice], (_q, _o, s) => { signal = s; return new Promise(r => { resolve = r; }); });
    h.press("?"); await flush();
    if (action === "abort") h.ui.abort();
    else if (action === "dispose") h.ui.dispose();
    else h.press(action === "selection" ? k.down : action === "tab" ? k.right : action === "editor" ? "n" : k.cancel);
    assert.equal(signal.aborted, true, action);
    const renders = h.renders(); resolve("STALE EXPLANATION"); await flush();
    assert.doesNotMatch(h.view(), /STALE/); assert.equal(h.renders(), renders); h.ui.dispose();
  }
});

test("explanation timeout aborts and ignores late failures", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal!: AbortSignal;
  let reject!: (reason: Error) => void;
  const h = setup([choice], (_q, _o, s) => { signal = s; return new Promise((_resolve, r) => { reject = r; }); });
  h.press("?"); await flush(); t.mock.timers.tick(30000);
  assert.equal(signal.aborted, true); assert.match(h.view(), /timed out/);
  reject(new Error("secret")); await flush(); assert.match(h.view(), /timed out/);
  assert.doesNotMatch(h.view(), /secret/); h.ui.dispose();
});

test("review scrolls full values and notes; option movement follows selection", () => {
  const h = setup([{ question: "Long text", type: "text", default: Array.from({ length: 25 }, (_, i) => `value-${i}`).join("\n") }]);
  h.tui.terminal!.rows = 10;
  h.press(k.enter, k.left, "n"); h.paste("LAST NOTE"); h.press(k.enter, k.right);
  assert.doesNotMatch(h.view(), /LAST NOTE/);
  for (let i = 0; i < 10; i++) { h.press(k.pageDown); h.view(); }
  assert.match(h.view(), /value-24/); assert.match(h.view(), /LAST NOTE/);
  for (let i = 0; i < 10; i++) { h.press(k.pageUp); h.view(); }
  assert.match(h.view(), /Ready to submit/); h.ui.dispose();
  const c = setup([{ ...choice, description: "description\n\n".repeat(20) }]);
  c.tui.terminal!.rows = 8; c.view(); c.press(k.down);
  assert.match(c.view(), />   2\. Beta/); c.ui.dispose();
});

test("narrow widths, low heights, active tabs and focused editor cursor remain bounded", () => {
  const h = setup(Array.from({ length: 12 }, (_, i) => ({ id: `q${i}`, header: `Question${i}`, question: "界 wide", type: "text" })));
  for (let i = 0; i < 10; i++) h.press(k.right);
  assert.match(h.view(22), /Question10/);
  for (const rows of [0, 1, 2, 3, 4, 8, 24]) {
    h.tui.terminal!.rows = rows;
    for (const width of [0, 1, 2, 3, 10, 22, 80]) {
      const lines = h.ui.render(width);
      assert.ok(lines.length <= rows); assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  }
  h.press("e"); h.paste(Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n"));
  for (const rows of [1, 2, 3, 4, 8, 24]) {
    h.tui.terminal!.rows = rows;
    for (const width of [1, 2, 3, 10, 80]) {
      const lines = h.ui.render(width);
      assert.ok(lines.length <= rows); assert.ok(lines.every(line => visibleWidth(line) <= width));
      assert.ok(lines.some(line => line.includes(CURSOR_MARKER)), `cursor at ${width}x${rows}`);
    }
  }
  h.ui.focused = false;
  assert.ok(h.ui.render(80).every(line => !line.includes(CURSOR_MARKER))); h.ui.dispose();
});

test("empty and overlong answers/notes stay drafts; C1 controls cannot reach the terminal", () => {
  const h = setup([{ question: "Text", type: "text" }]);
  h.press(k.enter, k.enter); assert.match(h.view(), /Enter an answer/);
  h.paste("x".repeat(10001)); h.press(k.save); assert.match(h.view(), /10,000/);
  h.press(k.esc, "n"); h.paste("x".repeat(10001)); h.press(k.save); assert.match(h.view(), /10,000/);
  h.press(k.esc, "e"); h.paste("unsafe\x9d52;clipboard\x9c");
  assert.ok(!/[\x7f-\x9f]/.test(h.ui.render(80).join("\n")));
  h.press(k.save); assert.match(h.view(), /control codes/);
  h.press(k.cancel); assert.deepEqual(h.results[0].answers, []);
});

test("clearing a custom-only multi answer leaves an unconfirmed editable draft", () => {
  const h = setup([{ ...choice, type: "multi" }]);
  h.press("e"); h.paste("custom"); h.press(k.save, k.enter, k.left, "e");
  h.press(...Array(6).fill("\x7f"), k.save);
  assert.doesNotMatch(h.view(), /\[✓\]|"custom"/);
  h.press(k.right, k.enter); assert.equal(h.results.length, 0);
  h.press(k.left, k.up, k.up, " ", k.enter, k.enter);
  assert.deepEqual(h.results[0].answers[0], { id: "pick", value: ["a"], skipped: false });
});

test("old explanation rejection cannot replace a newer successful request", async () => {
  let reject!: (reason: Error) => void;
  const h = setup([choice], (_q, option) => option.id === "a" ? new Promise((_r, r) => { reject = r; }) : Promise.resolve("Fresh explanation"));
  h.press("?"); await flush(); h.press(k.down, "?"); await flush();
  assert.match(h.view(), /Fresh explanation/);
  reject(new Error("late secret")); await flush();
  assert.match(h.view(), /Fresh explanation/); assert.doesNotMatch(h.view(), /late secret|unavailable/); h.ui.dispose();
});

// Captured from 779d11d6's renderer, NOT the implementation under test. Only the
// old SDK import namespace was changed. Text, chrome, colors and keys are fixed.
const original = JSON.parse(readFileSync(new URL("./original-ui.snap.json", import.meta.url), "utf8"));
for (const snapshot of original.snapshots) test(`original UI parity: ${snapshot.name}`, () => {
  const h = setup(snapshot.questions);
  h.tui.terminal!.rows = 40;
  h.press(...snapshot.keys);
  const lines = h.ui.render(snapshot.width);
  assert.deepEqual(lines.map(line => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, "")).trimEnd()), snapshot.lines);
  for (const { index, line } of snapshot.styledRows) assert.equal(lines[index], line, `original styling at row ${index}`);
  h.ui.dispose();
});

test("original Other controls: Tab/Space edit inline; saved Other confirms with Enter", () => {
  for (const key of ["\t", " "]) {
    const h = setup([{ ...choice, type: "multi" }]);
    h.press(k.down, k.down, k.enter);
    assert.doesNotMatch(h.view(), /Your answer:/, "Enter without saved Other does not open the editor");
    h.press(key); h.paste("custom");
    assert.match(h.view(), /Choose[\s\S]*Type your own answer\.\.\. ✎[\s\S]*Your answer:/);
    h.press(k.enter);
    assert.match(h.view(), /"custom"/);
    h.press(k.enter);
    assert.match(h.view(), /Ready to submit/);
    assert.equal(h.results.length, 0);
    h.press(k.enter);
    assert.equal(h.results[0].answers[0].other, "custom");
  }
  const h = setup([choice, { question: "Second", type: "text" }]);
  h.press("\t"); assert.match(h.view(), /Choose/); // Tab is not question navigation.
  h.ui.dispose();
});

test("short terminals keep validation visible and option labels stay on one row", () => {
  const h = setup([{ question: "When?", type: "date" }]);
  h.tui.terminal!.rows = 4;
  h.press("e"); h.paste("2025-02-29"); h.press(k.enter);
  assert.match(h.view(), /Enter a real date/);
  assert.ok(h.ui.render(80).some(line => line.includes(CURSOR_MARKER)));
  assert.ok(h.ui.render(80).length <= 4);
  h.ui.dispose();
  const c = setup([{ ...choice, options: [{ label: "Two\nlines\t界" }] }]);
  assert.match(c.view(), /1\. Two lines 界/);
  assert.ok(c.ui.render(80).every(line => !/[\n\r\t]/.test(line)));
  c.ui.dispose();
});

test("number shortcuts select/toggle original numbered choices without bypassing review", () => {
  const s = setup();
  s.press("0", "9"); assert.match(s.view(), /Choose/);
  s.press("2"); assert.match(s.view(), /Ready to submit/); assert.equal(s.results.length, 0);
  s.press(k.enter); assert.equal(s.results[0].answers[0].value, "b");
  const m = setup([{ ...choice, type: "multi" }]);
  m.press("1", "2", "1"); assert.match(m.view(), /\[✓\] 2\. Beta/);
  m.press(k.enter, k.enter); assert.deepEqual(m.results[0].answers[0].value, ["b"]);
  const other = setup(); other.press("3"); assert.match(other.view(), /Your answer:/);
  other.press("1", "2", "3", k.enter, k.enter);
  assert.equal(other.results[0].answers[0].other, "123", "editor digits stay text");
});

test("filter searches labels/descriptions, retains numbering and hidden selections, and clears with Esc", () => {
  const h = setup([{ ...choice, type: "multi", options: [choice.options[0], { ...choice.options[1], description: "Slower delivery" }] }]);
  h.press("1", "/"); h.paste("SLOWER");
  assert.doesNotMatch(h.view(), /1\. Alpha/); assert.match(h.view(), /2\. Beta/);
  assert.match(h.view(), /Filter options:/);
  h.press(k.enter, "1"); // Hidden original number must not act on a different visible option.
  assert.match(h.view(), /Filter: SLOWER/);
  h.press("2", k.esc);
  assert.match(h.view(), /\[✓\] 1\. Alpha/); assert.match(h.view(), /\[✓\] 2\. Beta/);
  assert.equal(h.results.length, 0, "first Escape clears the filter, not the form");
  h.press(k.enter, k.enter);
  assert.deepEqual(h.results[0].answers[0].value, ["a", "b"]);
});

test("filter edits discard safely, handle no matches, stay bounded, and reset on tab navigation", () => {
  const h = setup([{ ...choice, allowOther: false }, { question: "Second", type: "text" }]);
  h.press("/"); h.paste("zzz"); h.press(k.enter);
  assert.match(h.view(), /No matching options/);
  h.press("1", " ", k.enter); assert.equal(h.results.length, 0); assert.match(h.view(), /No matching options/);
  h.press("/"); h.paste("discard me"); h.press(k.esc); assert.match(h.view(), /Filter: zzz/);
  h.press(k.esc, "/"); h.paste("beta"); h.press(k.enter);
  assert.match(h.view(), /2\. Beta/); assert.doesNotMatch(h.view(), /1\. Alpha/);
  h.press(k.right, k.left); assert.match(h.view(), /1\. Alpha/); assert.doesNotMatch(h.view(), /Filter:/);
  h.press("/"); h.paste("x".repeat(201)); h.press(k.enter); assert.match(h.view(), /at most 200/);
  h.press(k.esc, "/"); h.paste("bad\x9dtext"); h.press(k.enter); assert.match(h.view(), /control codes/);
  h.press(k.cancel); assert.deepEqual(h.results[0].answers, []);
  const other = setup(); other.press("/"); other.paste("no-match"); other.press(k.enter, "3");
  assert.match(other.view(), /Your answer:/, "Other remains available when no listed option matches");
  other.ui.dispose();
});

test("limits apply to keyboard, filtered choices and Other; minimum waits for confirmation", () => {
  const h = setup([{ ...choice, type: "multi", minSelections: 2, maxSelections: 2 }]);
  h.press("3"); h.paste("custom"); h.press(k.enter);
  assert.match(h.view(), /"custom"/, "partial multi draft may save Other before reaching minimum");
  h.press(k.enter); assert.match(h.view(), /at least 2/);
  h.press("1", "2"); assert.match(h.view(), /at most 2/); assert.doesNotMatch(h.view(), /\[✓\] 2\. Beta/);
  h.press(k.enter, k.enter); assert.deepEqual(h.results[0].answers[0].value, ["a"]); assert.equal(h.results[0].answers[0].other, "custom");
  const m = setup([{ ...choice, type: "multi", maxSelections: 1 }]);
  m.press("1", "/"); m.paste("Beta"); m.press(k.enter, "2"); assert.match(m.view(), /at most 1/);
  m.press(k.esc, "3"); m.paste("too many"); m.press(k.enter); assert.match(m.view(), /at most 1/);
  m.press(k.esc, "1", "2", k.enter, k.enter); assert.deepEqual(m.results[0].answers[0].value, ["b"]);
});

test("custom answer shortcuts reveal Other follow-ups; editing resets confirmed descendants", () => {
  const h = setup([choice, { id: "why", question: "Explain custom", default: "because", when: { questionId: "pick", other: true } }]);
  h.press("3"); h.paste("custom"); h.press(k.enter); assert.match(h.view(), /Explain custom/);
  h.press("n"); h.paste("old note"); h.press(k.enter, k.enter, k.right, "e");
  h.paste(" revised"); h.press(k.enter); assert.match(h.view(), /Explain custom/); assert.doesNotMatch(h.view(), /old note/);
  h.press(k.right, k.enter); assert.equal(h.results.length, 0, "revealed default must be confirmed again");
  h.press(k.left, k.enter, k.enter);
  assert.equal(h.results[0].answers[0].other, "custom revised"); assert.equal(h.results[0].answers[1].note, undefined);
});

test("F1 help is opt-in, scrollable, preserves editor drafts/focus, and never answers", () => {
  const h = setup(); const original = h.view();
  h.press("\x1bOP"); assert.match(h.view(), /Keyboard shortcuts/); assert.match(h.view(), /n edit note/);
  h.press("1", k.enter); assert.equal(h.results.length, 0);
  h.press(k.esc); assert.equal(h.view(), original);
  h.press("e"); h.paste("private draft"); h.press("\x1bOP");
  assert.doesNotMatch(h.view(), /private draft/); assert.ok(h.ui.render(80).every(line => !line.includes(CURSOR_MARKER)));
  h.press(k.esc); assert.match(h.view(), /private draft/); assert.ok(h.ui.render(80).some(line => line.includes(CURSOR_MARKER)));
  h.press("\x1bOP"); h.tui.terminal!.rows = 8;
  for (let i = 0; i < 20; i++) { h.press(k.pageDown); h.view(); }
  assert.match(h.view(), /Ctrl\+C cancels anywhere/);
  for (const width of [1, 2, 10, 80]) assert.ok(h.ui.render(width).every(line => visibleWidth(line) <= width));
  h.press(k.cancel); assert.deepEqual(h.results[0].answers, []);
});

test("opening help or filtering aborts option explanations without accepting late output", async () => {
  for (const key of ["\x1bOP", "/"]) {
    let signal!: AbortSignal; let resolve!: (s: string) => void;
    const h = setup([choice], (_q, _o, s) => { signal = s; return new Promise(r => { resolve = r; }); });
    h.press("?"); await flush(); h.press(key); assert.ok(signal.aborted);
    resolve("stale explanation"); await flush(); assert.doesNotMatch(h.view(), /stale explanation/);
    h.ui.dispose();
  }
});
