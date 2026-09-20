import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const text = (maxLength: number, minLength = 1) => Type.String({ minLength, maxLength, pattern: "^[^\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]*$" });
const id = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,47}(?![\\s\\S])" });
export const OptionSchema = Type.Object({
  id: Type.Optional(id),
  label: text(200),
  description: Type.Optional(text(2000)),
  preview: Type.Optional(text(4000)),
}, { additionalProperties: false });
export const QuestionSchema = Type.Object({
  id: Type.Optional(id),
  question: text(1000),
  header: Type.Optional(text(12)),
  description: Type.Optional(text(4000)),
  type: Type.Optional(Type.Union(["single", "multi", "text", "date", "datetime", "time"].map(value => Type.Literal(value)))),
  options: Type.Optional(Type.Array(OptionSchema, { minItems: 1, maxItems: 12 })),
  multiSelect: Type.Optional(Type.Boolean({ description: "Legacy alias for type: multi" })),
  required: Type.Optional(Type.Boolean({ description: "Default true; optional fields can be explicitly skipped" })),
  allowOther: Type.Optional(Type.Boolean({ description: "Choice fields only; default true" })),
  default: Type.Optional(Type.Union([text(10000), Type.Array(text(200), { minItems: 1, maxItems: 12, uniqueItems: true })])),
  when: Type.Optional(Type.Object({
    questionId: id,
    equals: text(10000),
  }, { additionalProperties: false, description: "Show only when an EARLIER confirmed answer equals this value (or includes it for multi). Use option IDs when supplied." })),
}, { additionalProperties: false });
export const InputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 12 }),
}, { additionalProperties: false });

export type Option = Static<typeof OptionSchema> & { id: string };
export type Question = Omit<Static<typeof QuestionSchema>, "options" | "type"> & {
  id: string; header: string; type: "single" | "multi" | "text" | "date" | "datetime" | "time";
  options: Option[]; required: boolean; allowOther: boolean;
};
export interface Answer {
  id: string;
  value: string | string[] | null;
  other?: string;
  note?: string;
  skipped: boolean;
}
export interface Result {
  status: "submitted" | "cancelled" | "aborted" | "unavailable";
  cancelled: boolean;
  answers: Answer[];
  hiddenQuestionIds: string[];
}
export interface QuestionState {
  value: string | string[] | null;
  other: string;
  note: string;
  skipped: boolean;
  confirmed: boolean;
  cursorIndex: number;
}
export const emptyState = (): QuestionState => ({ value: null, other: "", note: "", skipped: false, confirmed: false, cursorIndex: 0 });
export const cancelledResult = (status: Exclude<Result["status"], "submitted">): Result => ({ status, cancelled: true, answers: [], hiddenQuestionIds: [] });
export const isChoice = (q: Question) => q.type === "single" || q.type === "multi";
export const safeDisplay = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");

/** Exact local civil dates/times: no timezone conversion or JS Date rollover. */
export function validDate(value: string, type: Question["type"]): boolean {
  if (type === "time") return value.length === 5 && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  const match = (type === "datetime" ? /^(\d{4})-(\d{2})-(\d{2}) ([01]\d|2[0-3]):[0-5]\d$/ : /^(\d{4})-(\d{2})-(\d{2})$/).exec(value);
  if (!match || match[0].length !== value.length) return false;
  const [year, month, day] = match.slice(1, 4).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

export function answerError(q: Question, state: Pick<QuestionState, "value" | "other" | "note" | "skipped">): string | undefined {
  const { value, other, note, skipped } = state;
  if (note.length > 10000 || other.length > 10000 || safeDisplay(note) !== note || safeDisplay(other) !== other) return "Text must be at most 10,000 characters, without control codes.";
  if (skipped) return q.required ? "This question is required." : undefined;
  if (other && (!q.allowOther || !isChoice(q))) return "A custom answer is not allowed here.";
  if (q.type === "multi") {
    if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(v => !q.options.some(o => o.id === v))) return "Select valid choices.";
    if (!value.length && !other.trim()) return "Select a choice or enter a custom answer.";
  } else if (q.type === "single") {
    if (other.trim() && value === null) return undefined;
    if (other || typeof value !== "string" || !q.options.some(o => o.id === value)) return "Select a choice or enter a custom answer.";
  } else {
    if (typeof value !== "string" || !value.trim()) return "Enter an answer, or explicitly skip an optional question.";
    if (value.length > 10000 || safeDisplay(value) !== value) return "Text must be at most 10,000 characters, without control codes.";
    if (q.type !== "text" && !validDate(value, q.type)) return `Enter a real ${q.type}: ${q.type === "date" ? "YYYY-MM-DD" : q.type === "time" ? "HH:mm (24-hour)" : "YYYY-MM-DD HH:mm (24-hour)"}.`;
  }
}

export function normalizeInput(input: unknown): Question[] {
  if (!Value.Check(InputSchema, input)) throw new Error("Invalid questionnaire: use 1–12 questions with supported fields and bounded text/options; no control codes.");
  const questions: Question[] = [];
  for (const [index, raw] of input.questions.entries()) {
    const type = raw.type ?? (raw.multiSelect ? "multi" : raw.options ? "single" : "text");
    const q: Question = { ...raw, id: raw.id ?? `q${index + 1}`, header: raw.header ?? `Q${index + 1}`, type,
      required: raw.required ?? true, allowOther: raw.allowOther ?? (type === "single" || type === "multi"),
      options: (raw.options ?? []).map(o => ({ ...o, id: o.id ?? o.label })),
    };
    const fail = (message: string): never => { throw new Error(`Question ${index + 1}: ${message}`); };
    if (!q.question.trim() || !q.header.trim() || questions.some(p => p.id === q.id)) fail("question/header must be nonempty and IDs unique.");
    if (raw.multiSelect !== undefined && raw.multiSelect !== (type === "multi")) fail("multiSelect conflicts with type.");
    if (isChoice(q) !== Boolean(q.options.length)) fail("choice fields need options; other fields must not have options.");
    if (!isChoice(q) && raw.allowOther !== undefined) fail("allowOther only applies to choice fields.");
    if (q.options.some(o => !o.label.trim()) || new Set(q.options.map(o => o.id)).size !== q.options.length || new Set(q.options.map(o => o.label)).size !== q.options.length) fail("option labels and IDs must be nonempty and unique.");
    if (raw.default !== undefined) {
      const error = answerError(q, { ...emptyState(), value: raw.default });
      if (error) fail(`invalid default: ${error}`);
    }
    if (q.when) {
      const parent = questions.find(p => p.id === q.when!.questionId);
      if (!parent) fail("conditions must reference an earlier question ID.");
      const error = answerError(parent!, { ...emptyState(), value: parent!.type === "multi" ? [q.when.equals] : q.when.equals });
      if (error) fail("condition must match a valid value of its earlier question.");
    }
    questions.push(q);
  }
  return questions;
}

/** Shared UI state; defaults are drafts, never implicit confirmations. */
export class Questionnaire {
  readonly states = new Map<string, QuestionState>();
  readonly questions: Question[];
  constructor(questions: Question[]) {
    this.questions = questions;
    for (const q of questions) this.states.set(q.id, emptyState());
    for (const q of this.visible()) this.setDefault(q);
  }
  private setDefault(q: Question) {
    const state = this.states.get(q.id)!;
    state.value = q.default === undefined ? (q.type === "multi" ? [] : null) : structuredClone(q.default);
    if (q.type === "single") state.cursorIndex = Math.max(0, q.options.findIndex(o => o.id === state.value));
  }
  visible(): Question[] {
    const visible = new Set<string>();
    return this.questions.filter(q => {
      if (!q.when) { visible.add(q.id); return true; }
      const parent = this.states.get(q.when.questionId)!;
      const show = visible.has(q.when.questionId) && parent.confirmed && !parent.skipped &&
        (Array.isArray(parent.value) ? parent.value.includes(q.when.equals) : parent.value === q.when.equals);
      if (show) visible.add(q.id);
      return show;
    });
  }
  change(q: Question, patch: Partial<QuestionState>): void {
    const before = new Set(this.visible().map(q => q.id));
    const state = this.states.get(q.id)!;
    const previous = JSON.stringify([state.value, state.other, state.skipped]);
    Object.assign(state, patch);
    if (previous !== JSON.stringify([state.value, state.other, state.skipped])) {
      state.confirmed = false;
      // Reset all transitive dependents, even if the new parent value still shows them.
      const changed = new Set([q.id]);
      for (const child of this.questions) if (child.when && changed.has(child.when.questionId)) {
        changed.add(child.id);
        this.states.set(child.id, emptyState());
        before.delete(child.id);
      }
    }
    for (const child of this.visible()) if (!before.has(child.id)) this.setDefault(child);
  }
  confirm(q: Question): string | undefined {
    const state = this.states.get(q.id)!;
    const error = answerError(q, state);
    if (error) return error;
    const before = new Set(this.visible().map(q => q.id));
    state.confirmed = true;
    for (const child of this.visible()) if (!before.has(child.id)) this.setDefault(child);
  }
  result(): Result | undefined {
    const visible = this.visible();
    if (visible.some(q => !this.states.get(q.id)!.confirmed || answerError(q, this.states.get(q.id)!))) return undefined;
    return { status: "submitted", cancelled: false,
      hiddenQuestionIds: this.questions.filter(q => !visible.includes(q)).map(q => q.id),
      answers: visible.map(q => {
        const s = this.states.get(q.id)!;
        return { id: q.id, value: s.skipped ? null : structuredClone(s.value), skipped: s.skipped,
          ...(s.other && !s.skipped ? { other: s.other } : {}), ...(s.note ? { note: s.note } : {}) };
      }),
    };
  }
}

export function answerText(q: Question, state: Pick<QuestionState, "value" | "other" | "skipped">): string {
  if (state.skipped) return "(skipped)";
  const label = (v: string) => q.options.find(o => o.id === v)?.label ?? v;
  const values = Array.isArray(state.value) ? state.value.map(label) : state.value === null ? [] : [label(state.value)];
  if (state.other) values.push(`Other: ${state.other}`);
  return values.join("; ") || "(unanswered)";
}
