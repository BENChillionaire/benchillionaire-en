// Scans the corpus for questions that can't be fairly asked and writes the skip list every run
// and the playable game read: data/skip-questions.json, { rules, questions: { "<show>:<question>": [reasons] } }.
//
//   bun bench/scan.ts
//
// Text rules run over every multiple-choice question; data/context-review.json (bench/context.ts:
// candidates checked by a model for missing context, plus hand-reviewed broken records) adds the
// rest. A skipped question is never asked: Type 1 leaves it neutral, game runs pass it
// automatically (it pays its rung, no decision, no lifeline, no walk), and the playable game never
// draws it. Questions every model gets wrong are not skipped (a hard question with its context
// given is fair; wrong answer keys are fixed in data/corrections.json), nor are refusals (they
// count as wrong in Type 1, and games report them both as a loss and as a pass).

import { writeFile } from "node:fs/promises";
import { airedYear, type CorpusQuestion, type CorpusShow } from "./corpus";

export const SKIP_RULES = {
  media: "Needs a picture, audio or video clip the corpus doesn't have (wiki flag, wording such as \"Whose voice is this?\", or judged by a model to refer to something not shown).",
  malformed: "Broken record: missing, duplicate or mismatched options, an answer outside A–D, or an empty question.",
  undated: "Its answer depends on when it was asked, but the show's air date is unknown (wording such as \"current\", or judged by a model).",
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

  const reviewed = (await Bun.file(new URL("../data/context-review.json", import.meta.url)).json()) as Record<string, SkipReason>;
  for (const [key, reason] of Object.entries(reviewed)) {
    if (!(reason in SKIP_RULES)) throw new Error(`data/context-review.json: ${key} has unknown reason "${reason}"`);
    add(key, reason);
  }

  const counts: Record<string, number> = {};
  for (const reasons of Object.values(skip)) for (const r of reasons) counts[r] = (counts[r] ?? 0) + 1;
  await writeFile(new URL("../data/skip-questions.json", import.meta.url), JSON.stringify({ rules: SKIP_RULES, counts, questions: skip }) + "\n");
  console.log(`skip list: ${Object.keys(skip).length} questions`, counts);
}
