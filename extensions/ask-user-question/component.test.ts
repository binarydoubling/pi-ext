import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { AskUserQuestionComponent, type TUILike } from "./component.ts";
import { normalizeInput, type Question, type Option, type Result } from "./schema.ts";

initTheme("dark", false);
const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
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

test("single question has Review; defaults and tab navigation never confirm", () => {
  const h = setup([{ ...choice, default: "b" }]);
  assert.match(h.view(), /Review/);
  assert.match(h.view(), /Draft: Beta/);
  h.press(k.right, k.enter);
  assert.equal(h.results.length, 0);
  assert.match(h.view(), /Confirm or explicitly skip/);
  h.press(k.left, k.enter);
  assert.equal(h.results.length, 0, "confirm advances to review without submitting");
  assert.match(h.view(), /Ready to submit/);
  assert.match(h.view(), /Enter\/Ctrl\+S submit/);
  h.press(k.save);
  assert.equal(h.results[0].answers[0].value, "b");
  h.ui.abort(); h.ui.handleInput(k.enter);
  assert.equal(h.results.length, 1);
});

test("multi requires a selection and explicit confirmation; Other is additive", () => {
  const h = setup([{ ...choice, type: "multi" }]);
  h.press(k.enter);
  assert.match(h.view(), /Select a choice/);
  h.press(" ", k.down, " ", k.down, k.enter); h.paste("custom"); h.press(k.save);
  assert.match(h.view(), /Draft: Alpha; Beta; Other: custom/);
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
  assert.match(h.view(), /Confirmed:/, "notes do not invalidate a confirmed answer");
  h.press(k.right, k.enter);
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
  assert.match(c.view(), /> \[ \] Beta/); c.ui.dispose();
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
  assert.match(h.view(), /Draft: \(unanswered\)/);
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
