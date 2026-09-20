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
type EditField = "value" | "other" | "note" | "filter";

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
  private filter = "";
  private helpOpen = false;
  private helpScroll = 0;
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
    });
    editor.disableSubmit = true;
    editor.onChange = () => {
      this.error = "";
      if (this.editing === "filter") { this.alignCursor(); this.scroll = 0; }
      this.tui.requestRender();
    };
    return editor;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && Boolean(this.editing) && !this.helpOpen;
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
  private filterText(): string {
    return safeDisplay(this.editing === "filter" ? this.editor.getExpandedText() : this.filter).slice(0, 200).replace(/\s+/g, " ").trim();
  }
  private optionIndices(q: Question): number[] {
    const query = this.filterText().toLocaleLowerCase();
    const indices = q.options.flatMap((option, index) => `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(query) ? [index] : []);
    if (q.allowOther) indices.push(q.options.length);
    return indices;
  }
  private alignCursor(): void {
    const q = this.question();
    if (!q || !isChoice(q)) return;
    const indices = this.optionIndices(q);
    const state = this.model.states.get(q.id)!;
    if (!indices.includes(state.cursorIndex)) state.cursorIndex = indices[0] ?? -1;
    this.followSelection = true;
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
    this.filter = "";
    this.alignCursor();
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
    const state = this.model.states.get(q.id)!;
    if (field === "other") state.cursorIndex = q.options.length;
    const value = field === "filter" ? this.filter : state[field];
    this.editor.setText(safeDisplay(typeof value === "string" ? value : ""));
    this.editor.focused = this.focused;
  }
  private closeEditor(): void {
    this.editing = undefined;
    this.editor.focused = false;
    this.editor = this.createEditor();
    this.error = "";
    this.alignCursor();
  }
  private saveEditor(q: Question): void {
    const field = this.editing!;
    const input = this.editor.getExpandedText();
    if (field === "filter") {
      if (input.length > 200 || safeDisplay(input) !== input) { this.error = "Filter must be at most 200 characters, without control codes."; return; }
      this.filter = this.filterText();
      this.closeEditor();
      return;
    }
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
      // Multi custom text is still a draft: enforce its maximum now, minimum on confirmation.
      : answerError(q.type === "multi" ? { ...q, minSelections: 1 } : q, { ...state, ...patch }) ?? "";
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
    if (matchesKey(data, Key.f1)) {
      this.helpOpen = !this.helpOpen;
      this.helpScroll = 0;
      if (this.helpOpen) this.stopAssistance();
      this.focused = this.hasFocus;
      return;
    }
    if (this.helpOpen) {
      if (matchesKey(data, Key.escape)) { this.helpOpen = false; this.focused = this.hasFocus; }
      else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) this.helpScroll = Math.max(0, this.helpScroll + (matchesKey(data, Key.pageUp) ? -1 : 1) * this.pageSize);
      return;
    }
    if (this.editing && q) {
      if (matchesKey(data, Key.escape)) this.closeEditor();
      else if (matchesKey(data, Key.shift(Key.enter))) this.editor.insertTextAtCursor("\n");
      else if (matchesKey(data, Key.enter) || matchesKey(data, Key.ctrl("s"))) this.saveEditor(q);
      else this.editor.handleInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.filter) { this.filter = ""; this.alignCursor(); this.scroll = 0; }
      else this.finish(cancelledResult("cancelled"));
      return;
    }
    const tabs = [...this.model.visible().map(q => q.id), null];
    if (q && isChoice(q) && q.allowOther && this.model.states.get(q.id)!.cursorIndex === q.options.length && matchesKey(data, Key.tab)) {
      this.openEditor(q, "other");
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const delta = matchesKey(data, Key.left) ? -1 : 1;
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
    if (isChoice(q) && matchesKey(data, "/")) { this.openEditor(q, "filter"); return; }
    const digit = isChoice(q) ? (["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const).find(n => matchesKey(data, n)) : undefined;
    if (digit !== undefined) {
      const index = Number(digit) - 1;
      if (!this.optionIndices(q).includes(index)) return;
      state.cursorIndex = index;
      this.followSelection = true;
      if (index === q.options.length) { this.openEditor(q, "other"); return; }
      data = q.type === "multi" ? " " : "\r"; // Use the same validated path as Space/Enter.
    }
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
      const indices = this.optionIndices(q);
      const position = Math.max(0, indices.indexOf(state.cursorIndex));
      state.cursorIndex = indices[Math.max(0, Math.min(indices.length - 1, position + (matchesKey(data, Key.up) ? -1 : 1)))] ?? -1;
      this.followSelection = true;
      return;
    }
    const onOther = isChoice(q) && state.cursorIndex === q.options.length;
    if (isChoice(q) && state.cursorIndex < 0) return;
    if (matchesKey(data, Key.space) && isChoice(q)) {
      this.stopAssistance();
      if (onOther) this.openEditor(q, "other");
      else if (q.type === "multi") {
        const values = Array.isArray(state.value) ? state.value : [];
        const id = q.options[state.cursorIndex].id;
        if (!values.includes(id) && q.maxSelections !== undefined && values.length + Number(Boolean(state.other)) >= q.maxSelections) {
          this.error = `Select at most ${q.maxSelections} choices (Other counts as one).`;
          return;
        }
        this.model.change(q, { value: values.includes(id) ? values.filter(v => v !== id) : [...values, id], skipped: false });
        this.error = "";
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.stopAssistance();
      if (onOther && !state.other) return; // Original Other uses Space/Tab to open; Enter confirms saved text.
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
    const t = this.theme;
    const tabs = this.model.visible().map(q => {
      const header = truncateToWidth(safeDisplay(q.header).replace(/\s+/g, " "), 12);
      return { id: q.id as string | null, styled: q.id === this.active
        ? t.bg("selectedBg", t.fg("text", ` ${header} `))
        : this.model.states.get(q.id)!.confirmed
          ? t.fg("success", ` ■${header} `) : t.fg("muted", `  ${header} `) };
    });
    const label = " ✓ Submit ";
    tabs.push({ id: null, styled: this.active === null
      ? t.bg("selectedBg", t.fg("text", label))
      : t.fg(this.model.result() ? "success" : "dim", label) });
    const all = " " + tabs.map(tab => tab.styled).join("");
    if (visibleWidth(all) <= width) return all;
    // Only condense when the original strip would hide the active tab.
    const index = tabs.findIndex(tab => tab.id === this.active);
    if (visibleWidth(" " + tabs.slice(0, index + 1).map(tab => tab.styled).join("")) <= width) return all;
    return ` ${tabs[index].styled} ${index + 1}/${tabs.length}`;
  }
  private footer(q?: Question): string {
    if (this.helpOpen) return " F1/Esc back · PgUp/PgDn scroll · Ctrl+C cancel";
    if (this.editing === "filter") return " Enter apply filter · Esc back";
    if (this.editing) return " Enter submit · Esc back";
    if (!q) return " ←→ switch tabs · Esc cancel";
    const tabHint = this.model.visible().length === 1 ? "" : " · ←→ switch tabs";
    const action = isChoice(q)
      ? this.model.states.get(q.id)!.cursorIndex === q.options.length
        ? "Space/Tab open editor" : q.type === "multi" ? "Space toggle · Enter confirm" : "Enter select"
      : "Enter confirm/edit · e edit · n note";
    return ` ${isChoice(q) ? "↑↓ navigate · " : ""}${action}${tabHint}${q.required ? "" : " · s skip"} · Esc cancel`;
  }
  render(width: number): string[] {
    width = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
    const rows = Math.max(0, Math.floor(this.tui.terminal?.rows ?? 24));
    if (!width || !rows || this.closed) return [];
    const t = this.theme;
    const q = this.question();
    const body: string[] = [];
    const wrap = (text: string, inset = 0) => body.push(...wrapTextWithAnsi(text, Math.max(1, width - inset)));
    const markdown = (text: string, indent: number) => {
      const lines = new Markdown(safeDisplay(text), 0, 0, getMarkdownTheme(), { color: s => t.fg("muted", s) }).render(Math.max(1, width - indent));
      body.push(...lines.map(line => " ".repeat(indent) + line));
    };
    let selectedLine = 0;
    if (this.helpOpen) {
      body.push(t.fg("text", t.bold(" Keyboard shortcuts")), "");
      for (const line of [
        "←→ switch questions / Submit · ↑↓ highlight options",
        "1–9 select a single choice or toggle a multi choice (original option numbers)",
        "Space toggle multi · Space/Tab on Other opens the inline editor",
        "Enter confirms an answer; only Enter on Submit sends the form",
        "/ filter choices by label/description · Enter apply · Esc discard edit",
        "Esc clears an applied filter first; hidden selections are kept",
        "e edit answer/custom text · n edit note · s skip optional question",
        "? explain highlighted option (opt-in model request; uses quota)",
        "Editor: Enter/Ctrl+S save · Shift+Enter newline · Esc discard edit",
        "PgUp/PgDn scroll long content · F1 opens/closes this help",
        "Esc cancels outside editor/filter/help · Ctrl+C cancels anywhere",
      ]) wrap(t.fg("muted", ` ${line}`));
    } else if (q) {
      const state = this.model.states.get(q.id)!;
      wrap(t.fg("text", ` ${safeDisplay(q.question)}`), 2);
      if (q.description) markdown(q.description, 1);
      if (q.minSelections !== undefined || q.maxSelections !== undefined) wrap(t.fg("dim", ` Select ${q.minSelections !== undefined ? `at least ${q.minSelections}` : "at least 1"}${q.maxSelections !== undefined ? `, at most ${q.maxSelections}` : ""} choices; Other counts as one.`));
      if (this.filter && this.editing !== "filter") wrap(t.fg("muted", ` Filter: ${this.filter} · Esc clear`));
      body.push("");
      if (isChoice(q)) {
        const opts = [...q.options, ...(q.allowOther ? [{ id: "", label: "Type your own answer..." }] : [])];
        const indent = q.type === "multi" ? 7 : 5;
        const indices = this.optionIndices(q);
        if (!indices.some(index => index < q.options.length)) body.push(t.fg("muted", " No matching options."));
        opts.forEach((opt, index) => {
          if (!indices.includes(index)) return;
          const selected = index === state.cursorIndex;
          const other = index === q.options.length;
          const editingOther = other && this.editing === "other";
          const checked = other ? Boolean(state.other) && !editingOther
            : Array.isArray(state.value) ? state.value.includes(opt.id) : state.value === opt.id;
          if (selected) selectedLine = body.length;
          const prefix = selected ? t.fg("accent", ">") : " ";
          const mark = q.type === "multi"
            ? checked ? t.fg(other ? "success" : "accent", "[✓]") : t.fg("dim", "[ ]")
            : checked ? t.fg("success", "✓") : " ";
          const label = t.fg(selected ? "accent" : other ? "muted" : "text", `${index + 1}. ${safeDisplay(opt.label).replace(/\s+/g, " ")}`);
          body.push(`${prefix} ${mark} ${label}${editingOther ? t.fg("accent", " ✎") : ""}`);
          if (other && checked) {
            const preview = truncateToWidth(safeDisplay(state.other).replace(/\s+/g, " "), Math.max(1, width - indent));
            body.push(" ".repeat(indent) + t.fg("dim", `"${preview}"`));
          }
          if (opt.description) markdown(opt.description, indent);
          if (selected && opt.preview) markdown(opt.preview, indent);
        });
        if (this.explanation) { body.push(""); markdown(this.explanation, 1); }
      } else if (this.editing !== "value") {
        wrap(t.fg("muted", " Your answer: ") + t.fg("text", safeDisplay(answerText(q, state))));
      }
      if (state.note && this.editing !== "note") wrap(t.fg("muted", ` Note: ${safeDisplay(state.note)}`));
      if (this.editing) {
        body.push("", t.fg("muted", this.editing === "filter" ? " Filter options:" : this.editing === "note" ? " Your note:" : " Your answer:"));
        if (this.editing === "value" && q.type !== "text") {
          body.push(t.fg("dim", ` ${q.type === "date" ? "YYYY-MM-DD" : q.type === "time" ? "HH:mm (24-hour)" : "YYYY-MM-DD HH:mm (24-hour)"}`));
        }
        const editorLines = this.editor.render(Math.max(1, width - 4)).map(line => " " + line.replace(/[\x7f-\x9f]/g, ""));
        const cursor = editorLines.findIndex(line => line.includes(CURSOR_MARKER));
        selectedLine = body.length + Math.max(0, cursor);
        body.push(...editorLines);
      }
    } else {
      const ready = Boolean(this.model.result());
      body.push(t.fg(ready ? "success" : "warning", t.bold(ready ? " Ready to submit" : " Unanswered questions")), "");
      for (const question of this.model.visible()) {
        const state = this.model.states.get(question.id)!;
        const answer = isChoice(question) && !state.skipped
          ? [...question.options.filter(o => Array.isArray(state.value) ? state.value.includes(o.id) : state.value === o.id).map(o => o.label), ...(state.other ? [state.other] : [])].join(", ")
          : answerText(question, state);
        wrap(t.fg(state.confirmed ? "muted" : "dim", ` ${truncateToWidth(safeDisplay(question.header), 12)}: `)
          + t.fg(state.confirmed ? "text" : "warning", state.confirmed ? safeDisplay(answer) : "—"));
        if (state.note) wrap(t.fg("muted", `   Note: ${safeDisplay(state.note)}`));
      }
      body.push("");
      wrap(ready ? t.fg("success", " Press Enter to submit") : t.fg("warning", ` Still needed: ${this.model.visible().filter(q => !this.model.states.get(q.id)!.confirmed).map(q => safeDisplay(q.header)).join(", ")}`));
    }
    // Original chrome and compact height. Only overflow introduces a viewport.
    const separator = t.fg("accent", "─".repeat(width));
    let head = [separator, ...(this.model.visible().length > 1 ? [this.tabBar(width), ""] : [])];
    let tail = ["", ...(this.error ? [t.fg("warning", ` ${this.error}`)] : []), t.fg("dim", this.footer(q)), separator];
    if (head.length + tail.length >= rows) {
      head = [];
      tail = rows >= 4 ? [...(this.error ? [t.fg("warning", ` ${this.error}`)] : []), t.fg("dim", this.footer(q))] : [];
    }
    const budget = Math.max(1, rows - head.length - tail.length);
    this.pageSize = Math.max(1, budget - 1);
    let scroll = this.helpOpen ? this.helpScroll : this.scroll;
    if (!this.helpOpen && (this.editing || this.followSelection)) {
      if (selectedLine < scroll) scroll = selectedLine;
      else if (selectedLine >= scroll + budget) scroll = selectedLine - budget + 1;
      this.followSelection = false;
    }
    scroll = Math.max(0, Math.min(scroll, body.length - budget));
    if (this.helpOpen) this.helpScroll = scroll;
    else this.scroll = scroll;
    const lines = [...head, ...body.slice(scroll, scroll + budget), ...tail];
    return lines.slice(0, rows).map(line => {
      const cursor = line.indexOf(CURSOR_MARKER);
      if (cursor >= 0) {
        const column = visibleWidth(line.slice(0, cursor));
        if (column >= width) return sliceByColumn(line, column - width + 1, width);
      }
      return truncateToWidth(line, width);
    });
  }
}
