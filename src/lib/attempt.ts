// Attempt state + sessionStorage persistence. Answers only ever get appended:
// there is no operation that edits or removes a locked answer.
import type { Answer, Mode, Question, QuestionBank } from "./types.ts";
import { gradeAnswer, isAnswerValid } from "./grade.ts";

export interface Attempt {
  v: 2 | 3;
  bankId: string;
  mode: Mode;
  /** Version 3 retries contain only these scored questions, in source order. */
  questionIds?: string[];
  /** Index of the question currently on screen. */
  index: number;
  /** Locked answers keyed by question id. */
  answers: Record<string, Answer>;
  finished: boolean;
  startedAt: number;
  /** Absolute deadline (ms epoch) for a timed exam; null when untimed. */
  endsAt: number | null;
  finishedAt: number | null;
  /** True when the attempt ended because the countdown hit zero. */
  timedOut: boolean;
}

const PREFIX = "exam-reviewer:attempt:";
const LEGACY_KEY = "exam-reviewer:attempt";

export function storageKey(bankId: string): string {
  return `${PREFIX}${bankId}`;
}

const owns = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function timerMs(bank: QuestionBank, mode: Mode): number | null {
  return mode === "exam" && bank.examTimerMinutes ? bank.examTimerMinutes * 60_000 : null;
}

export function newAttempt(bank: QuestionBank, mode: Mode, now: number = Date.now()): Attempt {
  const ms = timerMs(bank, mode);
  return {
    v: 2,
    bankId: bank.id,
    mode,
    index: 0,
    answers: {},
    finished: false,
    startedAt: now,
    endsAt: ms === null ? null : now + ms,
    finishedAt: null,
    timedOut: false,
  };
}

/** The playable questions for this attempt, retaining their original numbers. */
export function attemptQuestions(bank: QuestionBank, attempt: Attempt): Question[] {
  if (attempt.v === 2) return bank.questions;
  const ids = new Set(attempt.questionIds);
  return bank.questions.filter((q) => ids.has(q.id));
}

/** Start an untimed Prep run containing only missed scored questions. */
export function newIncorrectAttempt(bank: QuestionBank, previous: Attempt, now: number = Date.now()): Attempt | null {
  if (!previous.finished) return null;
  const questionIds = attemptQuestions(bank, previous)
    .filter((q) => !q.unscored && !gradeAnswer(q, previous.answers[q.id]))
    .map((q) => q.id);
  if (questionIds.length === 0) return null;
  return { ...newAttempt(bank, "prep", now), v: 3, questionIds };
}

export function isLocked(attempt: Attempt, questionId: string): boolean {
  return owns(attempt.answers, questionId);
}

/** Lock an answer for the current question. No-op if it's already locked or invalid. */
export function lockAnswer(bank: QuestionBank, attempt: Attempt, answer: Answer): Attempt {
  const q = attemptQuestions(bank, attempt)[attempt.index];
  if (!q || attempt.finished || isLocked(attempt, q.id) || !isAnswerValid(q, answer)) return attempt;
  return { ...attempt, answers: { ...attempt.answers, [q.id]: answer } };
}

/** Move forward. Only allowed once the current question is locked. */
export function advance(bank: QuestionBank, attempt: Attempt, now: number = Date.now()): Attempt {
  const questions = attemptQuestions(bank, attempt);
  const q = questions[attempt.index];
  if (!q || attempt.finished || !isLocked(attempt, q.id)) return attempt;
  const next = attempt.index + 1;
  if (next >= questions.length) return { ...attempt, finished: true, finishedAt: now };
  return { ...attempt, index: next };
}

/** Milliseconds left on a timed attempt (never negative); null when untimed. */
export function remainingMs(attempt: Attempt, now: number): number | null {
  if (attempt.endsAt === null) return null;
  return Math.max(0, attempt.endsAt - now);
}

/**
 * Finish a timed attempt whose deadline has passed. If the current question
 * has a valid, unsubmitted draft it is locked first; every question without a
 * locked answer then scores as incorrect. Otherwise returns the attempt as is.
 */
export function expireIfDue(bank: QuestionBank, attempt: Attempt, now: number, draft?: Answer | null): Attempt {
  if (attempt.finished || attempt.endsAt === null || now < attempt.endsAt) return attempt;
  const withDraft = draft ? lockAnswer(bank, attempt, draft) : attempt;
  return { ...withDraft, finished: true, timedOut: true, finishedAt: attempt.endsAt };
}

/** Time spent, capped at the timer length for timed attempts. */
export function timeUsedMs(bank: QuestionBank, attempt: Attempt, now: number = Date.now()): number {
  const end = attempt.finishedAt ?? now;
  const used = Math.max(0, end - attempt.startedAt);
  const cap = timerMs(bank, attempt.mode);
  return cap === null ? used : Math.min(used, cap);
}

export function formatClock(ms: number): string {
  // Minutes:seconds, minutes not wrapped into hours (a 60-minute exam starts at 60:00).
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function saveAttempt(bankId: string, attempt: Attempt | null): void {
  try {
    if (attempt) sessionStorage.setItem(storageKey(bankId), JSON.stringify(attempt));
    else sessionStorage.removeItem(storageKey(bankId));
  } catch {
    /* storage unavailable (private mode, quota): attempt just won't survive refresh */
  }
}

/** Restore a saved attempt, rejecting anything inconsistent with no-backtracking. */
export function loadAttempt(bank: QuestionBank): Attempt | null {
  let raw: string | null = null;
  try {
    sessionStorage.removeItem(LEGACY_KEY); // single-bank key from the first version
    raw = sessionStorage.getItem(storageKey(bank.id));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return validateAttempt(bank, JSON.parse(raw));
  } catch {
    return null;
  }
}

export function validateAttempt(bank: QuestionBank, value: unknown): Attempt | null {
  if (!value || typeof value !== "object") return null;
  const a = value as Partial<Attempt>;
  if ((a.v !== 2 && a.v !== 3) || a.bankId !== bank.id) return null;
  if (a.mode !== "prep" && a.mode !== "exam") return null;
  if (a.v === 2 && a.questionIds !== undefined) return null;
  if (a.v === 3) {
    if (a.mode !== "prep" || !Array.isArray(a.questionIds) || a.questionIds.length === 0) return null;
    const selected = new Set(a.questionIds);
    const canonical = bank.questions.filter((q) => selected.has(q.id) && !q.unscored).map((q) => q.id);
    if (canonical.length !== a.questionIds.length || canonical.some((id, i) => id !== a.questionIds![i])) return null;
  }
  const questions = attemptQuestions(bank, a as Attempt);
  const n = questions.length;
  if (typeof a.index !== "number" || !Number.isInteger(a.index) || a.index < 0 || a.index >= n) return null;
  if (!a.answers || typeof a.answers !== "object" || Array.isArray(a.answers)) return null;
  if (typeof a.startedAt !== "number" || !Number.isFinite(a.startedAt)) return null;
  const answers = a.answers as Record<string, Answer>;
  const ids = new Set(questions.map((q) => q.id));
  if (Object.keys(answers).some((k) => !ids.has(k))) return null;
  // Every question before the current one must be locked; nothing after it may be.
  for (let i = 0; i < n; i++) {
    const q = questions[i]!;
    const has = owns(answers, q.id);
    if (i < a.index && (!has || !isAnswerValid(q, answers[q.id]))) return null;
    if (i > a.index && has) return null;
    if (i === a.index && has && !isAnswerValid(q, answers[q.id])) return null;
  }
  // Timer must match this bank and mode.
  const ms = timerMs(bank, a.mode);
  let endsAt: number | null = null;
  if (ms !== null) {
    if (typeof a.endsAt !== "number" || !Number.isFinite(a.endsAt)) return null;
    if (a.endsAt - a.startedAt > ms + 1000 || a.endsAt < a.startedAt) return null;
    endsAt = a.endsAt;
  } else if (a.endsAt !== null && a.endsAt !== undefined) return null;

  const finished = a.finished === true;
  const timedOut = finished && a.timedOut === true;
  if (timedOut && endsAt === null) return null;
  // A normal finish requires the last question to be locked; a timeout may end early.
  if (finished && !timedOut && (a.index !== n - 1 || !owns(answers, questions[n - 1]!.id))) return null;
  return {
    v: a.v,
    bankId: bank.id,
    mode: a.mode,
    ...(a.v === 3 ? { questionIds: a.questionIds } : {}),
    index: a.index,
    answers,
    finished,
    startedAt: a.startedAt,
    endsAt,
    finishedAt: finished && typeof a.finishedAt === "number" ? a.finishedAt : null,
    timedOut,
  };
}

/** Lightweight status for course pages (no bank needed). */
export function peekStatus(bankId: string, now: number = Date.now()): { mode: Mode; index: number; finished: boolean; questionCount?: number } | null {
  try {
    const raw = sessionStorage.getItem(storageKey(bankId));
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<Attempt>;
    if ((a.v !== 2 && a.v !== 3) || a.bankId !== bankId || (a.mode !== "prep" && a.mode !== "exam") || typeof a.index !== "number") return null;
    const expired = typeof a.endsAt === "number" && now >= a.endsAt;
    return { mode: a.mode, index: a.index, finished: a.finished === true || expired, ...(a.v === 3 && Array.isArray(a.questionIds) ? { questionCount: a.questionIds.length } : {}) };
  } catch {
    return null;
  }
}
