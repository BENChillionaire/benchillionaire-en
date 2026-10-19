export type Letter = "A" | "B" | "C" | "D";
export const LETTERS: Letter[] = ["A", "B", "C", "D"];

/** One scorable multiple-choice question as aired. */
export interface McQuestion {
  /** `<show index>:<question index>` in data/millionaire_questions.json; stable while the file is unchanged. */
  key: string;
  question: string;
  options: Record<Letter, string>;
  answer: Letter;
  /** Ladder position (1-based) and ladder length, when the wiki recorded them. */
  number: number | null;
  of: number | null;
  /** Prize label as aired, e.g. "£75,000 (8 of 12) - Not Timed". */
  value: string;
  /** Year the show first aired (from the wiki's free-text air date), so "current" questions can be answered as of then. */
  aired: number | null;
  /** Why the question can't be fairly asked (data/skip-questions.json); empty when it can. */
  skip: string[];
  /** In the private held-out set (data/holdout.json): asked privately, never published. */
  heldOut: boolean;
}

export interface CorpusQuestion {
  value: string;
  round: "main" | "fastest_finger";
  number: number | null;
  of: number | null;
  type: "multiple_choice" | "order";
  question: string;
  options: Record<Letter, string>;
  answer: string;
  media?: boolean;
}

export interface CorpusShow {
  page: string;
  url: string;
  page_type: "contestant" | "other";
  show: string | null;
  country: string | null;
  /** What the contestant won, as the wiki records it (free text, e.g. "£32,000" or "$125,000 (in 2000) $32,000 (in 2021)"). */
  money_won?: string | null;
  /** Free text, e.g. "November 7–8, 2006" or "To HS: 16–23 September 2006". */
  air_date: string | null;
  questions: CorpusQuestion[];
}

/**
 * The year a show's main-game questions were asked, from the wiki's free-text air date. Repeat
 * contestants list several dates ("To FFF: 13 November 1999 … To HS: 14–21 January 2006"): the
 * hot-seat date counts. Several dates with no hot-seat marker are ambiguous, so the year is unknown.
 */
export function airedYear(airDate: string | null): number | null {
  if (!airDate) return null;
  const hotSeat = airDate.search(/\bHS\b|hot ?seat/i);
  const text = hotSeat >= 0 ? airDate.slice(hotSeat) : airDate;
  const years = [...text.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  if (!years.length) return null;
  if (hotSeat >= 0 || Math.max(...years) - years[0] <= 1) return years[0];
  return null;
}

/**
 * English-language versions: the en-benchmark. Other versions reach the wiki as volunteer
 * translations, where puns and answer keys often break ("goddess of victory" → Athena). India's
 * questions are kept: they are mostly asked bilingually and read cleanly in English.
 */
export const EN_COUNTRIES: Record<string, true> = {
  UK: true,
  USA: true,
  India: true,
  Australia: true,
  Ireland: true,
  "New Zealand": true,
  "South Africa": true,
  Canada: true,
  Nigeria: true,
  Ghana: true,
  Uganda: true,
  Kenya: true,
};
/** Shows in an English-language country that were not in English. */
const NOT_ENGLISH: Record<string, true> = { "Wie Word 'n Miljoenêr?": true };

export const inEnBenchmark = (show: CorpusShow) =>
  Boolean(show.country && EN_COUNTRIES[show.country] && !(show.show && NOT_ENGLISH[show.show]));

/**
 * The private held-out set (bench/holdout.ts writes it; it is never published). Records of keys
 * and game ids: held-out games, every question they took out, and public games dropped because
 * they contain one of those questions.
 */
export interface Holdout {
  games: Record<string, true>;
  questions: Record<string, true>;
  droppedGames: Record<string, true>;
}

export interface Corpus {
  sha256: string;
  shows: CorpusShow[];
  /** Question key → reasons it is skipped (bench/scan.ts writes the list). */
  skip: Record<string, string[]>;
  skipSha256: string;
  /** Null where the file is absent, as in the public repo (whose corpus has the held-out questions blanked). */
  holdout: Holdout | null;
}

const CORPUS_PATH = new URL("../data/millionaire_questions.json", import.meta.url);
const SKIP_PATH = new URL("../data/skip-questions.json", import.meta.url);
const HOLDOUT_PATH = new URL("../data/holdout.json", import.meta.url);

const keySet = (keys: string[]): Record<string, true> => Object.fromEntries(keys.map((k) => [k, true]));

export async function loadCorpus(): Promise<Corpus> {
  const hash = (bytes: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const bytes = await Bun.file(CORPUS_PATH).arrayBuffer();
  const skipBytes = await Bun.file(SKIP_PATH).arrayBuffer();
  const { shows } = JSON.parse(new TextDecoder().decode(bytes)) as { shows: CorpusShow[] };
  const { questions: skip } = JSON.parse(new TextDecoder().decode(skipBytes)) as { questions: Record<string, string[]> };
  const holdoutFile = Bun.file(HOLDOUT_PATH);
  const held = (await holdoutFile.exists())
    ? ((await holdoutFile.json()) as { games: string[]; questions: string[]; droppedPublicGames: string[] })
    : null;
  const holdout = held && { games: keySet(held.games), questions: keySet(held.questions), droppedGames: keySet(held.droppedPublicGames) };
  return { sha256: hash(bytes), shows, skip, skipSha256: hash(skipBytes), holdout };
}

/**
 * A multiple-choice question from an English-language version, as the benchmark asks it, with
 * the reasons it is skipped (if any): skipped questions stay in their games and pass automatically.
 */
export function toMcQuestion(corpus: Corpus, showIndex: number, questionIndex: number): McQuestion | null {
  const show = corpus.shows[showIndex];
  const q = show.questions[questionIndex];
  if (q.type !== "multiple_choice" || !inEnBenchmark(show)) return null;
  const key = `${showIndex}:${questionIndex}`;
  return {
    key,
    question: q.question,
    options: q.options,
    answer: q.answer as Letter,
    number: q.round === "main" ? q.number : null,
    of: q.round === "main" ? q.of : null,
    value: q.value,
    aired: airedYear(show.air_date),
    skip: corpus.skip[key] ?? [],
    heldOut: Boolean(corpus.holdout?.questions[key]),
  };
}

/** Every multiple-choice question in the en-benchmark (main ladder and Fastest Finger), skipped ones included. */
export function allMcQuestions(corpus: Corpus): McQuestion[] {
  return corpus.shows.flatMap((show, s) => show.questions.flatMap((_, i) => toMcQuestion(corpus, s, i) ?? []));
}
