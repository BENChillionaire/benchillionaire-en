import { appendFile } from "node:fs/promises";
import { LETTERS, type McQuestion } from "./corpus";
import { pack, pool, type DecisionClient, type DecisionItem } from "./decide";

/** Ladder-position ranges; a question's own position on its own ladder decides its range. */
export const RANGES = [
  { id: "1-5", lo: 1, hi: 5 },
  { id: "6-10", lo: 6, hi: 10 },
  { id: "11-15", lo: 11, hi: 15 },
  { id: "16+", lo: 16, hi: Infinity },
] as const;

/** A wrong answer is a close call when the aired answer's probability is within this margin of the chosen one. */
export const CLOSE_CALL_MARGIN = 0.1;

export function inRange(q: McQuestion, range: (typeof RANGES)[number]): boolean {
  return q.number !== null && q.number >= range.lo && q.number <= range.hi;
}

interface CloseCall {
  key: string;
  answer: string;
  choice: string;
  pChoice: number;
  pAnswer: number;
}

/** Request state for question batches: the guidance every question shares. */
export const QUESTION_CONTEXT =
  "Each question has exactly one correct option. Questions may rely on wordplay. Answer each as of the year it was asked and for the country it was asked in, when given.";

/** Corpus country names that read with "the" ("Asked in the UK in 2004."). */
const WITH_THE: Record<string, true> = { UK: true, USA: true };

/** Where and when a question was asked, as the model is told it: "(Asked in India in 2004.)"; empty when neither is known. */
export function askedNote(q: Pick<McQuestion, "aired" | "country">): string {
  const where = q.country ? ` in ${WITH_THE[q.country] ? "the " : ""}${q.country}` : "";
  const when = q.aired ? ` in ${q.aired}` : "";
  return where || when ? `(Asked${where}${when}.)` : "";
}

/**
 * One multiple-choice question as a decision item: the question itself, with its options
 * written out and where and when it was asked, is the instruction; shared guidance is the request
 * state (`QUESTION_CONTEXT`). With the options written out, GPT-6 Luna Decisions answers pun
 * and trick questions ("Which of these is a type of hat?" → Pork pie) that it refuses when it
 * sees the options only as answer choices, and OpenRouter fails a whole request for one refusal.
 */
export function questionItem(id: string, q: Pick<McQuestion, "question" | "options" | "aired" | "country">): DecisionItem {
  const written = LETTERS.map((l) => `${l}: ${q.options[l]}`).join("; ");
  const note = askedNote(q);
  return {
    id,
    instructions: `${q.question} ${written}.${note ? ` ${note}` : ""}`,
    options: Object.fromEntries(LETTERS.map((l) => [l, q.options[l]])),
  };
}

/**
 * Type 1: every question in the set is sent at once (packed `maxBatch` per call,
 * all calls concurrent up to `concurrency`). Reports accuracy, close calls, cost,
 * and wall time from the first request to the last answer. Skipped questions
 * (data/skip-questions.json) are not asked and count neither right nor wrong.
 */
export async function runType1(
  client: DecisionClient,
  range: string,
  set: McQuestion[],
  opts: { batch: number; concurrency: number; out: URL },
) {
  const questions = set.filter((q) => !q.skip.length);
  const wallStart = performance.now();
  const entries = questions.map((q, i) => ({ q, item: questionItem(`q${i}`, q) }));
  const packs = pack(entries, (e) => e.item, client.decider, opts.batch);
  const results = await pool(
    packs.map((batch, b) => async () => {
      const result = await client.decide(
        batch.map((e) => e.item),
        { type: 1, range, batch: b, keys: Object.fromEntries(batch.map((e) => [e.item.id, e.q.key])) },
        QUESTION_CONTEXT,
      );
      return { batch, result };
    }),
    opts.concurrency,
  );
  const wallMs = performance.now() - wallStart;

  let correct = 0;
  let refused = 0;
  let recovered = 0;
  let failed = 0;
  let unattempted = 0;
  let calls = 0;
  let costUsd = 0;
  let costMissing = 0;
  const closeCalls: CloseCall[] = [];
  const lines: string[] = [];
  for (const { batch, result } of results) {
    calls += result.calls;
    costUsd += result.costUsd;
    costMissing += result.costMissingCalls;
    for (const { q, item } of batch) {
      const a = result.answers[item.id];
      const isCorrect = a.choice === q.answer;
      if (isCorrect) correct++;
      if (!a.attempted) unattempted++;
      else if (a.choice === null && a.refusals > 0) refused++;
      else if (a.choice === null) failed++;
      if (a.choice !== null && a.refusals > 0) recovered++;
      const pChoice = a.choice ? a.probabilities?.[a.choice] : undefined;
      const pAnswer = a.probabilities?.[q.answer];
      let closeCall = false;
      if (!isCorrect && a.choice && pChoice !== undefined && pAnswer !== undefined && pAnswer >= pChoice - CLOSE_CALL_MARGIN) {
        closeCall = true;
        closeCalls.push({ key: q.key, answer: q.answer, choice: a.choice, pChoice, pAnswer });
      }
      lines.push(
        JSON.stringify({ decider: client.decider.id, range, key: q.key, answer: q.answer, ...a, correct: isCorrect, closeCall }),
      );
    }
  }
  if (lines.length) await appendFile(opts.out, lines.join("\n") + "\n");

  const answered = questions.length - refused - failed - unattempted;
  return {
    decider: client.decider.id,
    range,
    questions: questions.length,
    skipped: set.length - questions.length,
    packs: packs.length,
    calls,
    correct,
    // Headline denominator: every scheduled question; refusals, failures and unattempted count as wrong.
    accuracy: questions.length ? correct / questions.length : null,
    // Accuracy over questions the model actually answered.
    accuracyAnswered: answered ? correct / answered : null,
    wrong: answered - correct,
    refused,
    recoveredAfterRefusal: recovered,
    failed,
    unattempted,
    closeCalls: closeCalls.length,
    closeCallList: closeCalls,
    costUsd,
    costMissingCalls: costMissing,
    costPer1kUsd: questions.length - unattempted > 0 ? (costUsd / (questions.length - unattempted)) * 1000 : null,
    wallMs,
  };
}
