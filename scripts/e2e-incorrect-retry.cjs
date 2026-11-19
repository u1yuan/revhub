// Browser walkthrough for results -> missed-question Prep retry -> refresh -> results.
// Start the app first, then run: node scripts/e2e-incorrect-retry.cjs
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..');
const base = process.env.BASE_URL || 'http://localhost:3000';
const chrome = process.env.CHROME_PATH || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => fs.existsSync(candidate));
const assessment = JSON.parse(fs.readFileSync(path.join(root, 'data/assessments/devnet-m5.json'), 'utf8'));
const pool = JSON.parse(fs.readFileSync(path.join(root, 'data/pools/devnet.json'), 'utf8'));
const byId = new Map(pool.questions.map((q) => [q.id, q]));
const questions = assessment.questionIds.map((id) => byId.get(id));

function answerFor(q, wrong = false) {
  if (q.type === 'matching') return { kind: 'match', picks: Object.fromEntries(q.prompts.map((p, i) => [p.id, wrong && i === 0 ? q.options.find((option) => option !== p.answer) : p.answer])) };
  if (q.type === 'fill') return { kind: 'fill', text: wrong ? 'WRONG' : q.acceptedAnswers[0] };
  return { kind: 'choice', choiceIds: wrong ? [q.choices.find((choice) => !choice.correct).id] : q.choices.filter((choice) => choice.correct).map((choice) => choice.id) };
}

(async () => {
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${base}/courses/devnet/module-5/`);
    const now = Date.now();
    const answers = Object.fromEntries(questions.map((q, i) => [q.id, answerFor(q, i === 0 || i === 8)]));
    await page.evaluate((attempt) => sessionStorage.setItem('exam-reviewer:attempt:devnet-m5', JSON.stringify(attempt)), {
      v: 2, bankId: 'devnet-m5', mode: 'prep', index: questions.length - 1, answers,
      finished: true, startedAt: now - 60_000, endsAt: null, finishedAt: now, timedOut: false,
    });
    await page.reload();
    await page.locator('.score__figure').waitFor();
    assert.match(await page.locator('.score__figure').innerText(), /16 \/ 18/);
    await page.getByRole('button', { name: 'Retry 2 incorrect questions' }).first().click();
    assert.match(await page.locator('.qcard__count').innerText(), /Question 1 of 2 · Original question 1/i);
    assert.equal(await page.locator('.timer').count(), 0);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('exam-reviewer:attempt:devnet-m5')).questionIds), [questions[0].id, questions[8].id]);
    await page.locator(`.choice input[value="${answerFor(questions[0]).choiceIds[0]}"]`).locator('..').click();
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.locator('.feedback--correct').waitFor();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.reload();
    assert.match(await page.locator('.qcard__count').innerText(), /Question 2 of 2 · Original question 9/i);
    for (const p of questions[8].prompts) await page.locator(`#match-${p.id}`).selectOption(p.answer);
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.getByRole('button', { name: /See results/ }).click();
    assert.match(await page.locator('.score__figure').innerText(), /2 \/ 2/);
    assert.equal(await page.getByRole('button', { name: /Retry .* incorrect question/ }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('Incorrect-answer retry browser walkthrough passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
