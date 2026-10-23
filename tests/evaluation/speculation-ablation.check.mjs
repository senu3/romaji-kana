import { test } from "node:test";
import assert from "node:assert/strict";
import { ablateSpeculationRequest, historicalSpeculationRequest, validateSpeculationAblation, immediateContext } from "./speculation-ablation.mjs";

test("ablation varies instructions and presentation without changing target, schema or generation options", () => {
  const request = { system: "existing rules", prompt: "Context before:\n前。\nOriginal input:\nkakuni。\nContext after:\n後。",
    outputSchema: { properties: { convertedText: {} } }, options: { temperature: 0.45 }, model: "test" };
  for (const instruction of ["current", "minimal-en", "minimal-ja", "contract"]) {
    const result = ablateSpeculationRequest(request, { instruction, presentation: "json" });
    assert.deepEqual(JSON.parse(result.prompt), { target: { originalInput: "kakuni。" }, context: { before: "前。", after: "後。" } });
    assert.equal(result.outputSchema, request.outputSchema);
    assert.equal(result.options, request.options);
    assert.equal(result.system === request.system, instruction === "current");
  }
  assert.equal(ablateSpeculationRequest(request, { instruction: "current", presentation: "text" }).prompt, request.prompt);
  assert.equal(ablateSpeculationRequest(request), request);
  assert.throws(() => validateSpeculationAblation({ instruction: "unknown", presentation: "json" }));
});

test("ablation retains immutable parts and refuses ambiguous field framing", () => {
  const parts = [{ literal: "A-1" }, { id: "edit-1", originalInput: "nokakuni。" }];
  const request = { system: "existing", prompt: "Context before:\n\nOriginal input (ordered parts):\n" + JSON.stringify(parts) + "\nContext after:\n",
    outputSchema: { properties: { segments: {} } } };
  const result = ablateSpeculationRequest(request, { instruction: "minimal-ja", presentation: "json" });
  assert.deepEqual(JSON.parse(result.prompt).target.parts, parts);
  assert.match(result.system, /supplied editable ID/);
  assert.throws(() => ablateSpeculationRequest({ ...request, prompt: request.prompt + "\nContext after:\n" }, { instruction: "contract", presentation: "json" }));
});

test("kana ablation converts only editable inputs and repair instructions retain the current output contract", () => {
  const suffix = 'Return only {"convertedText":"Japanese target","completedKana":"its hiragana reading"}.\nReading rules.';
  const request = { system: "Existing task.\n" + suffix,
    prompt: "Context before:\nromaji-context\nOriginal input:\nkakuni。\nContext after:\n後。", outputSchema: { properties: {} } };
  const converted = [];
  const toKana = text => { converted.push(text); return "かくに。"; };
  const result = ablateSpeculationRequest(request, { instruction: "repair-ja", presentation: "text", inputRepresentation: "kana" }, toKana);
  assert.match(result.prompt, /Original input:\nかくに。/);
  assert.match(result.prompt, /romaji-context/);
  assert.doesNotMatch(result.prompt, /kakuni/);
  assert.ok(result.system.endsWith(suffix));
  const contextual = ablateSpeculationRequest(request, { instruction: "context-repair-ja", presentation: "text", inputRepresentation: "kana" }, toKana);
  assert.equal(contextual.prompt, result.prompt);
  assert.equal(contextual.outputSchema, result.outputSchema);
  assert.ok(contextual.system.endsWith(suffix));
  assert.match(contextual.system, /文章全体の意味・話題・前後のつながり/);
  assert.match(contextual.system, /情報を勝手に追加しない/);
  const adjacent = ablateSpeculationRequest(request, { instruction: "adjacent-repair-ja", presentation: "text", inputRepresentation: "kana" }, toKana);
  assert.equal(adjacent.prompt, result.prompt);
  assert.ok(adjacent.system.endsWith(suffix));
  assert.match(adjacent.system, /直前・直後の文とのつながりを最優先/);
  assert.doesNotMatch(adjacent.system, /文章全体の意味/);
  assert.deepEqual(converted, ["kakuni。", "kakuni。", "kakuni。"]);
  const parts = [{ literal: "MR-62" }, { id: "edit-1", originalInput: "kakuni。" }];
  const segmented = ablateSpeculationRequest({ ...request, prompt: "Context before:\n\nOriginal input (ordered parts):\n" + JSON.stringify(parts) + "\nContext after:\n" },
    { instruction: "current", presentation: "json", inputRepresentation: "kana" }, toKana);
  assert.deepEqual(JSON.parse(segmented.prompt).target.parts, [{ literal: "MR-62" }, { id: "edit-1", originalInput: "かくに。" }]);
  assert.throws(() => ablateSpeculationRequest(request, { instruction: "current", presentation: "text", inputRepresentation: "kana" }));
});

test("one-sentence ablation removes distant context without altering target or rules", () => {
  const request = { system: "unchanged", prompt: "Context before:\n以前の話。直前の話。\nOriginal input:\nkakuni。\nContext after:\n直後の話。後の話。", outputSchema: { properties: {} } };
  const result = ablateSpeculationRequest(request, { instruction: "current", presentation: "json", contextWindow: "adjacent-one" });
  assert.deepEqual(JSON.parse(result.prompt), { target: { originalInput: "kakuni。" }, context: { before: "直前の話。", after: "直後の話。" } });
  assert.equal(result.system, request.system);
  assert.equal(result.outputSchema, request.outputSchema);
  assert.equal(immediateContext("", "before"), "");
  assert.equal(immediateContext("前文。途中の", "before"), "途中の");
});

test("historical experiments reconstruct their romaji reference after production adopts kana", () => {
  const request = { system: '採用した修整指示\nReturn only {"convertedText":"Japanese target"}.\nReading rules.',
    prompt: "Context before:\n前。\nOriginal input:\nかくに。\nContext after:\n後。", outputSchema: { properties: {} } };
  const historical = historicalSpeculationRequest(request, "kakuni。");
  assert.match(historical.prompt, /Original input:\nkakuni。/);
  assert.match(historical.system, /Generate one useful Japanese suggestion/);
  assert.equal(historical.outputSchema, request.outputSchema);
  const adoptedAgain = ablateSpeculationRequest(historical, { instruction: "repair-ja", presentation: "text", inputRepresentation: "kana" }, () => "かくに。");
  assert.equal(adoptedAgain.prompt, request.prompt);
  assert.match(adoptedAgain.system, /本来入力したかった内容/);
});
