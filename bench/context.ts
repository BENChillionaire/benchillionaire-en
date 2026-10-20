// Flags askable en-benchmark questions that may be missing context, with Jev, for review:
// runs/<id>/candidates.json, { "<show>:<question>": { reason, p } }. Reviewed flags go in
// data/context-review.json, which the skip list reads (bench/scan.ts).
//
//   bun bench/context.ts [--max-usd 2]
//
// Two judgments per question, each one decision with its probabilities:
// - every question: does it stand on its own, or refer to something not shown (a picture, clip,
//   sound), or do its options not fit it (a garbled record)?
// - questions with no known air year: would the right answer depend on when it was asked?
// Jev finds these well but over-flags: questions about a logo or album cover read as "media",
// puns as "garbled", facts that rarely change as "dated". So this pass is set for recall, and each
// candidate is then checked on whether its answer stands on its own (2026-10-19: a stronger model
// reviewed every candidate; those it confirmed are in data/context-review.json).
// Text rules (bench/scan.ts) run first; questions they already skip are not sent. Every answer is
// kept in runs/<id>/.

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { allMcQuestions, LETTERS, loadCorpus, type McQuestion } from "./corpus";
import { Budget, DecisionClient, pack, pool, type DecisionItem } from "./decide";
import { DECIDERS } from "../shared/decisions";
import { loadSecret } from "./secrets";

const { values: args } = parseArgs({ options: { "max-usd": { type: "string", default: "2" } } });
/** Candidate thresholds: about 0.9 recall on 2,431 questions a stronger model had labelled. */
const MEDIA = 0.5;
const GARBLED = 0.8;
const DATED = 0.5;

/** Whether the question points at something on screen; "which of these" and "the following is" only point at the options. */
function pointsAtSomething(question: string): boolean {
  const text = question
    .replace(/\b(which|one|none|all|both|each|any|many|most|how many) of (these|the following|those)\b/gi, "")
    .replace(/\bthe following\b(?= (is|are|was|were|has|have|does|did|can|could|would|best|correctly|accurately|not))/gi, "");
  return /\b(this|these|here|shown|pictured|following|above|below|clip|picture|photo|image|seen)\b/i.test(text);
}

const CONTEXT =
  "You audit quiz questions from a TV quiz show. Each item gives one question exactly as a contestant read it, with its four options. Judge the record itself, not whether you know the answer.";

const STANDS_ALONE = {
  alone: "It can be answered from the question text and the four options alone.",
  media: "It refers to something the reader is not shown: a picture, photo, video, sound, music clip, map or object on screen.",
  garbled: "The options do not fit the question (they belong to another question, or the text is garbled), so no option answers it.",
} as const;
const TIME = {
  timeless: "The right answer is the same whenever the question is asked.",
  dated: "The right answer depends on when it was asked: who currently holds a post, the latest or newest of something, records, ages, or recent events.",
} as const;

const asWritten = (q: McQuestion) => `"${q.question}" ${LETTERS.map((l) => `${l}: ${q.options[l]}`).join("; ")}.`;
const standsAlone = (q: McQuestion, id: string): DecisionItem => ({
  id,
  instructions: `Question: ${asWritten(q)} Can this question be answered as recorded?`,
  options: { ...STANDS_ALONE },
});
const timeSensitive = (q: McQuestion, id: string): DecisionItem => ({
  id,
  instructions: `Question: ${asWritten(q)} Would its right answer depend on when it was asked?`,
  options: { ...TIME },
});

const corpus = await loadCorpus();
const askable = allMcQuestions(corpus).filter((q) => !q.skip.length);
const entries = [
  ...askable.map((q, i) => ({ q, check: "stands_alone" as const, item: standsAlone(q, `s${i}`) })),
  ...askable.filter((q) => q.aired === null).map((q, i) => ({ q, check: "time" as const, item: timeSensitive(q, `t${i}`) })),
];
console.log(`${askable.length} askable questions; ${entries.length} judgments`);

const decider = DECIDERS.find((d) => d.id === "jev-1.14")!;
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-context-review`;
const runDir = new URL(`../runs/${runId}/`, import.meta.url);
await mkdir(runDir, { recursive: true });
const budget = new Budget(Number(args["max-usd"]));
const client = new DecisionClient(decider, await loadSecret("OPENROUTER", "API_TOKEN"), new URL("calls.jsonl", runDir), 120_000, budget);

const packs = pack(entries, (e) => e.item, decider, Infinity);
const results = await pool(
  packs.map((batch, b) => async () => ({ batch, result: await client.decide(batch.map((e) => e.item), { purpose: "context-review", batch: b }, CONTEXT) })),
  4,
);

const candidates: Record<string, { reason: "media" | "malformed" | "undated"; p: number }> = {};
const rows: string[] = [];
let unanswered = 0;
for (const { batch, result } of results) {
  for (const { q, check, item } of batch) {
    const a = result.answers[item.id];
    rows.push(JSON.stringify({ key: q.key, check, choice: a.choice, probabilities: a.probabilities, refusals: a.refusals }));
    if (!a.probabilities) {
      unanswered++;
      continue;
    }
    const p = a.probabilities;
    if (check === "stands_alone") {
      if ((p.media ?? 0) >= MEDIA && pointsAtSomething(q.question)) candidates[q.key] = { reason: "media", p: p.media };
      else if ((p.garbled ?? 0) >= GARBLED) candidates[q.key] = { reason: "malformed", p: p.garbled };
    } else if ((p.dated ?? 0) >= DATED && !candidates[q.key]) candidates[q.key] = { reason: "undated", p: p.dated };
  }
}
await writeFile(new URL("answers.jsonl", runDir), rows.join("\n") + "\n");
await writeFile(new URL("candidates.json", runDir), JSON.stringify(candidates, null, 1) + "\n");
const counts: Record<string, number> = {};
for (const c of Object.values(candidates)) counts[c.reason] = (counts[c.reason] ?? 0) + 1;
console.log(`${Object.keys(candidates).length} candidates`, counts, `${unanswered} unanswered; $${budget.spent.toFixed(4)}; runs/${runId}/candidates.json`);
