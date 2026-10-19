// Scans the corpus for questions that can't be fairly asked and writes the skip list every run
// and the playable game read: data/skip-questions.json, { rules, questions: { "<show>:<question>": [reasons] } }.
//
//   bun bench/scan.ts [runs/<type1 run> …]
//
// Text rules run over every multiple-choice question. Type 1 runs given as arguments add the
// model-based rules (a question every model in that run got wrong, or one a provider refused even
// when asked alone). A skipped question is never asked: Type 1 leaves it neutral, game runs pass
// it automatically (it pays its rung, no decision, no lifeline, no walk), and the playable game
// never draws it.

import { writeFile } from "node:fs/promises";
import { airedYear, type CorpusQuestion, type CorpusShow } from "./corpus";

export const SKIP_RULES = {
  media: "Needs a picture, audio or video clip the corpus doesn't have (wiki flag or wording such as \"Whose voice is this?\").",
  malformed: "Broken record: missing or duplicate options, an answer outside A–D, or an empty question.",
  undated: "Asks about the present (\"current\", \"this year\", \"now\") but the show's air date is unknown.",
  all_models_wrong: "Every model got it wrong in a Type 1 run: a broken answer key or translation is likely, though some are just very hard.",
  refused: "A provider refused it even when asked on its own.",
} as const;
export type SkipReason = keyof typeof SKIP_RULES;

const MEDIA_WORDING = [
  /\bthis (song|tune|clip|video|picture|photo|photograph|image|statue|voice|sound|painting|footage|scene|audio|music|dialogue|illustration|sculpture|logo|map|cartoon|poster|graph|chart|diagram|drawing|artwork|sketch)\b/i,
  /\bthis (personality|person|celebrity|actor|actress|singer|player|sportsperson|cricketer|leader|politician|political personality|structure|building|monument|place|landmark|animal|bird|plant|object|item|instrument|dish|vehicle|device|tool|character)\b/i,
  /\b(who|what) (is|are|was|were) (this|these)( \w+)?\?/i,
  /\b(shown|pictured|depicted|seen) (here|above|below)\b|\b(pointed out|highlighted|circled|marked) (here|above|below|in)\b|\bseen in this\b|\bdepicted in the (statue|picture|image|photo|painting)\b/i,
  /\b(audio|video) clip\b|\bin the (clip|video|picture|image|photo|photograph)\b|\bheard in this\b|\bcan be heard\b/i,
  /^ide\w*fy\b/i,
  /\bwhose voice\b|\bpicturi[sz]ed\b/i,
  // Questions that open on an unseen clip ("This 2020 song is by…", "This is the opening of…"),
  // mostly Australia's Hot Seat.
  /^(this|these)\s+(\d{4}\s+)?(\w+\s+){0,2}?(songs?|tune|music|musical|piece|passage|chorus|lyrics?|opening line|theme|track|hit|album|singer|voice|sound|clip|video|image|picture|photo|painting|artwork|logo|landmark|building|object|device|item|animal|plant|person|man|woman|actor|actress)\b|^this is (the|a|an)\b|^the (chart-topping|following) (\d{4} )?(song|hit|clip|track)\b/i,
];
const PRESENT = /\b(current(?! affairs)|currently|this year|right now|nowadays|at present|presently|incumbent|reigning)\b/i;

function textReasons(show: CorpusShow, q: CorpusQuestion): SkipReason[] {
  const reasons: SkipReason[] = [];
  if (q.media || MEDIA_WORDING.some((re) => re.test(q.question))) reasons.push("media");
  // "-" marks an option the wiki recorded after a 50:50 took it away.
  const options = (["A", "B", "C", "D"] as const).map((l) => (q.options?.[l]?.trim() ?? "").replace(/^-+$/, ""));
  const distinct = new Set(options.map((o) => o.toLowerCase()));
  if (q.question.trim().length < 8 || options.some((o) => !o) || distinct.size < 4 || !["A", "B", "C", "D"].includes(q.answer)) {
    reasons.push("malformed");
  }
  if (PRESENT.test(q.question) && airedYear(show.air_date) === null) reasons.push("undated");
  return reasons;
}

if (import.meta.main) {
  const { shows } = (await Bun.file(new URL("../data/millionaire_questions.json", import.meta.url)).json()) as { shows: CorpusShow[] };
  const skip: Record<string, SkipReason[]> = {};
  const add = (key: string, reason: SkipReason) => {
    const list = (skip[key] ??= []);
    if (!list.includes(reason)) list.push(reason);
  };
  shows.forEach((show, s) =>
    show.questions.forEach((q, i) => {
      if (q.type !== "multiple_choice") return;
      for (const reason of textReasons(show, q)) add(`${s}:${i}`, reason);
    }),
  );

  const sources: string[] = [];
  for (const dir of process.argv.slice(2)) {
    const base = dir.replace(/\/$/, "");
    const { runId } = (await Bun.file(`${base}/manifest.json`).json()) as { runId: string };
    sources.push(runId);
    const rows = (await Bun.file(`${base}/questions.jsonl`).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { decider: string; key: string; correct: boolean; choice: string | null; refusals: number });
    const deciders = new Set(rows.map((r) => r.decider)).size;
    const byKey: Record<string, typeof rows> = {};
    for (const r of rows) (byKey[r.key] ??= []).push(r);
    for (const [key, list] of Object.entries(byKey)) {
      if (list.length === deciders && list.every((r) => !r.correct)) add(key, "all_models_wrong");
      if (list.some((r) => r.choice === null && r.refusals > 0)) add(key, "refused");
    }
  }

  const counts: Record<string, number> = {};
  for (const reasons of Object.values(skip)) for (const r of reasons) counts[r] = (counts[r] ?? 0) + 1;
  await writeFile(
    new URL("../data/skip-questions.json", import.meta.url),
    JSON.stringify({ rules: SKIP_RULES, modelRunsUsed: sources, counts, questions: skip }) + "\n",
  );
  console.log(`skip list: ${Object.keys(skip).length} questions`, counts, sources.length ? `(model rules from ${sources.join(", ")})` : "");
}
