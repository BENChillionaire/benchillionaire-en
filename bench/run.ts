// Millionaire benchmark for decision models on OpenRouter.
//
//   bun bench/run.ts type1 --range corpus                   # every question, batched (throughput)
//   bun bench/run.ts type2                                    # games: lock in or walk away
//   bun bench/run.ts lockin                                   # games: every answer locked in, never walking
//   bun bench/run.ts type3                                    # games: lock in, walk away, or a lifeline
//   bun bench/run.ts type4 --games 100                        # type3 rules, one call per question
//   bun bench/run.ts latency --limit 500                      # one question per request (single-question latency)
//
// Common: --deciders a,b --seed N --batch N|max --concurrency N|all --max-usd X --timeout-ms N --dry-run
// Requests pack as many questions as fit each model's input limit; --batch N caps the count.
// --concurrency defaults to 1: one batch at a time.
//
// Deciders run one after another; each run is timed from its first request to its last
// answer. Every random draw (sampling, borrowed questions, lifeline outcomes) comes from
// --seed, so all deciders face identical questions and luck. Network failures, rate limits
// and server errors are retried (refusals never are); a call that still fails is recorded and
// its questions/games count as failed. Once reported spend reaches --max-usd no new call starts.
// The manifest records the corpus, skip list and a fingerprint of the exact prompt wording.

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { allMcQuestions, loadCorpus, type McQuestion } from "./corpus";
import { Budget, DecisionClient, RETRY_DELAYS_MS } from "./decide";
import { DECIDERS } from "./deciders";
import { buildGames, playGames, promptSamples, type Currency, type Game, type OutOfQuestions } from "./game";
import { sample, stream } from "./rng";
import { loadSecret } from "./secrets";
import { inRange, QUESTION_CONTEXT, questionItem, RANGES, runType1 } from "./type1";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    deciders: { type: "string", default: DECIDERS.map((d) => d.id).join(",") },
    seed: { type: "string", default: "1" },
    batch: { type: "string", default: "max" },
    concurrency: { type: "string" },
    "max-usd": { type: "string", default: "0.25" },
    "timeout-ms": { type: "string", default: "120000" },
    "dry-run": { type: "boolean", default: false },
    // type1
    range: { type: "string", default: "all" },
    limit: { type: "string" },
    // Comma-separated versions to include (e.g. "Australia,Ireland"); default: every English version.
    countries: { type: "string" },
    // Write bench/version.json from the current corpus, skip list, prompts and seed.
    freeze: { type: "boolean", default: false },
    // Allow a run that doesn't match bench/version.json (calibration, experiments).
    unfrozen: { type: "boolean", default: false },
    // type2 / type3
    games: { type: "string" },
    "out-of-questions": { type: "string", default: "fill" },
    currency: { type: "string", default: "usd" },
  },
});

const RUN_TYPES = ["type1", "type2", "lockin", "type3", "type4", "latency"] as const;
const runType = positionals[0] as (typeof RUN_TYPES)[number];
if (!RUN_TYPES.includes(runType)) throw new Error(`First argument must be one of ${RUN_TYPES.join(", ")}.`);
// Type 4 plays Type 3's games and lifelines but sends every decision as its own request.
const lifelines = runType === "type3" || runType === "type4";
/** Question runs (Type 1, latency) write questions.jsonl; the rest are games. */
const questionRun = runType === "type1" || runType === "latency";
const num = (name: string, raw: string | undefined, fallback: number) => {
  const value = raw === undefined || raw === "all" ? fallback : Number(raw);
  if (!(value >= 0)) throw new Error(`--${name} must be a non-negative number or "all".`);
  return value;
};
const seed = num("seed", args.seed, 1);
// One batch at a time unless overridden.
const concurrency = num("concurrency", args.concurrency ?? "1", Infinity);
const maxUsd = num("max-usd", args["max-usd"], 0.25);
const timeoutMs = num("timeout-ms", args["timeout-ms"], 120_000);
const batch = args.batch === "max" ? Infinity : num("batch", args.batch, Infinity);
const deciders = args.deciders.split(",").map((id) => {
  const decider = DECIDERS.find((d) => d.id === id.trim());
  if (!decider) throw new Error(`Unknown decider "${id}". Known: ${DECIDERS.map((d) => d.id).join(", ")}`);
  return decider;
});
const outOfQuestions = args["out-of-questions"] as OutOfQuestions;
if (!["fill", "cutoff", "complete"].includes(outOfQuestions)) throw new Error("--out-of-questions must be fill, cutoff, or complete.");
const currency = args.currency as Currency;
if (!["usd", "native"].includes(currency)) throw new Error("--currency must be usd or native.");

const corpus = await loadCorpus();

// Fix the workload before any decider runs.
let type1Sets: { range: string; questions: McQuestion[] }[] = [];
let games: Game[] = [];
let excluded: Record<string, number> = {};
if (runType === "latency") {
  // A fixed sample of askable questions, each sent on its own: the same sample for every model.
  const askable = allMcQuestions(corpus).filter((q) => !q.skip.length);
  type1Sets = [{ range: "latency", questions: sample(askable, num("limit", args.limit, 500), stream(seed, "latency")) }];
  console.log(`latency: ${type1Sets[0].questions.length} questions, one per request`);
} else if (runType === "type1") {
  const only = args.countries ? new Set(args.countries.split(",").map((c) => c.trim())) : null;
  const questions = allMcQuestions(corpus).filter((q) => !only || only.has(corpus.shows[Number(q.key.split(":")[0])].country ?? ""));
  if (args.range === "corpus") {
    // Every scorable multiple-choice question (all ladder levels and Fastest Finger) in one set.
    type1Sets = [
      { range: "corpus", questions: sample(questions, num("limit", args.limit, questions.length), stream(seed, "type1", "corpus")) },
    ];
  } else if (args.range === "complete-games") {
    // Every question from the games that aired all 15 questions, in ladder order.
    const { games: complete } = buildGames(corpus, { seed, outOfQuestions: "complete", currency: "usd" });
    const all = complete.flatMap((g) => g.rungs.map((r) => r.question));
    type1Sets = [{ range: "complete-games", questions: all.slice(0, num("limit", args.limit, all.length)) }];
  } else {
    const ranges = args.range === "all" ? RANGES : RANGES.filter((r) => r.id === args.range);
    if (!ranges.length) {
      throw new Error(`--range must be corpus, complete-games, all, or one of ${RANGES.map((r) => r.id).join(", ")}.`);
    }
    type1Sets = ranges.map((r) => {
      const inR = questions.filter((q) => inRange(q, r));
      return { range: r.id, questions: sample(inR, num("limit", args.limit, inR.length), stream(seed, "type1", r.id)) };
    });
  }
  for (const s of type1Sets) console.log(`range ${s.range}: ${s.questions.length} questions`);
} else {
  const built = buildGames(corpus, { seed, outOfQuestions, currency });
  excluded = built.excluded;
  games = sample(built.games, num("games", args.games, built.games.length), stream(seed, "games"));
  console.log(
    `${games.length} of ${built.games.length} playable games (${outOfQuestions}, ${currency}); excluded ${JSON.stringify(excluded)}; ` +
      `${games.reduce((n, g) => n + g.rungs.filter((r) => r.borrowed).length, 0)} borrowed rungs in the selection`,
  );
}
console.log(`deciders: ${deciders.map((d) => d.id).join(", ")}; concurrency ${concurrency}; stop at $${maxUsd} reported spend`);

// The exact wording sent, rendered for a fixed sample: its hash tells runs with different prompts apart.
const promptSample = {
  questionContext: QUESTION_CONTEXT,
  question: questionItem("q0", {
    question: "Which planet is known as the Red Planet?",
    options: { A: "Venus", B: "Mars", C: "Jupiter", D: "Saturn" },
    aired: 2001,
  }),
  game: promptSamples(),
};
const promptSha256 = createHash("sha256").update(JSON.stringify(promptSample)).digest("hex");

/**
 * The frozen benchmark version (bench/version.json): a run records whether it matches it, and
 * refuses to start when it doesn't unless --unfrozen is given (calibration and experiments).
 */
const version = (await Bun.file(new URL("version.json", import.meta.url)).json()) as {
  name: string;
  corpusSha256: string;
  skipListSha256: string;
  promptsSha256: string;
  seed: number;
};
const frozen =
  version.corpusSha256 === corpus.sha256 &&
  version.skipListSha256 === corpus.skipSha256 &&
  version.promptsSha256 === promptSha256 &&
  version.seed === seed;
console.log(frozen ? `benchmark ${version.name}` : `NOT ${version.name}: corpus, skip list, prompts or seed differ from bench/version.json`);
if (args.freeze) {
  const next = { ...version, corpusSha256: corpus.sha256, skipListSha256: corpus.skipSha256, promptsSha256: promptSha256, seed };
  await writeFile(new URL("version.json", import.meta.url), JSON.stringify(next, null, 2) + "\n");
  console.log(`froze ${version.name} at the current corpus, skip list, prompts and seed`);
  process.exit(0);
}
if (!frozen && !args.unfrozen && !args["dry-run"]) throw new Error("Refusing to run off the frozen version; pass --unfrozen for experiments.");
if (args["dry-run"]) process.exit(0);

const apiKey = await loadSecret("OPENROUTER", "API_TOKEN");
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${runType}-seed${seed}`;
const runDir = new URL(`../runs/${runId}/`, import.meta.url);
await mkdir(runDir, { recursive: true });
const calls = new URL("calls.jsonl", runDir);
const results = new URL(questionRun ? "questions.jsonl" : "games.jsonl", runDir);
await writeFile(
  new URL("manifest.json", runDir),
  JSON.stringify(
    {
      runId,
      runType,
      startedAt: new Date().toISOString(),
      corpus: {
        path: "data/millionaire_questions.json",
        sha256: corpus.sha256,
        skipList: { path: "data/skip-questions.json", sha256: corpus.skipSha256 },
      },
      seed,
      benchmark: { name: version.name, frozen },
      deciders,
      prompts: { sha256: promptSha256, sample: promptSample },
      policy: {
        packing: runType === "type4" || runType === "latency" ? "one question per request" : "token-budget",
        batchCap: String(runType === "type4" || runType === "latency" ? 1 : batch),
        concurrency: String(concurrency),
        maxUsd,
        timeoutMs,
        retries: { transient: RETRY_DELAYS_MS.length, delaysMs: RETRY_DELAYS_MS, refusals: 0 },
        providerFallbacks: false,
      },
      ...(questionRun
        ? { type1: type1Sets.map((s) => ({ range: s.range, questionKeys: s.questions.map((q) => q.key) })) }
        : { games: { outOfQuestions, currency, excluded, ids: games.map((g) => g.id) } }),
    },
    null,
    2,
  ) + "\n",
);

const budget = new Budget(maxUsd);
const summaries: unknown[] = [];
for (const decider of deciders) {
  const client = new DecisionClient(decider, apiKey, calls, timeoutMs, budget);
  if (questionRun) {
    for (const set of type1Sets) {
      const s = await runType1(client, set.range, set.questions, { batch: runType === "latency" ? 1 : batch, concurrency, out: results });
      summaries.push(s);
      console.log(
        `${decider.id} ${set.range}: ${s.correct}/${s.questions} correct (${((s.accuracy ?? 0) * 100).toFixed(1)}%), ${s.skipped} skipped, ` +
          `${((s.accuracyAnswered ?? 0) * 100).toFixed(1)}% of answered, ${s.closeCalls} close calls, ` +
          `${s.refused} refused (${s.recoveredAfterRefusal} recovered alone), ${s.failed} failed, ${s.unattempted} unattempted, ` +
          `$${s.costUsd.toFixed(6)}, ${(s.wallMs / 1000).toFixed(2)}s wall, ${s.packs} packs / ${s.calls} calls`,
      );
    }
  } else {
    const s = await playGames(client, games, {
      seed,
      lifelines,
      walk: runType !== "lockin",
      runType,
      batch: runType === "type4" ? 1 : batch,
      concurrency,
      out: results,
    });
    summaries.push(s);
    console.log(
      `${decider.id}: winnings ${JSON.stringify(s.winningsByCurrency)} over ${s.scoredGames}/${s.games} games, ` +
        `exits ${JSON.stringify(s.exits)}, ${s.answeredCorrectly}/${s.answered} answers correct, ` +
        `lifelines ${JSON.stringify(s.lifelinesUsed)}, walked at ${JSON.stringify(s.walkAwaysAtQuestion)}, $${s.costUsd.toFixed(6)}, ` +
        `${(s.wallMs / 1000).toFixed(2)}s wall, ${s.rounds} rounds / ${s.calls} calls, refused steps ${JSON.stringify(s.refusedSteps)}, ` +
        `${s.skippedPassed} skipped questions passed`,
    );
  }
}

await writeFile(
  new URL("summary.json", runDir),
  JSON.stringify({ runId, spentUsd: budget.spent, stoppedByBudget: budget.exhausted, results: summaries }, null, 2) + "\n",
);
console.log(`spent $${budget.spent.toFixed(6)}${budget.exhausted ? " (budget reached)" : ""}; runs/${runId}/`);
