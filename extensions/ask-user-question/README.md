# Ask User Question

The original compact tabbed `ask_user_question`, with multiline answers, notes, Markdown previews, conditional fields, strict date validation, and an explicit final Review tab. Requires **Pi 0.86+ and native interactive TUI**. RPC/print mode returns `status: "unavailable"`; it never silently accepts defaults or disables the tool.

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
- `when: {questionId, equals}` references an **earlier** question. It matches a confirmed scalar or membership in a confirmed multi choice. Changing a parent resets all dependent answers and notes, even if the condition still matches. Newly visible fields start from their defaults as unconfirmed drafts.
- Dates: `YYYY-MM-DD`; datetimes: `YYYY-MM-DD HH:mm`; times: `HH:mm` (24-hour). Years 0001–9999, Gregorian leap years, real month lengths. These are **local civil values**, not timezone-converted timestamps. There is no graphical calendar picker.
- Question text: 1,000 characters; question description/option preview: 4,000; option description: 2,000; label: 200. Answers/custom text/notes: 10,000 each. Question descriptions and selected-option descriptions/previews support Markdown.

## Keys

| Key | Action |
| --- | --- |
| ← / →, Tab / Shift+Tab | Change visible question or Review tab; never auto-confirm |
| ↑ / ↓ | Highlight option |
| Space | Toggle multi choice, or edit Other |
| Enter | Select/confirm answer and advance; **submit only on Review** |
| `e` | Edit answer/custom text |
| `n` | Edit this question's note |
| `s` | Explicitly skip an optional question |
| Enter / Ctrl+S in editor | Save draft; answers validate before confirmation |
| Shift+Enter in editor | Insert newline; multiline paste is supported |
| Esc in editor | Discard just this edit |
| PageUp / PageDown | Scroll descriptions, previews, and full Review answers/notes |
| `?` on an option | Request an explanation from the current model |
| Esc outside editor / Ctrl+C anywhere | Cancel the entire questionnaire, returning no answers |

Return to any question tab to edit before final submission. Clearing Other removes the custom answer and leaves a draft if nothing else is selected.

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

Tests use Node's built-in runner and the installed Pi SDK, without installing a second Pi or making model calls. For a non-global installation, set `PI_TEST_CORE_DIR` to the installed `@earendil-works/pi-coding-agent` package directory. Tests cover validation, legacy calls, dates, conditions, notes/pastes, review gating, cancellation, narrow terminals, explanation isolation/errors/timeout/usage, and lifecycle races.

Original MIT attribution is retained in [LICENSE](LICENSE).
