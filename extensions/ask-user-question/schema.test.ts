import assert from "node:assert/strict";
import { test } from "node:test";
import { answerError, cancelledResult, emptyState, normalizeInput, Questionnaire, validDate } from "./schema.ts";

const choice = { id: "pick", question: "Pick", options: [{ id: "a", label: "Alpha, Beta" }, { id: "b", label: "Gamma" }] };
const parse = (...questions: unknown[]) => normalizeInput({ questions });

test("legacy normalization retains headers/options, assigns stable IDs, and requires confirmation", () => {
  const [q] = parse({ question: "Pick", header: "Scope", options: [{ label: "One" }, { label: "Two" }], multiSelect: true });
  assert.equal(q.id, "q1"); assert.equal(q.type, "multi"); assert.equal(q.options[0].id, "One");
  assert.equal(q.allowOther, true); assert.equal(q.required, true);
  const form = new Questionnaire([q]);
  form.change(q, { value: ["One", "Two"] }); assert.equal(form.result(), undefined);
  assert.equal(form.confirm(q), undefined);
  assert.deepEqual(form.result()?.answers[0].value, ["One", "Two"]);
});

test("strict input validation rejects ambiguity, unknown fields, invalid defaults and conditions", () => {
  for (const input of [null, {}, { questions: [] }, { questions: Array(13).fill(choice) }, { questions: [choice], title: "Unsupported" }]) assert.throws(() => normalizeInput(input));
  for (const q of [
    { ...choice, id: "__proto__" }, { ...choice, id: "pick\n" }, { ...choice, options: [{ id: "a\n", label: "One" }] }, { ...choice, header: "header too long" }, { ...choice, question: " " },
    { ...choice, options: [] }, { ...choice, options: Array(13).fill({ label: "A" }) },
    { ...choice, options: [{ id: "a", label: "One" }, { id: "a", label: "Two" }] },
    { ...choice, options: [{ id: "a", label: "One" }, { id: "b", label: "One" }] },
    { ...choice, type: "text" }, { ...choice, type: "date", options: undefined, allowOther: true },
    { ...choice, type: "multi", multiSelect: false }, { ...choice, default: "missing" },
    { ...choice, type: "multi", default: ["a", "a"] }, { ...choice, type: "multi", default: "a" },
    { ...choice, when: { questionId: "pick", equals: "a" } }, { ...choice, question: "\x1b[2Jbad" },
    { question: "When?", type: "datetime", default: "4000-22-10 13:00" },
    { question: "When?", type: "date", default: "2025-02-29" },
    { question: "Text?", default: " " }, { question: "Text?", default: "x".repeat(10001) },
    { ...choice, unexpected: true },
  ]) assert.throws(() => parse(q), JSON.stringify(q).slice(0, 120));
  assert.throws(() => parse(choice, choice));
  assert.throws(() => parse(choice, { question: "Child", when: { questionId: "pick", equals: "unknown" } }));
});

test("Gregorian dates are exact and times reject rollover including Joseph regression", () => {
  for (const value of ["2000-02-29", "2024-02-29", "0001-01-01", "9999-12-31", "4000-02-29"]) assert.equal(validDate(value, "date"), true, value);
  for (const value of ["1900-02-29", "2100-02-29", "2025-02-29", "2024-04-31", "2024-00-01", "2024-13-01", "2024-01-00", "0000-01-01", "24-01-01", "2024-1-01", "2024-01-01Z", " 2024-01-01", "2024-01-01\n"]) assert.equal(validDate(value, "date"), false, value);
  for (const value of ["4000-22-10 13:00", "2024-02-29 24:00", "2024-02-29 12:60", "2024-02-29T12:30", "2024-02-29 12:00:00"]) assert.equal(validDate(value, "datetime"), false, value);
  assert.equal(validDate("2024-02-29 23:59", "datetime"), true);
  for (const value of ["00:00", "23:59"]) assert.equal(validDate(value, "time"), true);
  for (const value of ["9:00", "24:00", "12:60", "-1:00"]) assert.equal(validDate(value, "time"), false);
});

test("hidden answers and notes reset transitively, including multi parents which still match", () => {
  const qs = parse({ ...choice, type: "multi", default: ["a"] },
    { id: "child", question: "Child", default: "yes", when: { questionId: "pick", equals: "a" } },
    { id: "leaf", question: "Leaf", when: { questionId: "child", equals: "yes" } });
  const form = new Questionnaire(qs);
  assert.deepEqual(form.visible().map(q => q.id), ["pick"]);
  form.confirm(qs[0]); form.confirm(qs[1]);
  form.change(qs[2], { value: "private leaf", note: "private note" }); form.confirm(qs[2]);
  assert.equal(form.result()?.answers.length, 3);
  form.change(qs[0], { value: ["a", "b"] });
  assert.equal(form.result(), undefined); assert.deepEqual(form.states.get("leaf"), emptyState());
  form.confirm(qs[0]); assert.equal(form.states.get("child")?.confirmed, false);
  form.change(qs[0], { value: ["b"] }); form.confirm(qs[0]);
  assert.deepEqual(form.result()?.hiddenQuestionIds, ["child", "leaf"]);
  assert.doesNotMatch(JSON.stringify(form.result()), /private/);
});

test("optional is distinct from missing, cancellation never exposes a draft, structured output is a snapshot", () => {
  const qs = parse({ ...choice, type: "multi" }, { id: "optional", question: "Optional", required: false });
  const form = new Questionnaire(qs);
  form.change(qs[0], { value: ["a"], other: "Other, with commas", note: "Note\nwith newline" }); form.confirm(qs[0]);
  assert.equal(form.result(), undefined);
  form.change(qs[1], { skipped: true }); form.confirm(qs[1]);
  const result = form.result()!;
  assert.deepEqual(result.answers[0], { id: "pick", value: ["a"], other: "Other, with commas", note: "Note\nwith newline", skipped: false });
  assert.deepEqual(result.answers[1], { id: "optional", value: null, skipped: true });
  (result.answers[0].value as string[]).push("b"); assert.deepEqual(form.states.get("pick")?.value, ["a"]);
  assert.deepEqual(cancelledResult("cancelled").answers, []);
  assert.ok(answerError(qs[0], { ...emptyState(), skipped: true }));
});
