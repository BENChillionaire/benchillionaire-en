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
  /** Country of the version it aired on, so local questions can be answered for that country. */
  country: string | null;
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
  /** "not_a_question": dropped by data/corrections.json (no factual answer, or options that don't fit the question). */
  type: "multiple_choice" | "order" | "not_a_question";
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
/**
 * Shows in an English-language country that were not in English: South Africa's Afrikaans version
 * and India's regional-language versions (KBC itself is kept, see above).
 */
const NOT_ENGLISH: Record<string, true> = {
  "Wie Word 'n Miljoenêr?": true,
  "Ningalkkum Aakaam Kodeeshwaran": true,
  "Kus Bani Koshur Crorepati": true,
  Kodeeswari: true,
  "Kannadada Kotyadhipati": true,
  "Ke Bani Crorepati": true,
  "Kon Hoeel Marathi Crorepati": true,
  "Ke Hobe Banglar Kotipoti": true,
  "Evaru Meelo Koteeswarudu": true,
};

/**
 * Pages whose wiki infobox names the wrong version, by page title: the version the questions
 * actually aired on, checked against the page's prizes and questions (2026-10-19), or null for
 * pages that record no real airing (parodies, pranks, fictional contestants, a page mixing versions).
 */
const PAGE_COUNTRY: Record<string, string | null> = {
  "Paul Nolan (UK)": "UK",
  "Who Wants to Be a Millionaire? (Australia)": "Australia",
  "Who Wants to Be a Millionaire (USA)": "USA",
  "David Thompson (U.S. Season 15)": "USA",
  "Aamir Khan": "Turkey",
  "Qui veut gagner des millions? (France)": "France",
  "Who Wants to Be a Millionaire? (Philippines)": "Philippines",
  Milionerzy: "Poland",
  "Kto khochet stat' millionerom?": "Russia",
  "Who Wants to Be a Millionaire? (UK version)": null,
  "Kaun Banega Crorepati": null,
  "50:50": null,
  "Paul Lassiter": null,
  "Vem vill bli miljonär?": null,
  "Jamal Malik": null,
};

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
  /** The questions with data/corrections.json applied. */
  shows: CorpusShow[];
  /** Question key → reasons it is skipped (bench/scan.ts writes the list). */
  skip: Record<string, string[]>;
  skipSha256: string;
  correctionsSha256: string;
  /** Null where the file is absent, as in the public repo (whose corpus has the held-out questions blanked). */
  holdout: Holdout | null;
}

/**
 * One entry of data/corrections.json, keyed by question key: the answer as of the air date where
 * the wiki's key is wrong (`was` is the wiki's), or `answer: null` to drop an item that can't be
 * asked as recorded (no factual answer, or options from another question). Answers are option
 * text, so each entry reads on its own and is checked against
 * the corpus on load.
 */
export interface Correction {
  question: string;
  answer: string | null;
  was: string;
}

const CORPUS_PATH = new URL("../data/millionaire_questions.json", import.meta.url);
const SKIP_PATH = new URL("../data/skip-questions.json", import.meta.url);
const CORRECTIONS_PATH = new URL("../data/corrections.json", import.meta.url);
const HOLDOUT_PATH = new URL("../data/holdout.json", import.meta.url);

const keySet = (keys: string[]): Record<string, true> => Object.fromEntries(keys.map((k) => [k, true]));

function applyCorrections(shows: CorpusShow[], corrections: Record<string, Correction>) {
  for (const [key, c] of Object.entries(corrections)) {
    const [s, i] = key.split(":").map(Number);
    const q = shows[s]?.questions[i];
    if (!q || q.question !== c.question || q.options[q.answer as Letter] !== c.was) {
      throw new Error(`data/corrections.json: ${key} does not match the corpus`);
    }
    if (c.answer === null) {
      q.type = "not_a_question";
      continue;
    }
    const letters = LETTERS.filter((l) => q.options[l] === c.answer);
    if (letters.length !== 1) throw new Error(`data/corrections.json: ${key} answer "${c.answer}" is not exactly one option`);
    q.answer = letters[0];
  }
}

/** data/corrections.json as written: one entry per line, keys in corpus order. */
export function correctionsJson(corrections: Record<string, unknown>): string {
  const order = (key: string) => key.split(":").map(Number);
  const keys = Object.keys(corrections).sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  return `{\n${keys.map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(corrections[key])}`).join(",\n")}\n}\n`;
}

export async function loadCorpus(): Promise<Corpus> {
  const hash = (bytes: ArrayBuffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const bytes = await Bun.file(CORPUS_PATH).arrayBuffer();
  const skipBytes = await Bun.file(SKIP_PATH).arrayBuffer();
  const correctionBytes = await Bun.file(CORRECTIONS_PATH).arrayBuffer();
  const { shows } = JSON.parse(new TextDecoder().decode(bytes)) as { shows: CorpusShow[] };
  const { questions: skip } = JSON.parse(new TextDecoder().decode(skipBytes)) as { questions: Record<string, string[]> };
  applyCorrections(shows, JSON.parse(new TextDecoder().decode(correctionBytes)) as Record<string, Correction>);
  for (const show of shows) if (Object.hasOwn(PAGE_COUNTRY, show.page)) show.country = PAGE_COUNTRY[show.page];
  const holdoutFile = Bun.file(HOLDOUT_PATH);
  const held = (await holdoutFile.exists())
    ? ((await holdoutFile.json()) as { games: string[]; questions: string[]; droppedPublicGames: string[] })
    : null;
  const holdout = held && { games: keySet(held.games), questions: keySet(held.questions), droppedGames: keySet(held.droppedPublicGames) };
  return { sha256: hash(bytes), shows, skip, skipSha256: hash(skipBytes), correctionsSha256: hash(correctionBytes), holdout };
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
    country: show.country,
    skip: corpus.skip[key] ?? [],
    heldOut: Boolean(corpus.holdout?.questions[key]),
  };
}

/** Every multiple-choice question in the en-benchmark (main ladder and Fastest Finger), skipped ones included. */
export function allMcQuestions(corpus: Corpus): McQuestion[] {
  return corpus.shows.flatMap((show, s) => show.questions.flatMap((_, i) => toMcQuestion(corpus, s, i) ?? []));
}
