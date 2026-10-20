/**
 * OpenRouter's Decisions API (POST /api/alpha/decisions), shared by the benchmark (bench/decide.ts)
 * and EZBench (worker/ezbench-run.ts) so both send identical requests and read answers the same
 * way. Pure protocol only: request bodies, response parsing, packing, the refusal/split/retry
 * loop and the decider list. Transport (fetch, timeouts, logging) belongs to each caller, and no
 * Bun- or Workers-only global may be used here.
 */

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/**
 * Deciders reachable through the Decisions API. Each request is pinned to the model's first-party
 * provider with fallbacks off, so the realized provider stays fixed across a run.
 *
 * Requests pack as many questions as the provider accepts (token limit and question limit; see
 * `pack`); the benchmark's `--batch N` caps the count for ablations.
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
  // OpenRouter context length on the Cloudflare endpoint: 65,536; Workers AI returned HTTP 422 "at most 64 items"
  // questions on the 2026-10-20 probe. Clef is also served by other providers; the pin keeps Cloudflare's own
  // Workers AI deployment.
  {
    id: "clef",
    label: "Clef",
    vendor: "Cloudflare",
    model: "cloudflare/clef",
    provider: "cloudflare",
    maxRequestTokens: 65_536,
    maxQuestions: 64,
    charsPerToken: 1.8,
  },
  {
    id: "clef-omni",
    label: "Clef-omni",
    vendor: "Cloudflare",
    model: "cloudflare/clef-omni",
    provider: "cloudflare",
    maxRequestTokens: 65_536,
    maxQuestions: 64,
    charsPerToken: 1.8,
  },
];

/** One choice question; packed with others into a single request. */
export interface DecisionItem {
  /** Question name in the request; must be unique within a call (letters, digits, underscore). */
  id: string;
  /**
   * Evidence for this item alone, placed at `state.<id>` (instructions must reference that
   * path). Omit when the question carries everything; the request state is then the call's
   * shared context.
   */
  state?: unknown;
  instructions: string;
  /** Option key → description. The model must return one of these keys. */
  options: Record<string, string>;
}

export interface ItemAnswer {
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  /** Why this item has no usable choice (call failure, refusal, missing answer, off-set choice); null when fine. */
  error: string | null;
  /** How many requests the provider refused because of this item. */
  refusals: number;
  /** False when the budget stopped the run before this item was sent. */
  attempted: boolean;
}

export type CallStatus = "ok" | "http_error" | "network_error" | "protocol_error";

/** How one request went, read from its HTTP outcome. */
export interface CallResult {
  status: CallStatus;
  /** Raw failure text (HTTP body excerpt, network or protocol message); null when ok. */
  error: string | null;
  answers: Record<string, ItemAnswer>;
  costUsd: number | null;
  /** Question id the provider named when it refused the whole request (OpenRouter → OpenAI Decisions). */
  refusedId: string | null;
  /** Provider rejected the request for exceeding a size or question-count limit. */
  tooLarge: boolean;
  /** Network failure, rate limit or server error that was not a refusal: worth sending again. */
  transient: boolean;
  /** The parsed response body (or its text when it is not JSON); null when nothing came back. */
  response: unknown;
}

/** What came back for one request: an HTTP status and body, or a network error. */
export type Transport = { httpStatus: number; ok: boolean; text: string } | { networkError: string };

/** Waits before each resend of a transient failure; its length is the number of retries. */
export const RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

/** Shared spend cap: once reported spend reaches maxUsd, no new call starts. */
export class Budget {
  spent = 0;
  constructor(readonly maxUsd: number) {}
  get exhausted() {
    return this.spent >= this.maxUsd;
  }
}

/** Reads one own property of untrusted JSON; undefined when the value is not an object or lacks the key. */
export function prop(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

/** The request body for one call. `context` is the state when no item carries its own. */
export function decisionRequest(decider: Decider, items: DecisionItem[], context: unknown = "") {
  const own = items.filter((item) => item.state !== undefined);
  return {
    model: decider.model,
    provider: { order: [decider.provider], allow_fallbacks: false },
    state: own.length ? Object.fromEntries(own.map((item) => [item.id, item.state])) : context,
    questions: Object.fromEntries(items.map((item) => [item.id, { type: "choice", instructions: item.instructions, criteria: item.options }])),
  };
}

/** Reads one call's outcome: each item's answer, the reported cost, and whether to refuse, split or resend. */
export function readCall(items: DecisionItem[], transport: Transport): CallResult {
  let status: CallStatus = "ok";
  let error: string | null = null;
  let response: unknown = null;
  let httpStatus: number | null = null;
  if ("networkError" in transport) {
    status = "network_error";
    error = transport.networkError;
  } else {
    httpStatus = transport.httpStatus;
    try {
      response = JSON.parse(transport.text);
    } catch {
      response = transport.text;
    }
    if (!transport.ok) {
      status = "http_error";
      error = transport.text.slice(0, 500);
    }
  }

  const cost = prop(prop(response, "usage"), "cost");
  const costUsd = typeof cost === "number" ? cost : null;

  const answersJson = prop(response, "answers");
  if (status === "ok" && (typeof answersJson !== "object" || answersJson === null)) {
    status = "protocol_error";
    error = "Response has no answers object.";
  }
  const answers: Record<string, ItemAnswer> = {};
  for (const item of items) {
    if (status !== "ok") {
      answers[item.id] = { choice: null, probabilities: null, confidence: null, error: `${status}: ${error}`, refusals: 0, attempted: true };
      continue;
    }
    const answer = prop(answersJson, item.id);
    const choice = prop(answer, "choice");
    const probabilities = prop(answer, "probabilities");
    const confidence = prop(answer, "confidence");
    const valid = typeof choice === "string" && Object.hasOwn(item.options, choice);
    answers[item.id] = {
      choice: valid ? choice : null,
      probabilities:
        typeof probabilities === "object" && probabilities !== null
          ? Object.fromEntries(Object.entries(probabilities).filter((e): e is [string, number] => typeof e[1] === "number"))
          : null,
      confidence: typeof confidence === "number" ? confidence : null,
      error: answer === undefined ? "missing answer" : valid ? null : `choice outside options: ${JSON.stringify(choice)}`,
      refusals: 0,
      attempted: true,
    };
  }

  const refusedId = status === "http_error" ? (error?.match(/refused to answer question \\?"(\w+)\\?"/)?.[1] ?? null) : null;
  const tooLarge =
    status === "http_error" && (httpStatus === 400 || httpStatus === 413 || httpStatus === 422) && /at most|limit is|too large|exceed/i.test(error ?? "");
  const transient = status === "network_error" || (status === "http_error" && refusedId === null && (httpStatus === 429 || (httpStatus ?? 0) >= 500));
  return { status, error, answers, costUsd, refusedId, tooLarge, transient, response };
}

export interface DecideResult {
  answers: Record<string, ItemAnswer>;
  calls: number;
  costUsd: number;
  costMissingCalls: number;
}

/**
 * Decides every item. `send` makes one request (null without calling when the budget is spent).
 * A request the provider refuses because of one named question is re-sent without that question,
 * and the refused question is then asked on its own; a request rejected for size is split in
 * half; transport failures are resent after RETRY_DELAYS_MS. Each follow-up is a separate request
 * whose cost counts. Items left when the budget runs out are marked unattempted.
 */
export async function decideItems(
  items: DecisionItem[],
  send: (batch: DecisionItem[], attempt: string) => Promise<CallResult | null>,
  sleep: (ms: number) => Promise<unknown>,
): Promise<DecideResult> {
  const answers: Record<string, ItemAnswer> = {};
  const refusals: Record<string, number> = {};
  let calls = 0;
  let costUsd = 0;
  let costMissingCalls = 0;
  const run = async (batch: DecisionItem[], attempt: string): Promise<void> => {
    let result = await send(batch, attempt);
    // Transport failures (network, rate limit, server error) are retried; refusals never are.
    for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
      if (!result?.transient) break;
      calls++;
      if (result.costUsd !== null) costUsd += result.costUsd;
      await sleep(delay);
      result = await send(batch, `${attempt}-retry-${i + 1}`);
    }
    if (!result) {
      for (const item of batch) {
        answers[item.id] = { choice: null, probabilities: null, confidence: null, error: "unattempted: budget reached", refusals: 0, attempted: false };
      }
      return;
    }
    calls++;
    if (result.costUsd === null) costMissingCalls++;
    else costUsd += result.costUsd;
    const refused = result.refusedId === null ? undefined : batch.find((item) => item.id === result.refusedId);
    if (refused) refusals[refused.id] = (refusals[refused.id] ?? 0) + 1;
    // Retries go one at a time, like the batches themselves.
    if (refused && batch.length > 1) {
      await run(
        batch.filter((item) => item !== refused),
        "resend-without-refused",
      );
      await run([refused], "refused-question-alone");
      return;
    }
    if (result.tooLarge && batch.length > 1) {
      const half = Math.ceil(batch.length / 2);
      await run(batch.slice(0, half), "split-too-large");
      await run(batch.slice(half), "split-too-large");
      return;
    }
    Object.assign(answers, result.answers);
  };
  await run(items, "pack");
  for (const [id, count] of Object.entries(refusals)) answers[id].refusals = count;
  return { answers, calls, costUsd, costMissingCalls };
}

/** Fixed request overhead (model, provider, envelope) in tokens, plus a 15% safety margin on the limit. */
const REQUEST_OVERHEAD_TOKENS = 400;
const LIMIT_MARGIN = 0.85;

/**
 * Greedily packs entries, in order, into requests that fit the decider's per-request
 * input limit, estimating each item's tokens from its serialized state + question size.
 * Packs also stop at the provider's question limit and at `maxCount` (an optional cap). An item larger than the budget
 * still gets its own request (and fails visibly) rather than being dropped.
 */
export function pack<T>(entries: readonly T[], itemOf: (entry: T) => DecisionItem, decider: Decider, maxCount: number): T[][] {
  const budget = decider.maxRequestTokens * LIMIT_MARGIN - REQUEST_OVERHEAD_TOKENS;
  const packs: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const entry of entries) {
    const item = itemOf(entry);
    const tokens =
      JSON.stringify({ [item.id]: item.state, q: { type: "choice", instructions: item.instructions, criteria: item.options } }).length / decider.charsPerToken;
    if (current.length && (used + tokens > budget || current.length >= Math.min(maxCount, decider.maxQuestions))) {
      packs.push(current);
      current = [];
      used = 0;
    }
    current.push(entry);
    used += tokens;
  }
  if (current.length) packs.push(current);
  return packs;
}
