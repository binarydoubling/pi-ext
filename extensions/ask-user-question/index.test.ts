import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, ModelRegistry } from "@earendil-works/pi-coding-agent";
import register, { explainOption } from "./index.ts";
import { normalizeInput } from "./schema.ts";

initTheme("dark", false);
const { theme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const questions = [{ id: "pick", question: "Choose", options: [{ label: "One" }, { label: "Two" }], default: "One" }];
const params = { questions };
const usage = { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 37, reasoning: 2, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } };
const response = { stopReason: "stop", content: [{ type: "thinking", thinking: "SECRET REASONING" }, { type: "text", text: "Useful explanation" }], usage };
function tool() {
  let definition: any;
  register({ registerTool: (t: unknown) => { definition = t; } } as any);
  return definition;
}
function context(interact?: (ui: any) => void, complete: () => Promise<any> = async () => response) {
  let calls = 0;
  const ctx: any = { mode: "tui", model: { id: "test-model" }, modelRegistry: { complete: () => { calls++; return complete(); } }, ui: {
    custom: (factory: any) => new Promise(resolve => {
      const ui = factory({ requestRender() {}, terminal: { rows: 24, columns: 80 } }, theme, {}, resolve);
      queueMicrotask(() => interact?.(ui));
    }),
  } };
  return { ctx, calls: () => calls };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("registers sequential original tool, no UI never deregisters or accepts defaults", async () => {
  assert.equal(typeof ModelRegistry.prototype.complete, "function", "installed SDK supports the model request API");
  const t = tool(); assert.equal(t.name, "ask_user_question"); assert.equal(t.executionMode, "sequential");
  for (const mode of ["rpc", "print"]) {
    const { ctx, calls } = context(); ctx.mode = mode; ctx.hasUI = true;
    ctx.ui.custom = () => { throw new Error("Must not open"); };
    const result = await t.execute("id", params, undefined, undefined, ctx);
    assert.equal(result.details.status, "unavailable"); assert.deepEqual(result.details.answers, []); assert.equal(result.terminate, true); assert.equal(calls(), 0);
  }
});

test("abort before open and during UI returns no partial answer and cannot submit twice", async () => {
  const before = new AbortController(); before.abort();
  const a = context(() => { throw new Error("Must not open"); });
  assert.equal((await tool().execute("id", params, before.signal, undefined, a.ctx)).details.status, "aborted");
  const during = new AbortController();
  const b = context(ui => { ui.handleInput("\r"); during.abort(); ui.handleInput("\r"); });
  const result = await tool().execute("id", params, during.signal, undefined, b.ctx);
  assert.equal(result.details.status, "aborted"); assert.deepEqual(result.details.answers, []); assert.equal(b.calls(), 0);
});

test("undefined custom result is unavailable; strict schema errors occur before UI", async () => {
  const { ctx } = context(); ctx.ui.custom = async () => undefined;
  assert.equal((await tool().execute("id", params, undefined, undefined, ctx)).details.status, "unavailable");
  ctx.ui.custom = () => { throw new Error("Must not open"); };
  await assert.rejects(tool().execute("id", { questions: [{ question: "Date", type: "datetime", default: "4000-22-10 13:00" }] }, undefined, undefined, ctx), /invalid default/);
});

test("abort race during UI mounting is handled without completing the unmounted component", async () => {
  const controller = new AbortController(); let mounted = false;
  const { ctx } = context();
  ctx.ui.custom = (factory: any) => new Promise(resolve => {
    controller.abort();
    factory({ requestRender() {} }, theme, {}, (r: unknown) => { assert.equal(mounted, true); resolve(r); });
    mounted = true;
  });
  assert.equal((await tool().execute("id", params, controller.signal, undefined, ctx)).details.status, "aborted");
});

test("explanation has isolated bounded context, hides thinking and reports usage", async () => {
  const [q] = normalizeInput(params);
  let reported: unknown;
  const { ctx } = context();
  ctx.modelRegistry.complete = async (model: unknown, input: any, options: any) => {
    assert.equal(model, ctx.model);
    assert.equal(input.messages.length, 1); assert.equal(input.tools, undefined);
    const data = JSON.parse(input.messages[0].content[0].text);
    assert.deepEqual(Object.keys(data).sort(), ["option", "question"]);
    assert.equal(data.default, undefined); assert.equal(data.answers, undefined); assert.equal(data.notes, undefined);
    assert.equal(options.maxTokens, 768); assert.equal(options.maxRetries, 0);
    assert.equal(options.signal instanceof AbortSignal, true); assert.equal(options.timeoutMs, 30000);
    return response;
  };
  assert.equal(await explainOption(ctx, q, q.options[0], new AbortController().signal, u => { reported = u; }), "Useful explanation");
  assert.deepEqual(reported, usage);
});

test("submitted result accounts opt-in explanation usage but not reasoning or explanations in answers", async () => {
  const { ctx, calls } = context(async ui => {
    ui.handleInput("?"); await flush(); ui.handleInput("?"); await flush();
    ui.handleInput("\r"); ui.handleInput("\r");
  });
  const result = await tool().execute("id", params, undefined, undefined, ctx);
  assert.equal(calls(), 2); assert.equal(result.usage.input, 20); assert.equal(result.usage.reasoning, 4); assert.equal(result.usage.cost.total, 20);
  assert.equal(result.details.status, "submitted"); assert.equal(result.details.answers[0].value, "One");
  assert.equal(result.terminate, undefined); assert.doesNotMatch(JSON.stringify(result), /SECRET|Useful explanation/);
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test("cancel aborts nested requests and collects reported aborted usage", async () => {
  let signal!: AbortSignal;
  const { ctx } = context(async ui => { ui.handleInput("?"); await flush(); ui.handleInput("\x1b"); });
  ctx.modelRegistry.complete = (_model: any, _input: any, options: any) => {
    signal = options.signal;
    return new Promise(resolve => signal.addEventListener("abort", () => resolve({ ...response, stopReason: "aborted" }), { once: true }));
  };
  const result = await tool().execute("id", params, undefined, undefined, ctx);
  assert.equal(signal.aborted, true); assert.equal(result.details.status, "cancelled"); assert.deepEqual(result.details.answers, []);
  assert.deepEqual(result.usage, usage); assert.doesNotMatch(JSON.stringify(result), /SECRET|Useful explanation/);
});

test("cancellation stays bounded with an uncooperative provider", async () => {
  const { ctx } = context(async ui => { ui.handleInput("?"); await flush(); ui.handleInput("\x1b"); }, () => new Promise(() => {}));
  const start = Date.now();
  const result = await tool().execute("id", params, undefined, undefined, ctx);
  assert.equal(result.details.status, "cancelled"); assert.ok(Date.now() - start < 2000); assert.equal(result.usage, undefined);
});
