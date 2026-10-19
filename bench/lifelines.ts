import { LETTERS, type Letter } from "./corpus";
import { sample, stream } from "./rng";

export type Lifeline = "fifty_fifty" | "ask_the_audience" | "phone_a_friend";
export const LIFELINES: Lifeline[] = ["fifty_fifty", "ask_the_audience", "phone_a_friend"];

/**
 * Probability that Ask the Audience / Phone a Friend point at the correct answer,
 * by question level 1–5, 6–10, 11–15 (positions above 15 use the 11–15 rate).
 * Source: Franzen & Pointner (2009), Zeitschrift für Soziologie 38.
 */
const SUCCESS_RATES = {
  ask_the_audience: [1.0, 0.923, 0.69],
  phone_a_friend: [1.0, 0.714, 0.306],
} as const;

export function successRate(lifeline: "ask_the_audience" | "phone_a_friend", position: number): number {
  return SUCCESS_RATES[lifeline][position <= 5 ? 0 : position <= 10 ? 1 : 2];
}

/**
 * Every draw is keyed by (run seed, game, position, lifeline), never by which decider
 * asks or in what order, so deciders that reach the same spot see the same outcome.
 */
export interface Spot {
  seed: number;
  gameId: string;
  position: number;
  answer: Letter;
}

const wrongLetters = (answer: Letter) => LETTERS.filter((l) => l !== answer);

/** 50:50 removes two wrong answers chosen by the seed. */
export function fiftyFifty(spot: Spot): Letter[] {
  return sample(wrongLetters(spot.answer), 2, stream(spot.seed, "fifty_fifty", spot.gameId, spot.position));
}

/**
 * Which answer the lifeline points at. Success is drawn first, then a fixed order of
 * the wrong answers; on failure the first wrong answer still on the board is used, so
 * a prior 50:50 changes only which wrong answer can appear, not the success draw.
 */
function pointedAnswer(spot: Spot, lifeline: "ask_the_audience" | "phone_a_friend", remaining: Letter[]): Letter {
  const rand = stream(spot.seed, lifeline, spot.gameId, spot.position);
  const success = rand() < successRate(lifeline, spot.position);
  const wrongOrder = sample(wrongLetters(spot.answer), 3, rand);
  return success ? spot.answer : (wrongOrder.find((l) => remaining.includes(l)) ?? spot.answer);
}

export function phoneAFriend(spot: Spot, remaining: Letter[]): Letter {
  return pointedAnswer(spot, "phone_a_friend", remaining);
}

const AUDIENCE_SIZE = 100;

/**
 * 100 simulated voters over the answers still on the board. The pointed answer gets a
 * base share of 35–80%; the rest is split with random weights; each voter then draws
 * independently, which adds sampling noise. The pointed answer is forced to a strict
 * plurality afterwards. Returns whole-number votes summing to 100 (= percentages).
 */
export function askTheAudience(spot: Spot, remaining: Letter[]): Record<Letter, number> {
  const leader = pointedAnswer(spot, "ask_the_audience", remaining);
  const rand = stream(spot.seed, "audience_votes", spot.gameId, spot.position, remaining.join(""));
  const others = remaining.filter((l) => l !== leader);
  const leaderWeight = 0.35 + 0.45 * rand();
  const raw = others.map(() => 0.3 + 0.7 * rand());
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const weights = [leaderWeight, ...raw.map((w) => (w / rawSum) * (1 - leaderWeight))];
  const letters = [leader, ...others];

  const votes = letters.map(() => 0);
  for (let v = 0; v < AUDIENCE_SIZE; v++) {
    let r = rand();
    let i = 0;
    while (i < weights.length - 1 && r >= weights[i]) r -= weights[i++];
    votes[i]++;
  }
  // Force a strict plurality for the pointed answer without changing the total.
  const top = votes.slice(1).reduce((best, v, j) => (v > votes[best] ? j + 1 : best), 1);
  if (votes.length > 1 && votes[top] >= votes[0]) [votes[0], votes[top]] = [votes[top], votes[0]];
  for (let j = 1; j < votes.length; j++) {
    if (votes[j] === votes[0] && votes[j] > 0) {
      votes[j]--;
      votes[0]++;
    }
  }
  return Object.fromEntries(letters.map((l, i) => [l, votes[i]])) as Record<Letter, number>;
}
