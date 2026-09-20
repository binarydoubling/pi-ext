// Derived from ghoseb/pi-askuserquestion (MIT); see LICENSE.
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component, CURSOR_MARKER, Editor, type Focusable, Key, Markdown,
  matchesKey, sliceByColumn, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  answerError, answerText, cancelledResult, isChoice, Questionnaire, safeDisplay,
  type Option, type Question, type Result,
} from "./schema.ts";

export interface TUILike {
  requestRender(): void;
  terminal?: { rows: number; columns: number };
}
type Explain = (question: Question, option: Option, signal: AbortSignal) => Promise<string>;
type EditField = "value" | "other" | "note";

/** Native compact questionnaire: navigation never confirms, and only Review submits. */
export class AskUserQuestionComponent implements Component, Focusable {
  private model: Questionnaire;
  private tui: TUILike;
  private theme: Theme;
  private done: (result: Result) => void;
  private explain?: Explain;
  private active: string | null;
  private editor: Editor;
  private editing?: EditField;
  private hasFocus = false;
  private closed = false;
  private scroll = 0;
  private followSelection = false;
  private pageSize = 8;
  private error = "";
  private assistance?: { controller: AbortController; timer: ReturnType<typeof setTimeout> };
  private explanation = "";

  constructor(questions: Question[], tui: TUILike, theme: Theme, done: (result: Result) => void, explain?: Explain) {
    this.model = new Questionnaire(questions);
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.explain = explain;
    this.active = this.model.visible()[0]?.id ?? null;
    this.editor = this.createEditor();
  }

  private createEditor(): Editor {
    const { tui, theme } = this;
    // Editor only needs requestRender and terminal.rows; preserve live resize information.
    const editor = new Editor({
      requestRender: () => tui.requestRender(),
      get terminal() { return tui.terminal ?? { rows: 24, columns: 80 }; },
    } as TUI, {
      borderColor: s => theme.fg("muted", s),
      selectList: {
        selectedPrefix: s => theme.fg("accent", s), selectedText: s => theme.fg("accent", s),
        description: s => theme.fg("muted", s), scrollInfo: s => theme.fg("dim", s),
        noMatch: s => theme.fg("warning", s),
      },
    }, { paddingX: 0 });
    editor.disableSubmit = true;
    editor.onChange = () => { this.error = ""; this.tui.requestRender(); };
    return editor;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && Boolean(this.editing);
  }
  invalidate(): void { this.editor.invalidate(); }
  abort(): void { this.finish(cancelledResult("aborted")); }
  dispose(): void {
    this.closed = true;
    this.stopAssistance();
    this.editing = undefined;
    this.editor.focused = false;
    this.editor = this.createEditor(); // Drop text, paste buffers and undo history together.
  }
  private finish(result: Result): void {
    if (this.closed) return;
    this.dispose();
    this.done(result);
  }
  private question(): Question | undefined {
    return this.model.visible().find(q => q.id === this.active);
  }
  private stopAssistance(): void {
    const job = this.assistance;
    this.assistance = undefined; // Invalidate before abort listeners can run.
    if (job) { clearTimeout(job.timer); job.controller.abort(); }
    this.explanation = "";
  }
  private switchTab(id: string | null): void {
    this.stopAssistance();
    this.active = id;
    this.scroll = 0;
    this.followSelection = false;
    this.error = "";
  }
  private confirm(q: Question): void {
    this.error = this.model.confirm(q) ?? "";
    if (this.error) return;
    const visible = this.model.visible();
    this.switchTab(visible[visible.indexOf(q) + 1]?.id ?? null);
  }
  private openEditor(q: Question, field: EditField): void {
    this.stopAssistance();
    this.editing = field;
    this.error = "";
    const value = this.model.states.get(q.id)![field];
    this.editor.setText(safeDisplay(typeof value === "string" ? value : ""));
    this.editor.focused = this.focused;
  }
  private closeEditor(): void {
    this.editing = undefined;
    this.editor.focused = false;
    this.editor = this.createEditor();
    this.error = "";
  }
  private saveEditor(q: Question): void {
    const field = this.editing!;
    const input = this.editor.getExpandedText();
    const text = field === "other" && !input.trim() ? "" : input;
    const state = this.model.states.get(q.id)!;
    const patch = field === "note" ? { note: text } : {
      [field]: text, skipped: false,
      ...(field === "other" ? { cursorIndex: q.options.length } : {}),
      ...(field === "other" && q.type === "single" ? { value: null } : {}),
    };
    // Clearing Other leaves an unconfirmed draft, just like unchecking every choice.
    const clearingOther = field === "other" && text === "";
    // Notes can be saved before answering; answer validation still happens on confirm.
    this.error = field === "note" || clearingOther
      ? (text.length > 10000 || safeDisplay(text) !== text ? "Notes must be at most 10,000 characters, without control codes." : "")
      : answerError(q, { ...state, ...patch }) ?? "";
    if (this.error) return;
    this.model.change(q, patch);
    this.closeEditor();
    if (field !== "note" && !clearingOther && q.type !== "multi") this.confirm(q);
  }
  private startAssistance(q: Question): void {
    const option = q.options[this.model.states.get(q.id)!.cursorIndex];
    if (!option || this.assistance) return;
    if (!this.explain) { this.explanation = "Explanation unavailable."; return; }
    this.explanation = "Explaining…";
    const controller = new AbortController();
    const job = { controller, timer: setTimeout(() => {
      if (this.assistance !== job) return;
      this.stopAssistance();
      this.explanation = "Explanation timed out. Press ? to retry.";
      this.tui.requestRender();
    }, 30000) };
    job.timer.unref?.();
    this.assistance = job;
    // Also catches synchronous provider failures. No raw provider errors enter the UI.
    void Promise.resolve().then(() => {
      if (this.assistance !== job) return "";
      return this.explain!(q, option, controller.signal);
    }).then(text => {
      if (this.closed || this.assistance !== job) return;
      this.explanation = safeDisplay(text).slice(0, 10000) || "No explanation available.";
    }, () => {
      if (!this.closed && this.assistance === job) this.explanation = "Explanation unavailable. Press ? to retry.";
    }).finally(() => {
      clearTimeout(job.timer);
      if (this.closed || this.assistance !== job) return;
      this.assistance = undefined;
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.closed) return;
    try { this.input(data); }
    finally { this.tui.requestRender(); }
  }
  private input(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) { this.finish(cancelledResult("cancelled")); return; }
    const q = this.question();
    if (this.editing && q) {
      if (matchesKey(data, Key.escape)) this.closeEditor();
      else if (matchesKey(data, Key.shift(Key.enter))) this.editor.insertTextAtCursor("\n");
      else if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) this.saveEditor(q);
      else this.editor.handleInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) { this.finish(cancelledResult("cancelled")); return; }
    const tabs = [...this.model.visible().map(q => q.id), null];
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right) || matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab))) {
      const delta = matchesKey(data, Key.left) || matchesKey(data, Key.shift(Key.tab)) ? -1 : 1;
      this.switchTab(tabs[(tabs.indexOf(this.active) + delta + tabs.length) % tabs.length]);
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
      this.scroll = Math.max(0, this.scroll + (matchesKey(data, Key.pageUp) ? -1 : 1) * this.pageSize);
      this.followSelection = false;
      return;
    }
    if (!q) {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) {
        const result = this.model.result();
        if (result) this.finish(result);
        else this.error = "Confirm or explicitly skip every visible question before submitting.";
      }
      return;
    }
    const state = this.model.states.get(q.id)!;
    if (matchesKey(data, "n")) { this.openEditor(q, "note"); return; }
    if (matchesKey(data, "s")) {
      this.stopAssistance();
      if (q.required) this.error = "This question is required.";
      else { this.model.change(q, { skipped: true }); this.confirm(q); }
      return;
    }
    if (matchesKey(data, "e")) {
      if (!isChoice(q)) this.openEditor(q, "value");
      else if (q.allowOther) this.openEditor(q, "other");
      return;
    }
    if (matchesKey(data, "?")) { this.startAssistance(q); return; }
    if (isChoice(q) && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      this.stopAssistance();
      this.error = "";
      state.cursorIndex = Math.max(0, Math.min(q.options.length - (q.allowOther ? 0 : 1), state.cursorIndex + (matchesKey(data, Key.up) ? -1 : 1)));
      this.followSelection = true;
      return;
    }
    const onOther = isChoice(q) && state.cursorIndex === q.options.length;
    if (matchesKey(data, Key.space) && isChoice(q)) {
      this.stopAssistance();
      if (onOther) this.openEditor(q, "other");
      else if (q.type === "multi") {
        const values = Array.isArray(state.value) ? state.value : [];
        const id = q.options[state.cursorIndex].id;
        this.model.change(q, { value: values.includes(id) ? values.filter(v => v !== id) : [...values, id], skipped: false });
        this.error = "";
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.stopAssistance();
      if (onOther && !state.other) { this.openEditor(q, "other"); return; }
      if (!isChoice(q) && (state.value === null || state.skipped)) { this.openEditor(q, "value"); return; }
      if (q.type === "single") this.model.change(q, {
        value: onOther ? null : q.options[state.cursorIndex].id,
        other: onOther ? state.other : "", skipped: false,
      });
      else if (state.skipped) this.model.change(q, { skipped: false });
      this.confirm(q);
    }
  }

  private tabBar(width: number): string {
    const tabs = [...this.model.visible().map(q => ({ id: q.id, label: `${this.model.states.get(q.id)!.confirmed ? "✓" : "○"} ${q.header}` })), { id: null, label: "Review" }];
    const style = (tab: typeof tabs[number]) => tab.id === this.active
      ? this.theme.bg("selectedBg", this.theme.fg("text", ` ${safeDisplay(tab.label).replace(/\s+/g, " ")} `))
      : this.theme.fg("muted", ` ${safeDisplay(tab.label).replace(/\s+/g, " ")} `);
    const all = tabs.map(style).join("│");
    if (visibleWidth(all) <= width) return all;
    const index = tabs.findIndex(tab => tab.id === this.active);
    // Active tab is always first in the condensed representation, never clipped behind other tabs.
    return `${style(tabs[index])} ${index + 1}/${tabs.length}${this.active === null ? "" : " · Review →"}`;
  }
  private footer(q?: Question): string {
    if (this.editing) {
      const format = this.editing === "value" && q ? ({ date: "YYYY-MM-DD", datetime: "YYYY-MM-DD HH:mm", time: "HH:mm (24-hour)" } as Record<string, string>)[q.type] : undefined;
      return `${format ? `${format} · ` : ""}Enter/Ctrl+S save · Shift+Enter newline · Esc discard · Ctrl+C cancel`;
    }
    if (!q) return "Enter/Ctrl+S submit · ←→/Tab edit question · PgUp/PgDn scroll · Esc cancel";
    const action = q.type === "multi" ? "Space toggle · Enter confirm" : isChoice(q) ? "Enter select/confirm · Space Other" : "Enter confirm/edit";
    return `${isChoice(q) ? "↑↓ options · " : ""}${action} · e edit · n note${q.required ? "" : " · s skip"} · ? explain · ←→/Tab tabs · PgUp/PgDn scroll · Esc/Ctrl+C cancel`;
  }
  render(width: number): string[] {
    width = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
    const rows = Math.max(0, Math.floor(this.tui.terminal?.rows ?? 24));
    if (!width || !rows || this.closed) return [];
    const q = this.question();
    const body: string[] = [];
    const plain = (text: string) => body.push(...wrapTextWithAnsi(safeDisplay(text), width));
    const markdown = (text: string) => body.push(...new Markdown(safeDisplay(text), 0, 0, getMarkdownTheme()).render(width));
    let selectedLine = 0;
    if (q) {
      const state = this.model.states.get(q.id)!;
      plain(`${q.question}${q.required ? " *" : " (optional)"}`);
      if (q.description) markdown(q.description);
      if (isChoice(q)) {
        const labels = [...q.options.map(o => o.label), ...(q.allowOther ? ["Other…"] : [])];
        labels.forEach((label, index) => {
          if (index === state.cursorIndex) selectedLine = body.length;
          const checked = index === q.options.length ? Boolean(state.other) : Array.isArray(state.value) ? state.value.includes(q.options[index].id) : state.value === q.options[index].id;
          plain(`${index === state.cursorIndex ? ">" : " "} [${checked ? "✓" : " "}] ${label}`);
        });
        const option = q.options[state.cursorIndex];
        if (option?.description) markdown(option.description);
        if (option?.preview) { plain("Preview:"); markdown(option.preview); }
        if (this.explanation) { plain("Explanation:"); markdown(this.explanation); }
      }
      plain(`${state.confirmed ? "Confirmed" : "Draft"}: ${answerText(q, state)}`);
      if (state.note) plain(`Note: ${state.note}`);
    } else {
      plain(this.model.result() ? "Ready to submit" : "Review — confirmation needed");
      for (const question of this.model.visible()) {
        const state = this.model.states.get(question.id)!;
        plain(`${state.confirmed ? "✓" : "○"} ${question.header}: ${question.question}`);
        plain(answerText(question, state));
        if (state.note) plain(`Note: ${state.note}`);
        body.push("");
      }
    }
    const top = `${this.tabBar(width)}${this.editing ? ` · Editing ${this.editing === "value" ? "answer" : this.editing}` : ""}`;
    const footer = wrapTextWithAnsi(this.theme.fg("dim", this.footer(q)), width)
      .slice(0, rows >= 6 && width >= 40 ? 3 : 1);
    const error = this.error ? this.theme.fg("warning", this.error) : "";
    let lines: string[];
    if (this.editing) {
      // Editor filters C0 paste controls itself; strip C1/DEL too without removing its ANSI styling.
      const editorLines = this.editor.render(width).map(line => line.replace(/[\x7f-\x9f]/g, ""));
      // Pi's Editor reserves at least five lines. Crop around its cursor on tiny terminals.
      const budget = Math.max(1, rows - (rows >= 3 ? 1 + footer.length : 0) - (error && rows >= 4 ? 1 : 0));
      const cursor = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(editorLines.length - budget, Math.max(0, cursor - budget + 1)));
      lines = editorLines.slice(start, start + budget);
      if (rows >= 3) lines = [top, ...lines, ...(error && rows >= 4 ? [error] : []), ...footer];
    } else {
      const budget = Math.max(0, rows - 1 - footer.length - (error && rows >= 4 ? 1 : 0));
      this.pageSize = Math.max(1, budget - 1);
      if (this.followSelection && budget) {
        if (selectedLine < this.scroll) this.scroll = selectedLine;
        else if (selectedLine >= this.scroll + budget) this.scroll = selectedLine - budget + 1;
        this.followSelection = false;
      }
      this.scroll = Math.max(0, Math.min(this.scroll, body.length - budget));
      lines = [top, ...body.slice(this.scroll, this.scroll + budget), ...(error && rows >= 4 ? [error] : []), ...footer];
    }
    return lines.slice(0, rows).map(line => {
      const cursor = line.indexOf(CURSOR_MARKER);
      if (cursor >= 0) {
        const column = visibleWidth(line.slice(0, cursor));
        if (column >= width) return sliceByColumn(line, column - width + 1, width);
      }
      return truncateToWidth(line, width, "");
    });
  }
}
