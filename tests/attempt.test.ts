import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  advance, attemptQuestions, expireIfDue, formatClock, loadAttempt, lockAnswer, newAttempt, newIncorrectAttempt, peekStatus, remainingMs, saveAttempt, storageKey, timeUsedMs, validateAttempt,
} from "../src/lib/attempt.ts";
import type { Answer, ChoiceQuestion } from "../src/lib/types.ts";
import { bankFor } from "./helpers.ts";

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const store = new MemoryStorage();
(globalThis as unknown as { sessionStorage: MemoryStorage }).sessionStorage = store;
beforeEach(() => store.clear());

const m5 = bankFor("devnet", "module-5");
const softeng = bankFor("cs0025", "m3-m6-m7");
const mlA = bankFor("cs0075", "sa-3-mock-exam");
const mlB = bankFor("cs0075", "sa3-mock-set-b");
const T0 = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const right = (i: number, bank = m5): Answer => {
  const q = bank.questions[i]!;
  if (q.type === "matching") return { kind: "match", picks: Object.fromEntries(q.prompts.map((p) => [p.id, p.answer])) };
  if (q.type === "fill") return { kind: "fill", text: q.acceptedAnswers[0]! };
  return { kind: "choice", choiceIds: (q as ChoiceQuestion).choices.filter((c) => c.correct).map((c) => c.id) };
};
function play(bank = m5, upTo: number, start = newAttempt(bank, "exam", T0)) {
  let a = start;
  for (let i = 0; i < upTo; i++) a = advance(bank, lockAnswer(bank, a, right(i, bank)), T0 + 1000);
  return a;
}

test("CS0075 sets keep independent saved attempts and reject each other's state", () => {
  const a = play(mlA, 3);
  const b = play(mlB, 1, newAttempt(mlB, "prep", T0));
  assert.equal(storageKey(mlA.id), "exam-reviewer:attempt:cs0075-sa3-mock-exam");
  assert.notEqual(storageKey(mlA.id), storageKey(mlB.id));
  saveAttempt(mlA.id, a);
  assert.equal(loadAttempt(mlB), null);
  saveAttempt(mlB.id, b);
  assert.deepEqual(loadAttempt(mlA), a);
  assert.deepEqual(loadAttempt(mlB), b);
  assert.equal(validateAttempt(mlB, a), null);
  assert.equal(validateAttempt(mlA, b), null);
});

test("exam timer only on timed banks in exam mode", () => {
  assert.equal(newAttempt(m5, "exam", T0).endsAt, T0 + HOUR);
  assert.equal(newAttempt(m5, "prep", T0).endsAt, null);
  assert.equal(newAttempt(softeng, "exam", T0).endsAt, null);
  assert.equal(remainingMs(newAttempt(m5, "exam", T0), T0 + 5 * 60_000 + 48_000), 54 * 60_000 + 12_000);
  assert.equal(formatClock(54 * 60_000 + 12_000), "54:12");
  assert.equal(formatClock(HOUR), "60:00");
  assert.equal(formatClock(400), "00:01");
});

test("expireIfDue: before the deadline nothing changes", () => {
  const a = play(m5, 3);
  assert.equal(expireIfDue(m5, a, T0 + HOUR - 1, right(3)), a);
  const untimed = newAttempt(softeng, "exam", T0);
  assert.equal(expireIfDue(softeng, untimed, T0 + 10 * HOUR), untimed);
});

test("expireIfDue: deadline passed locks a valid draft, then finishes", () => {
  const a = play(m5, 5);
  const done = expireIfDue(m5, a, T0 + HOUR, right(5));
  assert.equal(done.finished, true);
  assert.equal(done.timedOut, true);
  assert.equal(done.finishedAt, T0 + HOUR);
  assert.equal(Object.keys(done.answers).length, 6);
  assert.ok(m5.questions[5]!.id in done.answers);
});

test("expireIfDue: invalid or missing draft is not locked; unanswered stay unanswered", () => {
  const a = play(m5, 5);
  const empty: Answer = { kind: "choice", choiceIds: [] };
  for (const d of [undefined, null, empty]) {
    const done = expireIfDue(m5, a, T0 + 2 * HOUR, d);
    assert.equal(done.finished, true);
    assert.equal(Object.keys(done.answers).length, 5);
  }
});

test("expireIfDue: does not double-lock an already locked current answer", () => {
  const a = lockAnswer(m5, play(m5, 2), right(2));
  const wrongDraft: Answer = { kind: "choice", choiceIds: [(m5.questions[2] as ChoiceQuestion).choices.find((c) => !c.correct)!.id] };
  const done = expireIfDue(m5, a, T0 + HOUR, wrongDraft);
  assert.deepEqual(done.answers[m5.questions[2]!.id], right(2));
});

test("expired attempts survive save/load; timeUsed caps at 60:00", () => {
  const done = expireIfDue(m5, play(m5, 4), T0 + HOUR + 5000);
  saveAttempt(m5.id, done);
  const back = loadAttempt(m5);
  assert.deepEqual(back, done);
  assert.equal(timeUsedMs(m5, back!), HOUR);
});

test("restore keeps remaining time (endsAt is absolute)", () => {
  const a = play(m5, 6);
  saveAttempt(m5.id, a);
  const back = loadAttempt(m5)!;
  assert.equal(back.index, 6);
  assert.equal(back.endsAt, T0 + HOUR);
  assert.equal(remainingMs(back, T0 + 10 * 60_000), 50 * 60_000);
});

test("storage keys are per assessment and do not clobber each other", () => {
  const m6 = bankFor("devnet", "module-6");
  saveAttempt(m5.id, play(m5, 3));
  saveAttempt(m6.id, play(m6, 1, newAttempt(m6, "prep", T0)));
  saveAttempt(softeng.id, play(softeng, 2, newAttempt(softeng, "exam", T0)));
  assert.equal(loadAttempt(m5)!.index, 3);
  assert.equal(loadAttempt(m6)!.index, 1);
  assert.equal(loadAttempt(m6)!.mode, "prep");
  assert.equal(loadAttempt(softeng)!.index, 2);
  assert.equal(storageKey(m5.id), "exam-reviewer:attempt:devnet-m5");
  assert.deepEqual(peekStatus(m5.id), { mode: "exam", index: 3, finished: false });
  saveAttempt(m5.id, null);
  assert.equal(loadAttempt(m5), null);
  assert.equal(loadAttempt(m6)!.index, 1);
});

test("restore rejects tampering: gaps, answers ahead, wrong bank, bad timer", () => {
  const a = play(m5, 4);
  assert.equal(validateAttempt(m5, { ...a, index: 6 }), null, "gap before current");
  assert.equal(validateAttempt(m5, { ...a, answers: { ...a.answers, [m5.questions[8]!.id]: right(8) } }), null, "answer ahead");
  assert.equal(validateAttempt(bankFor("devnet", "module-6"), a), null, "other bank");
  assert.equal(validateAttempt(m5, { ...a, endsAt: null }), null, "timed exam without deadline");
  assert.equal(validateAttempt(m5, { ...a, endsAt: a.startedAt + 5 * HOUR }), null, "deadline too far");
  assert.equal(validateAttempt(softeng, { ...newAttempt(softeng, "exam", T0), endsAt: T0 + HOUR }), null, "untimed bank with deadline");
  assert.equal(validateAttempt(m5, { ...a, finished: true }), null, "finished early without timeout");
});

test("normal finish: advance past the last question", () => {
  const done = play(m5, m5.questions.length);
  assert.equal(done.finished, true);
  assert.equal(done.timedOut, false);
  assert.equal(done.index, m5.questions.length - 1);
  saveAttempt(m5.id, done);
  assert.deepEqual(loadAttempt(m5), done);
});

test("retry contains only missed questions in source order and resumes after refresh", () => {
  let original = newAttempt(m5, "exam", T0);
  const missed = [0, 8];
  for (let i = 0; i < m5.questions.length; i++) {
    const q = m5.questions[i]!;
    let answer = right(i);
    if (missed.includes(i)) {
      answer = q.type === "matching"
        ? { kind: "match", picks: Object.fromEntries(q.prompts.map((p, j) => [p.id, j === 0 ? q.options.find((o) => o !== p.answer)! : p.answer])) }
        : { kind: "choice", choiceIds: [(q as ChoiceQuestion).choices.find((c) => !c.correct)!.id] };
    }
    original = advance(m5, lockAnswer(m5, original, answer), T0 + 1000);
  }
  const retry = newIncorrectAttempt(m5, original, T0 + 2000)!;
  assert.equal(retry.mode, "prep");
  assert.equal(retry.endsAt, null);
  assert.deepEqual(retry.questionIds, missed.map((i) => m5.questions[i]!.id));
  assert.deepEqual(attemptQuestions(m5, retry).map((q) => q.number), missed.map((i) => i + 1));
  saveAttempt(m5.id, retry);
  assert.deepEqual(loadAttempt(m5), retry);
  assert.deepEqual(peekStatus(m5.id), { mode: "prep", index: 0, finished: false, questionCount: 2 });
  const first = advance(m5, lockAnswer(m5, retry, right(0)), T0 + 3000);
  assert.equal(first.index, 1);
  assert.ok(first.answers[m5.questions[0]!.id]);
  assert.equal(first.answers[m5.questions[1]!.id], undefined);
  saveAttempt(m5.id, first);
  assert.deepEqual(loadAttempt(m5), first);
  const done = advance(m5, lockAnswer(m5, first, right(8)), T0 + 4000);
  assert.equal(done.finished, true);
  assert.deepEqual(loadAttempt(m5), first);
  saveAttempt(m5.id, done);
  assert.deepEqual(loadAttempt(m5), done);
  assert.equal(newIncorrectAttempt(m5, done), null);
});

test("retry includes unanswered timed-out questions but excludes unscored questions", () => {
  const expired = expireIfDue(m5, play(m5, 2), T0 + HOUR);
  const retry = newIncorrectAttempt(m5, expired)!;
  assert.deepEqual(retry.questionIds, m5.questions.slice(2).filter((q) => !q.unscored).map((q) => q.id));
  assert.equal(newIncorrectAttempt(m5, newAttempt(m5, "prep", T0)), null);

  const sa4 = bankFor("devnet", "sa4-mock-exam-set-a");
  assert.ok(sa4.questions.some((q) => q.unscored));
  const perfect = play(sa4, sa4.questions.length, newAttempt(sa4, "prep", T0));
  assert.equal(newIncorrectAttempt(sa4, perfect), null);
});

test("retry restore rejects altered selection, answer gaps, and answers outside selection", () => {
  const original = expireIfDue(m5, play(m5, 2), T0 + HOUR);
  const retry = newIncorrectAttempt(m5, original)!;
  const reversed = [...retry.questionIds!].reverse();
  assert.equal(validateAttempt(m5, { ...retry, questionIds: reversed }), null);
  assert.equal(validateAttempt(m5, { ...retry, questionIds: ["not-a-question"] }), null);
  assert.equal(validateAttempt(m5, { ...retry, questionIds: [m5.questions[1]!.id, m5.questions[2]!.id], answers: { [m5.questions[0]!.id]: right(0) } }), null);
  assert.equal(validateAttempt(m5, { ...retry, index: 2 }), null);
});
