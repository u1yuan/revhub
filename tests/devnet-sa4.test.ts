import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { bankFor, loadData } from "./helpers.ts";
import { gradeAnswer, scoreAttempt } from "../src/lib/grade.ts";
import { newAttempt, storageKey, timerMs, validateAttempt } from "../src/lib/attempt.ts";
import type { Answer } from "../src/lib/types.ts";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const html = readFileSync(new URL("../public/reviewers/devnet-sa4-reviewer.html", import.meta.url), "utf8");
const sourceSections = JSON.parse(html.match(/<script id="quiz-data"[^>]*>(.*?)<\/script>/s)![1]!);
const sourceA = sourceSections.filter((b: { section?: string }) => b.section === "summative").flatMap((b: { questions: unknown[] }) => b.questions) as any[];
const sourceJson = read("../public/reviewers/devasc-m7-m8-question-bank.json");
const sourceB = sourceJson.items.filter((q: { type: string }) => q.type === "mcq") as any[];
const a = bankFor("devnet", "sa4-mock-exam-set-a");
const b = bankFor("devnet", "sa4-mock-exam-set-b");

test("SA4 imports preserve source order, text, choices, keys, explanations, and unscored flags", () => {
  assert.equal(sourceA.length, 79);
  assert.deepEqual(a.questions.map((q) => q.id), sourceA.map((q) => q.id));
  for (const [i, q] of a.questions.entries()) {
    const src = sourceA[i]!;
    assert.equal(q.prompt, src.stem, q.id);
    assert.deepEqual(q.choices.map((c) => ({ text: c.text, correct: c.correct })), src.options.map((o: any) => ({ text: o.text, correct: o.correct })), q.id);
    assert.equal(q.unscored, src.unscored || undefined, q.id);
    if (src.references) for (const ref of src.references) assert.ok(q.explanation?.includes(ref.url), q.id);
  }
  assert.deepEqual(a.questions.filter((q) => q.unscored).map((q) => q.id), ["s5q42", "s6q26"]);
  assert.equal(a.questionCount, 79);
});

test("Set B imports all MCQs in order and preserves exhibits and multi-select keys", () => {
  assert.equal(sourceB.length, 52);
  assert.deepEqual(b.questions.map((q) => q.id), sourceB.map((q) => q.id));
  for (const [i, q] of b.questions.entries()) {
    const src = sourceB[i]!;
    assert.equal(q.prompt, src.question, q.id);
    assert.deepEqual(q.choices.map((c) => c.text), src.choices, q.id);
    assert.deepEqual(q.choices.filter((c) => c.correct).map((c) => c.text), src.correct_answers, q.id);
    for (const ref of src.sources ?? []) assert.ok(q.explanation?.includes(ref), q.id);
  }
  assert.equal(b.questions.filter((q) => q.type === "multi").length, 11);
  assert.deepEqual(b.questions.filter((q) => q.exhibits).map((q) => q.id), ["m7-exam-12", "m8-exam-06", "m8-quiz-08"]);
  for (const q of b.questions.filter((x) => x.exhibits)) assert.ok(statSync(new URL(`../public${q.exhibits![0]!.src}`, import.meta.url)).size > 100, q.id);
});

test("SA4 scoring excludes unscored questions; timers and independent attempts remain native", () => {
  const answersA: Record<string, Answer> = {};
  for (const q of a.questions) answersA[q.id] = { kind: "choice", choiceIds: q.choices.filter((c) => c.correct).map((c) => c.id) };
  assert.deepEqual(scoreAttempt(a.questions, answersA), { correct: 77, total: 77, percent: 100 });
  const multi = b.questions.filter((q) => q.type === "multi");
  const answersB: Record<string, Answer> = {};
  for (const q of b.questions) answersB[q.id] = { kind: "choice", choiceIds: q.choices.filter((c) => c.correct).map((c) => c.id) };
  assert.deepEqual(scoreAttempt(b.questions, answersB), { correct: 52, total: 52, percent: 100 });
  for (const q of multi) {
    const key = q.choices.filter((c) => c.correct).map((c) => c.id);
    assert.equal(gradeAnswer(q, { kind: "choice", choiceIds: key }), true, q.id);
    assert.equal(gradeAnswer(q, { kind: "choice", choiceIds: key.slice(1) }), false, q.id);
  }
  assert.equal(timerMs(a, "prep"), null);
  assert.equal(timerMs(a, "exam"), 60 * 60_000);
  assert.notEqual(storageKey(a.id), storageKey(b.id));
  assert.equal(validateAttempt(a, newAttempt(b, "exam")), null);
  assert.equal(validateAttempt(b, newAttempt(a, "exam")), null);
});

test("catalog contains six DevNet assessments and ten assessments overall", () => {
  const data = loadData();
  assert.equal(data.catalog.courses.find((c) => c.id === "devnet")!.assessments.length, 6);
  assert.equal(data.catalog.courses.reduce((n, c) => n + c.assessments.length, 0), 10);
});
