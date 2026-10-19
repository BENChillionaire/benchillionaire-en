/**
 * Deciders reachable through OpenRouter's Decisions API (POST /api/alpha/decisions).
 * Each request is pinned to the model's first-party provider with fallbacks off,
 * so the realized provider stays fixed across a run.
 *
 * Requests pack as many questions as the provider accepts (token limit and question
 * limit; see `pack` in decide.ts); `--batch N` caps the count for ablations.
 */
export interface Decider {
  id: string;
  label: string;
  vendor: string;
  model: string;
  /** OpenRouter provider slug the request is pinned to. */
  provider: string;
  /** Per-request input limit in tokens. */
  maxRequestTokens: number;
  /** Per-request question limit enforced by the provider; Infinity when none is documented or observed. */
  maxQuestions: number;
  /**
   * Request JSON characters per input token, measured from reported usage on the
   * 2026-10-16 probe (rounded down so estimates err high). Used only to size packs.
   */
  charsPerToken: number;
}

export const DECIDERS: Decider[] = [
  // TypeSafe models page: 64k tokens per request, no limit on question count.
  {
    id: "jev-1.13",
    label: "Jev 1.13",
    vendor: "TypeSafe",
    model: "typesafe/jev-1.13",
    provider: "typesafe",
    maxRequestTokens: 64_000,
    maxQuestions: Infinity,
    charsPerToken: 2.4,
  },
  {
    id: "jev-1.14",
    label: "Jev 1.14",
    vendor: "TypeSafe",
    model: "typesafe/jev-1.14",
    provider: "typesafe",
    maxRequestTokens: 64_000,
    maxQuestions: Infinity,
    charsPerToken: 2.4,
  },
  // OpenRouter context length 32,768; Azure returned HTTP 422 "the limit is 255" questions on the 2026-10-16 probe.
  {
    id: "microsoft-decision-1",
    label: "Microsoft-Decision-1",
    vendor: "Microsoft",
    model: "microsoft/microsoft-decision-1",
    provider: "azure",
    maxRequestTokens: 32_768,
    maxQuestions: 255,
    charsPerToken: 3.8,
  },
  // OpenRouter context length 1,050,000; OpenAI returned HTTP 400 "accepts at most 200 questions" on the 2026-10-16 probe.
  {
    id: "gpt-6-luna-decisions",
    label: "GPT-6 Luna Decisions",
    vendor: "OpenAI",
    model: "openai/gpt-6-luna-decisions",
    provider: "openai",
    maxRequestTokens: 1_050_000,
    maxQuestions: 200,
    charsPerToken: 2.0,
  },
];
