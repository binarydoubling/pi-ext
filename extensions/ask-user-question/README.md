# Ask User Question

The original compact tabbed `ask_user_question`, with multiline answers, notes, Markdown previews, conditional fields, strict date validation, and an explicit final review on the original **Submit** tab. Requires **Pi 0.84.2+ and native interactive TUI**. RPC/print mode returns `status: "unavailable"`; it never silently accepts defaults or disables the tool.

## Input

```json
{
  "questions": [
    {
      "id": "delivery",
      "header": "Delivery",
      "question": "How should we deliver this?",
      "description": "Choose a **delivery method**.",
      "type": "single",
      "options": [
        { "id": "now", "label": "Send now", "description": "No scheduled time." },
        { "id": "later", "label": "Schedule", "preview": "Review the message before scheduling." }
      ],
      "default": "later",
      "allowOther": false
    },
    {
      "id": "start",
      "header": "When",
      "question": "When should it be sent?",
      "type": "datetime",
      "when": { "questionId": "delivery", "equals": "later" }
    },
    {
      "id": "context",
      "header": "Context",
      "question": "Any additional context?",
      "type": "text",
      "required": false
    }
  ]
}
```

- **1–12 questions**, **1–12 options** per choice field. Unknown properties, duplicate IDs/labels, contradictory types, invalid defaults, and control codes are rejected—not silently repaired.
- `id` is a unique letter-led identifier, up to 48 ASCII letters/digits/underscores/hyphens. Omitted question IDs become `q1`, `q2`, etc. Omitted option IDs use their labels. `header` is at most 12 characters and defaults to `Q1`, `Q2`, etc.
- `type`: `single`, `multi`, `text`, `date`, `datetime`, or `time`. Omitted type is inferred from legacy `multiSelect`/`options`, otherwise `text`. Legacy `{question, header, options, multiSelect}` calls still work.
- Choice `default` uses an option ID (or label when no ID); `multi` uses an array. Text/date/time defaults are strings. Defaults remain drafts until explicitly confirmed.
- `required` defaults to `true`. Optional questions require explicit skip or confirmation. Choice fields permit custom answers unless `allowOther:false`; multi custom answers are additive.
- `minSelections` / `maxSelections`: optional positive integers for **multi** fields, within the number of options plus Other when allowed (at most 13). Other counts as one selection. The default minimum is one; use explicit skip for optional empty answers. Minimum is enforced on confirmation, maximum also blocks additional toggles/custom text. Defaults must satisfy both limits; partial multi drafts remain editable.
- `when: {questionId, equals}` references an **earlier** question. It matches a confirmed scalar or membership in a confirmed multi choice. `when: {questionId, other:true}` matches any confirmed nonempty custom answer; add `equals: "custom text"` to match that exact custom text instead. Other conditions require a choice parent with `allowOther:true`. Changing a parent resets all dependent answers and notes, even if the condition still matches. Newly visible fields start from their defaults as unconfirmed drafts.
- Dates: `YYYY-MM-DD`; datetimes: `YYYY-MM-DD HH:mm`; times: `HH:mm` (24-hour). Years 0001–9999, Gregorian leap years, real month lengths. These are **local civil values**, not timezone-converted timestamps. There is no graphical calendar picker.
- Question text: 1,000 characters; question description/option preview: 4,000; option description: 2,000; label: 200. Answers/custom text/notes: 10,000 each. Question descriptions and option descriptions/previews support Markdown. All option descriptions stay visible; previews appear beneath the highlighted option.

## Keys

| Key | Action |
| --- | --- |
| ← / → | Change visible question or Submit tab; never auto-confirm |
| Tab on “Type your own answer...” | Open the original inline editor |
| ↑ / ↓ | Highlight a visible option |
| `1`–`9` | Select a single choice or toggle a multi choice by its original number; Other opens the editor |
| `/` | Open inline search/filter by label and description (case-insensitive) |
| Enter / Esc in filter editor | Apply filter / discard filter edit |
| Esc with an applied filter | Clear filter without cancelling the form |
| F1 | Open/close keyboard help; Esc returns without losing an editor draft |
| Space | Toggle multi choice, or edit Other |
| Enter | Select/confirm answer and advance; **submit only on the Submit review screen** |
| `e` | Edit answer/custom text |
| `n` | Edit this question's note |
| `s` | Explicitly skip an optional question |
| Enter / Ctrl+S in editor | Save draft; answers validate before confirmation |
| Shift+Enter in editor | Insert newline; multiline paste is supported |
| Esc in editor | Discard just this edit |
| PageUp / PageDown | Scroll descriptions, previews, and full review answers/notes |
| `?` on an option | Request an explanation from the current model |
| Esc outside editor / Ctrl+C anywhere | Cancel the entire questionnaire, returning no answers |

Return to any question tab to edit before final submission. Clearing Other removes the custom answer and leaves a draft if nothing else is selected.

Filtering preserves original option numbers and all selections, including hidden ones. Hidden numbers do nothing; Other stays available even if no listed option matches. Arrow navigation visits only visible options. Filters are limited to 200 characters and reset on tab changes. Options 10–12 (and Other at 13) remain accessible with arrows. Digits in an editor are ordinary text. Help and filtering make no model requests; `?` retains its opt-in explanation behavior.

The separators, tab styling, numbered choices, descriptions, custom-answer preview, inline editor, and compact contextual footer preserve `779d11d6`'s UI. New editing shortcuts remain available without expanding that footer; **F1** shows them on demand. Filter UI appears only after `/`; selection-limit hints appear only when the caller specifies limits. A single-question form still has no tab strip, but now advances to the same review screen instead of immediately submitting; ← returns to edit. Defaults and tab navigation never count as confirmation.

Explanations are **opt-in model requests and may consume quota**. Only the current question, its description, and highlighted option are sent—not conversation history, answers, notes, tools, or credentials in the prompt. Output is limited to 768 tokens; requests time out after 30 seconds and are aborted on navigation/edit/close. Errors are generic and raw reasoning is never shown. Tool usage includes provider-reported usage available before close, including up to a 500ms grace period for cancelled requests; unresponsive providers may not report aborted-request usage. Explanations never change answers.

## Result

```json
{
  "status": "submitted",
  "cancelled": false,
  "answers": [
    { "id": "delivery", "value": "later", "skipped": false },
    { "id": "start", "value": "2028-02-29 09:30", "note": "Local time", "skipped": false },
    { "id": "context", "value": null, "skipped": true }
  ],
  "hiddenQuestionIds": []
}
```

Multi `value` is an array, never comma-joined. A custom answer is a separate `other` string (single custom answers have `value:null`); notes are separate `note` strings. Hidden questions are omitted and listed by ID. `cancelled`, `aborted`, and `unavailable` statuses return empty answer arrays and request workflow termination. **Stop on cancellation; do not infer approval or retry.** Output deliberately replaces the old question-text-keyed string map.

## Tests

From the repository root, with current Pi and Node 22.19+ installed:

```sh
npm run test:ask-user-question
pi --no-extensions -e ./extensions/ask-user-question/index.ts --list-models
```

Tests use Node's built-in runner and the installed Pi SDK, without installing a second Pi or making model calls. For a non-global installation, set `PI_TEST_CORE_DIR` to the installed `@earendil-works/pi-coding-agent` package directory. Tests cover validation, legacy calls, dates, value/Other conditions, selection limits, number shortcuts, filtering, help/draft preservation, notes/pastes, review gating, cancellation, narrow terminals, explanation isolation/errors/timeout/usage, and lifecycle races. `original-ui.snap.json` captures 11 states directly from `779d11d6` (only SDK import namespaces changed): tests compare complete visible lines and exact ANSI styling for original chrome/selection rows, including inline editing and Submit.

Original MIT attribution is retained in [LICENSE](LICENSE).
