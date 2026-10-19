import { appendFile } from "node:fs/promises";
import { inEnBenchmark, LETTERS, toMcQuestion, type Corpus, type CorpusQuestion, type Letter, type McQuestion } from "./corpus";
import { pack, pool, type DecisionClient, type DecisionItem, type ItemAnswer } from "./decide";
import { guaranteedPositions, parsePrize, USD_LADDER } from "./ladder";
import { askTheAudience, fiftyFifty, LIFELINES, phoneAFriend, type Lifeline, type Spot } from "./lifelines";
import { stream } from "./rng";
import { QUESTION_CONTEXT } from "./type1";

/** What happens when a game has no aired, text-only question for the next rung. */
export type OutOfQuestions = "fill" | "cutoff" | "complete";
export type Currency = "usd" | "native";

export interface Rung {
  question: McQuestion;
  /** True when the question was borrowed from another game at the same position. */
  borrowed: boolean;
}

export interface Game {
  id: string;
  page: string;
  version: string | null;
  currency: string;
  /** Full ladder length; `rungs` can be shorter only in cutoff mode. */
  length: number;
  rungs: Rung[];
  /** Prize of every ladder position, used for guaranteed amounts. */
  ladder: number[];
}

interface ShowLadder {
  index: number;
  version: string | null;
  of: number;
  /** Aired main-round questions by 1-based position. */
  byPosition: Map<number, { q: CorpusQuestion; i: number }>;
}

function showLadders(corpus: Corpus): ShowLadder[] {
  return corpus.shows.flatMap((show, index) => {
    if (!inEnBenchmark(show)) return [];
    const byPosition = new Map<number, { q: CorpusQuestion; i: number }>();
    const ofCounts = new Map<number, number>();
    show.questions.forEach((q, i) => {
      if (q.round !== "main" || q.number === null || byPosition.has(q.number)) return;
      byPosition.set(q.number, { q, i });
      if (q.of !== null) ofCounts.set(q.of, (ofCounts.get(q.of) ?? 0) + 1);
    });
    const of = [...ofCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!byPosition.has(1) || of === undefined) return [];
    return [{ index, version: show.show, of, byPosition }];
  });
}

/** Native prize amounts for positions 1..of, or null when any position lacks a parseable amount. */
function nativeLadder(ladder: ShowLadder): { prizes: number[]; currency: string } | null {
  const prizes: number[] = [];
  let currency: string | null = null;
  for (let p = 1; p <= ladder.of; p++) {
    const entry = ladder.byPosition.get(p);
    const prize = entry ? parsePrize(entry.q.value) : null;
    if (!prize || (currency !== null && prize.currency !== currency)) return null;
    currency = prize.currency;
    prizes.push(prize.amount);
  }
  return currency === null ? null : { prizes, currency };
}

export interface BuildResult {
  games: Game[];
  excluded: Record<string, number>;
}

/**
 * Builds playable games. USD mode plays every game on the classic 15-rung ladder;
 * native mode uses the game's own ladder length and prizes, borrowing the prize
 * ladder of a fully aired game of the same version and length when needed.
 */
export function buildGames(corpus: Corpus, opts: { seed: number; outOfQuestions: OutOfQuestions; currency: Currency }): BuildResult {
  const ladders = showLadders(corpus);
  const excluded: Record<string, number> = {};
  const exclude = (reason: string) => (excluded[reason] = (excluded[reason] ?? 0) + 1);

  // Fill pools: askable questions by ladder length and position (a skipped question is never borrowed).
  const fillPool = new Map<string, McQuestion[]>();
  for (const l of ladders) {
    for (const [p, { i }] of l.byPosition) {
      const mc = toMcQuestion(corpus, l.index, i);
      if (!mc || mc.skip.length) continue;
      const key = `${l.of}:${p}`;
      const list = fillPool.get(key);
      if (list) list.push(mc);
      else fillPool.set(key, [mc]);
    }
  }

  const nativeByVersion = new Map<string, { prizes: number[]; currency: string }>();
  if (opts.currency === "native") {
    for (const l of ladders) {
      const key = `${l.version}|${l.of}`;
      if (nativeByVersion.has(key)) continue;
      const native = nativeLadder(l);
      if (native) nativeByVersion.set(key, native);
    }
  }

  const games: Game[] = [];
  for (const l of ladders) {
    const length = opts.currency === "usd" ? 15 : l.of;
    let ladder = USD_LADDER;
    let currency = "USD";
    if (opts.currency === "native") {
      const native = nativeLadder(l) ?? nativeByVersion.get(`${l.version}|${l.of}`);
      if (!native) {
        exclude("no_native_prize_ladder");
        continue;
      }
      ladder = native.prizes;
      currency = native.currency;
    }
    // USD games borrow from 15-rung games; native games from games with their own ladder length.
    const poolOf = opts.currency === "usd" ? 15 : l.of;
    const id = String(l.index);
    const rungs: Rung[] = [];
    let complete = true;
    for (let p = 1; p <= length; p++) {
      const aired = l.byPosition.get(p);
      // A skipped aired question keeps its rung: it is passed automatically during play.
      const mc = aired && (opts.currency === "native" || l.of >= p) ? toMcQuestion(corpus, l.index, aired.i) : null;
      if (mc) {
        rungs.push({ question: mc, borrowed: false });
        continue;
      }
      complete = false;
      if (opts.outOfQuestions !== "fill") break;
      // Seeded draw from games with the same ladder length at this position, skipping this game's own questions.
      const candidates = fillPool.get(`${poolOf}:${p}`) ?? [];
      const rand = stream(opts.seed, "fill", id, p);
      let borrowed: McQuestion | undefined;
      for (let tries = 0; tries < 32 && !borrowed; tries++) {
        const pick = candidates[Math.floor(rand() * candidates.length)];
        if (pick && !pick.key.startsWith(`${l.index}:`)) borrowed = pick;
      }
      if (!borrowed) break;
      rungs.push({ question: borrowed, borrowed: true });
    }
    if (opts.outOfQuestions === "complete" && !complete) {
      exclude("not_fully_aired");
      continue;
    }
    if (!rungs.length) {
      exclude("no_usable_first_question");
      continue;
    }
    games.push({ id, page: corpus.shows[l.index].page, version: l.version, currency, length, rungs, ladder });
  }
  return { games, excluded };
}

type Exit = "wrong" | "walked" | "won" | "out_of_questions" | "failed" | "unfinished";

/**
 * Every turn is two decisions, each its own request: the answer step (which option is right,
 * a choice over the options still on the board) and the action step (what to do with that
 * answer: lock it in, walk away, or spend a lifeline still in hand). A lifeline changes the
 * board, so the turn goes back to the answer step with its result in view.
 */
type Stage = "answer" | "action";

interface Step {
  position: number;
  /** "skip": a skipped question, passed automatically with no request. */
  stage: Stage | "skip";
  /** Answer step: a letter. Action step: "lock", "walk" or a lifeline. Null when refused or failed. */
  choice: string | null;
  refused: boolean;
  probabilities: Record<string, number> | null;
  /** Set on a lock-in: whether the locked answer was right. */
  correct?: boolean;
}

interface Play {
  game: Game;
  /** 0-based index of the rung being played. */
  pos: number;
  bank: number;
  exit: Exit | null;
  stage: Stage;
  /** The answer step's result for the board as it is now; cleared whenever the board changes. */
  pick: { choice: Letter; probabilities: Record<string, number> | null } | null;
  lifelinesLeft: Lifeline[];
  lifelinesUsed: { lifeline: Lifeline; position: number }[];
  /** Results of lifelines used on the current question. */
  removed: Letter[];
  audience: Record<Letter, number> | null;
  friend: Letter | null;
  /** Questions answered correctly; this, not the question position, sets the money (refusals advance without pay). */
  correct: number;
  refused: number;
  history: Step[];
  winnings: number | null;
}

const fmt = (amount: number, currency: string) =>
  currency === "USD" ? `$${amount.toLocaleString("en-US")}` : `${amount.toLocaleString("en-US")} ${currency}`.trim();

function guaranteed(play: Play): number {
  const passed = play.correct; // money rungs earned so far
  const safe = guaranteedPositions(play.game.length).filter((p) => p <= passed);
  return safe.length ? play.game.ladder[Math.max(...safe) - 1] : 0;
}

const LIFELINE_TEXT: Record<Lifeline, string> = {
  fifty_fifty: "Use 50:50: two wrong answers are removed.",
  ask_the_audience: "Ask the Audience: 100 audience members vote on the answer.",
  phone_a_friend: "Phone a Friend: a friend suggests an answer.",
};

/** Request state for action steps: the rules every turn shares. */
function gameContext(lifelines: boolean): string {
  return (
    "You are a contestant in a money-ladder game, answering questions one at a time for rising prizes. " +
    "On each question you see your own answer and decide what to do: lock it in" +
    (lifelines ? ", walk away with the money you have, or use one of your lifelines. Each lifeline can be used once per game. " : " or walk away with the money you have. ") +
    "A right answer moves you up the ladder; a wrong answer drops you to your guaranteed amount."
  );
}

const remainingOf = (play: Play) => LETTERS.filter((l) => !play.removed.includes(l));

/** The question as it stands: text, the options still on the board, when it was asked, and lifeline results. */
function board(play: Play): string {
  const q = play.game.rungs[play.pos].question;
  const parts = [`${q.question} ${remainingOf(play).map((l) => `${l}: ${q.options[l]}`).join("; ")}.`];
  if (q.aired) parts.push(`(Asked in ${q.aired}.)`);
  if (play.removed.length) parts.push(`50:50 removed ${play.removed.join(" and ")}.`);
  if (play.audience) parts.push(`The audience voted ${Object.entries(play.audience).map(([l, v]) => `${l} ${v}%`).join(", ")}.`);
  if (play.friend) parts.push(`A friend thinks it's ${play.friend}.`);
  return parts.join(" ");
}

function answerItem(play: Play, id: string): DecisionItem {
  const q = play.game.rungs[play.pos].question;
  return { id, instructions: board(play), options: Object.fromEntries(remainingOf(play).map((l) => [l, q.options[l]])) };
}

function actionItem(play: Play, id: string): DecisionItem {
  const { currency, ladder, length } = play.game;
  const pick = play.pick!; // the action step always follows an answer step on the same board
  const next = fmt(ladder[play.correct], currency);
  const top = fmt(ladder[length - 1], currency);
  const safe = fmt(guaranteed(play), currency);
  const bank = fmt(play.bank, currency);
  const left = length - play.pos;
  const last = left === 1;
  const sure = pick.probabilities?.[pick.choice];
  const milestones = guaranteedPositions(length)
    .map((p) => `${fmt(ladder[p - 1], currency)} after question ${p}`)
    .join(" and ");
  // The whole ladder is in view (top prize, guaranteed amounts, what walking gives up), so the
  // move weighs the rest of the game, not just the next rung. Nothing is weighed for the model.
  const instructions = [
    `Question ${play.pos + 1} of ${length}, for ${next}; the top prize is ${top}.`,
    `You have ${bank}; a wrong answer leaves you with ${safe}. Guaranteed amounts: ${milestones}.`,
    board(play),
    `Your answer: ${pick.choice}${sure === undefined ? "" : ` (${Math.round(sure * 100)}% sure)`}.`,
  ].join(" ");
  const options: Record<string, string> = {
    lock: last
      ? `Lock in ${pick.choice}: if right you win ${top}; if wrong you leave with ${safe}.`
      : `Lock in ${pick.choice}: if right you have ${next} and play on toward ${top}; if wrong you leave with ${safe}.`,
    walk: last
      ? `Walk away: leave with ${bank} and give up the chance at ${top}.`
      : `Walk away: leave with ${bank} and give up the ${left} remaining questions, worth up to ${top}.`,
  };
  for (const lifeline of play.lifelinesLeft) options[lifeline] = `${LIFELINE_TEXT[lifeline]} It costs nothing; you then decide again on this question.`;
  return { id, instructions, options };
}

/**
 * The game prompts rendered for a fixed, made-up turn (all lifelines in hand, then with every
 * lifeline result on the board), so a run can fingerprint exactly what the models were sent.
 */
export function promptSamples() {
  const q: McQuestion = {
    key: "sample",
    question: "Which planet is known as the Red Planet?",
    options: { A: "Venus", B: "Mars", C: "Jupiter", D: "Saturn" },
    answer: "B",
    number: 7,
    of: 15,
    value: "",
    aired: 2001,
    skip: [],
    heldOut: false,
  };
  const game: Game = { id: "sample", page: "", version: null, currency: "USD", length: 15, rungs: Array.from({ length: 15 }, () => ({ question: q, borrowed: false })), ladder: USD_LADDER };
  const play: Play = {
    game,
    pos: 6,
    bank: 2000,
    exit: null,
    stage: "action",
    pick: { choice: "B", probabilities: { A: 0.1, B: 0.8, C: 0.05, D: 0.05 } },
    lifelinesLeft: [...LIFELINES],
    lifelinesUsed: [],
    removed: [],
    audience: null,
    friend: null,
    correct: 6,
    refused: 0,
    history: [],
    winnings: null,
  };
  const fresh = { answer: answerItem(play, "g0"), action: actionItem(play, "g0") };
  const withResults = { ...play, removed: ["A", "D"] as Letter[], audience: { B: 70, C: 30 } as Record<Letter, number>, friend: "B" as Letter };
  return {
    contextWithLifelines: gameContext(true),
    contextWithoutLifelines: gameContext(false),
    ...fresh,
    answerAfterLifelines: answerItem(withResults, "g0"),
  };
}

/** Moves to the next question and clears the current question's lifeline results. */
function advance(play: Play) {
  play.pos++;
  play.stage = "answer";
  play.pick = null;
  play.removed = [];
  play.audience = null;
  play.friend = null;
  if (play.pos === play.game.length) play.exit = "won";
  else if (play.pos === play.game.rungs.length) play.exit = "out_of_questions";
}

/**
 * Passes skipped questions (data/skip-questions.json) with no request: each pays its rung as if
 * answered right, uses no lifeline and offers no walk.
 */
function passSkipped(play: Play) {
  while (play.exit === null && play.game.rungs[play.pos].question.skip.length) {
    play.history.push({ position: play.pos + 1, stage: "skip", choice: null, refused: false, probabilities: null });
    play.correct++;
    play.bank = play.game.ladder[play.correct - 1];
    advance(play);
  }
}

/**
 * Answer step. A refusal (the provider refused this question even asked on its own) moves the
 * game to the next question as if answered, but earns no money rung, so n refusals cap the game
 * at the prize of rung (length − n).
 */
function applyAnswer(play: Play, answer: ItemAnswer) {
  const position = play.pos + 1;
  if (!answer.attempted) {
    play.exit = "unfinished";
    return;
  }
  const refused = answer.choice === null && answer.refusals > 0;
  play.history.push({ position, stage: "answer", choice: answer.choice, refused, probabilities: answer.probabilities });
  if (refused) {
    play.refused++;
    advance(play);
    return;
  }
  if (answer.choice === null) {
    play.exit = "failed";
    return;
  }
  play.pick = { choice: answer.choice as Letter, probabilities: answer.probabilities };
  play.stage = "action";
}

/** Action step. A refused action locks in the answer step's pick, the move closest to not deciding. */
function applyAction(play: Play, answer: ItemAnswer, seed: number) {
  const rung = play.game.rungs[play.pos];
  const position = play.pos + 1;
  if (!answer.attempted) {
    play.exit = "unfinished";
    return;
  }
  const refused = answer.choice === null && answer.refusals > 0;
  if (answer.choice === null && !refused) {
    play.history.push({ position, stage: "action", choice: null, refused, probabilities: answer.probabilities });
    play.exit = "failed";
    return;
  }
  const action = answer.choice ?? "lock";
  const step: Step = { position, stage: "action", choice: answer.choice, refused, probabilities: answer.probabilities };
  play.history.push(step);
  if (action === "walk") {
    play.exit = "walked";
    return;
  }
  if (action !== "lock") {
    const lifeline = play.lifelinesLeft.find((l) => l === action);
    // The menu only offers lifelines still in hand; anything else is a protocol error, not a move.
    if (!lifeline) throw new Error(`${play.game.id}@${position}: "${action}" is not a lifeline in hand`);
    play.lifelinesLeft = play.lifelinesLeft.filter((l) => l !== lifeline);
    play.lifelinesUsed.push({ lifeline, position });
    const spot: Spot = { seed, gameId: play.game.id, position, answer: rung.question.answer };
    if (lifeline === "fifty_fifty") play.removed = fiftyFifty(spot);
    if (lifeline === "ask_the_audience") play.audience = askTheAudience(spot, remainingOf(play));
    if (lifeline === "phone_a_friend") play.friend = phoneAFriend(spot, remainingOf(play));
    play.pick = null;
    play.stage = "answer";
    return;
  }
  const correct = play.pick!.choice === rung.question.answer;
  step.correct = correct;
  if (!correct) {
    play.bank = guaranteed(play);
    play.exit = "wrong";
    return;
  }
  play.correct++;
  play.bank = play.game.ladder[play.correct - 1];
  advance(play);
}

/**
 * Type 2 (lock in or walk) / Type 3 (plus lifelines): every game advances in lockstep. Each
 * round sends one answer step for every game still playing, then one action step for each of
 * them; each step is its own batch of requests. A game leaves when it answers wrong, walks,
 * wins, runs out of questions (cutoff mode), or a call fails.
 */
export async function playGames(
  client: DecisionClient,
  games: Game[],
  opts: { seed: number; lifelines: boolean; walk: boolean; runType: string; batch: number; concurrency: number; out: URL },
) {
  const plays: Play[] = games.map((game) => ({
    game,
    pos: 0,
    bank: 0,
    exit: null,
    stage: "answer",
    pick: null,
    lifelinesLeft: opts.lifelines ? [...LIFELINES] : [],
    lifelinesUsed: [],
    removed: [],
    audience: null,
    friend: null,
    correct: 0,
    refused: 0,
    history: [],
    winnings: null,
  }));
  const context = gameContext(opts.lifelines);
  let rounds = 0;
  let calls = 0;
  let costUsd = 0;
  let costMissing = 0;
  const refusedSteps: Record<Stage, number> = { answer: 0, action: 0 };

  const step = async (stage: Stage, active: Play[]) => {
    const entries = active.map((play, i) => ({ play, item: (stage === "answer" ? answerItem : actionItem)(play, `g${i}`) }));
    const results = await pool(
      pack(entries, (e) => e.item, client.decider, opts.batch).map((batch, b) => async () => {
        const result = await client.decide(
          batch.map((e) => e.item),
          {
            type: opts.runType,
            round: rounds,
            stage,
            batch: b,
            games: Object.fromEntries(batch.map((e) => [e.item.id, `${e.play.game.id}@${e.play.pos + 1}`])),
          },
          stage === "answer" ? QUESTION_CONTEXT : context,
        );
        return { batch, result };
      }),
      opts.concurrency,
    );
    for (const { batch, result } of results) {
      calls += result.calls;
      costUsd += result.costUsd;
      costMissing += result.costMissingCalls;
      for (const { play, item } of batch) {
        const answer = result.answers[item.id];
        if (answer.choice === null && answer.refusals > 0) refusedSteps[stage]++;
        if (stage === "answer") applyAnswer(play, answer);
        else applyAction(play, answer, opts.seed);
      }
    }
  };

  const wallStart = performance.now();
  for (let active = plays; active.length; active = plays.filter((p) => p.exit === null)) {
    for (const play of active) passSkipped(play);
    const asking = active.filter((p) => p.exit === null);
    if (!asking.length) continue;
    rounds++;
    // Every game still playing starts a round on an answer step (a new question or a changed board).
    await step("answer", asking);
    const deciding = asking.filter((p) => p.exit === null && p.stage === "action");
    // Lock-in games (no walking, no lifelines) have one possible move: no request needed.
    if (!opts.walk && !opts.lifelines) {
      for (const play of deciding) applyAction(play, { choice: "lock", probabilities: null, confidence: null, error: null, refusals: 0, attempted: true }, opts.seed);
    } else await step("action", deciding);
  }
  const wallMs = performance.now() - wallStart;

  // Lifelines are spent once per game, and only ones that were in hand.
  for (const p of plays) {
    const used = p.lifelinesUsed.map((u) => u.lifeline);
    if (new Set(used).size !== used.length || (!opts.lifelines && used.length)) {
      throw new Error(`${p.game.id}: lifelines spent wrongly: ${used.join(", ")}`);
    }
  }

  for (const play of plays) play.winnings = play.exit === "failed" || play.exit === "unfinished" ? null : play.bank;
  await appendFile(
    opts.out,
    plays
      .map((p) =>
        JSON.stringify({
          decider: client.decider.id,
          game: p.game.id,
          page: p.game.page,
          currency: p.game.currency,
          exit: p.exit,
          reached: p.pos + 1,
          correct: p.correct,
          refused: p.refused,
          winnings: p.winnings,
          borrowedRungs: p.game.rungs.filter((r) => r.borrowed).length,
          lifelinesUsed: p.lifelinesUsed,
          history: p.history,
        }),
      )
      .join("\n") + "\n",
  );

  const scored = plays.filter((p) => p.winnings !== null);
  const winningsByCurrency: Record<string, number> = {};
  for (const p of scored) winningsByCurrency[p.game.currency] = (winningsByCurrency[p.game.currency] ?? 0) + p.winnings!;
  const exits: Record<string, number> = {};
  for (const p of plays) exits[p.exit!] = (exits[p.exit!] ?? 0) + 1;
  const lockIns = plays.flatMap((p) => p.history.filter((h) => h.correct !== undefined));
  const lifelinesUsed: Record<string, number> = {};
  for (const u of plays.flatMap((p) => p.lifelinesUsed)) lifelinesUsed[u.lifeline] = (lifelinesUsed[u.lifeline] ?? 0) + 1;
  const walkPositions: Record<string, number> = {};
  for (const p of plays.filter((p) => p.exit === "walked")) walkPositions[p.pos + 1] = (walkPositions[p.pos + 1] ?? 0) + 1;

  return {
    decider: client.decider.id,
    games: plays.length,
    scoredGames: scored.length,
    exits,
    winningsByCurrency,
    meanWinningsByCurrency: Object.fromEntries(
      Object.entries(winningsByCurrency).map(([c, total]) => [c, total / scored.filter((p) => p.game.currency === c).length]),
    ),
    answered: lockIns.length,
    answeredCorrectly: lockIns.filter((h) => h.correct).length,
    walkAwaysAtQuestion: walkPositions,
    lifelinesUsed,
    rounds,
    calls,
    costUsd,
    costMissingCalls: costMissing,
    refusedSteps,
    skippedPassed: plays.reduce((n, p) => n + p.history.filter((h) => h.stage === "skip").length, 0),
    wallMs,
  };
}
