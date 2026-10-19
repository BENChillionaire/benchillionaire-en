import { appendFile } from "node:fs/promises";
import type { Decider } from "./deciders";

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

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

interface CallResult {
  status: CallStatus;
  answers: Record<string, ItemAnswer>;
  costUsd: number | null;
  /** Question id the provider named when it refused the whole request (OpenRouter → OpenAI Decisions). */
  refusedId: string | null;
  /** Provider rejected the request for exceeding a size or question-count limit. */
  tooLarge: boolean;
  /** Network failure, rate limit or server error that was not a refusal: worth sending again. */
  transient: boolean;
}

/** Waits before each resend of a transient failure; its length is the number of retries. */
export const RETRY_DELAYS_MS = [1_000, 4_000, 15_000];

export interface DecideResult {
  answers: Record<string, ItemAnswer>;
  calls: number;
  costUsd: number;
  costMissingCalls: number;
}

/** Shared spend cap: once reported spend reaches maxUsd, no new call starts. */
export class Budget {
  spent = 0;
  constructor(readonly maxUsd: number) {}
  get exhausted() {
    return this.spent >= this.maxUsd;
  }
}

/** Reads one own property of untrusted JSON; undefined when the value is not an object or lacks the key. */
function prop(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined;
}

export class DecisionClient {
  constructor(
    readonly decider: Decider,
    private readonly apiKey: string,
    private readonly ledger: URL,
    private readonly timeoutMs: number,
    private readonly budget: Budget,
  ) {}

  /**
   * Decides every item. A request the provider refuses because of one named question is
   * re-sent without that question, and the refused question is then asked on its own; a
   * request rejected for size is split in half. Each follow-up is a separate, logged request
   * whose cost and time count toward the run. Other failures (HTTP, network, protocol) are
   * not retried. Items left when the budget runs out are marked unattempted. `context` is
   * the request state when the items carry no state of their own.
   */
  async decide(items: DecisionItem[], meta: Record<string, unknown>, context = ""): Promise<DecideResult> {
    const answers: Record<string, ItemAnswer> = {};
    const refusals: Record<string, number> = {};
    let calls = 0;
    let costUsd = 0;
    let costMissingCalls = 0;
    const run = async (batch: DecisionItem[], attempt: string): Promise<void> => {
      let result = await this.send(batch, { ...meta, attempt }, context);
      // Transport failures (network, rate limit, server error) are retried; refusals never are.
      for (const [i, delay] of RETRY_DELAYS_MS.entries()) {
        if (!result?.transient) break;
        calls++;
        if (result.costUsd !== null) costUsd += result.costUsd;
        await Bun.sleep(delay);
        result = await this.send(batch, { ...meta, attempt: `${attempt}-retry-${i + 1}` }, context);
      }
      if (!result) {
        for (const item of batch) {
          answers[item.id] = {
            choice: null,
            probabilities: null,
            confidence: null,
            error: "unattempted: budget reached",
            refusals: 0,
            attempted: false,
          };
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

  /** Sends one request; returns null without calling when the budget is exhausted. */
  private async send(items: DecisionItem[], meta: Record<string, unknown>, context: string): Promise<CallResult | null> {
    if (this.budget.exhausted) return null;
    const own = items.filter((item) => item.state !== undefined);
    const request = {
      model: this.decider.model,
      provider: { order: [this.decider.provider], allow_fallbacks: false },
      state: own.length ? Object.fromEntries(own.map((item) => [item.id, item.state])) : context,
      questions: Object.fromEntries(
        items.map((item) => [item.id, { type: "choice", instructions: item.instructions, criteria: item.options }]),
      ),
    };
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let status: CallStatus = "ok";
    let httpStatus: number | null = null;
    let error: string | null = null;
    let response: unknown = null;
    try {
      const res = await fetch(DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      httpStatus = res.status;
      const text = await res.text();
      try {
        response = JSON.parse(text);
      } catch {
        response = text;
      }
      if (!res.ok) {
        status = "http_error";
        error = text.slice(0, 500);
      }
    } catch (e) {
      status = "network_error";
      error = e instanceof Error ? e.message : String(e);
    }
    const latencyMs = performance.now() - t0;

    const usage = prop(response, "usage");
    const cost = prop(usage, "cost");
    const costUsd = typeof cost === "number" ? cost : null;
    if (costUsd !== null) this.budget.spent += costUsd;

    const answersJson = prop(response, "answers");
    if (status === "ok" && (typeof answersJson !== "object" || answersJson === null)) {
      status = "protocol_error";
      error = "Response has no answers object.";
    }
    const answers: Record<string, ItemAnswer> = {};
    for (const item of items) {
      if (status !== "ok") {
        answers[item.id] = {
          choice: null,
          probabilities: null,
          confidence: null,
          error: `${status}: ${error}`,
          refusals: 0,
          attempted: true,
        };
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
            ? Object.fromEntries(
                Object.entries(probabilities).filter((e): e is [string, number] => typeof e[1] === "number"),
              )
            : null,
        confidence: typeof confidence === "number" ? confidence : null,
        error:
          answer === undefined ? "missing answer" : valid ? null : `choice outside options: ${JSON.stringify(choice)}`,
        refusals: 0,
        attempted: true,
      };
    }

    const model = prop(response, "model");
    const provider = prop(response, "provider");
    const generationId = prop(response, "id");
    await appendFile(
      this.ledger,
      JSON.stringify({
        decider: this.decider.id,
        startedAt,
        latencyMs,
        status,
        httpStatus,
        error,
        meta,
        items: items.length,
        realizedModel: typeof model === "string" ? model : null,
        provider: typeof provider === "string" ? provider : null,
        generationId: typeof generationId === "string" ? generationId : null,
        usage: usage ?? null,
        costUsd,
        request,
        response,
      }) + "\n",
    );
    const refusedId = status === "http_error" ? (error?.match(/refused to answer question \\?"(\w+)\\?"/)?.[1] ?? null) : null;
    const tooLarge =
      status === "http_error" &&
      (httpStatus === 400 || httpStatus === 413 || httpStatus === 422) &&
      /at most|limit is|too large|exceed/i.test(error ?? "");
    const transient =
      status === "network_error" || (status === "http_error" && refusedId === null && (httpStatus === 429 || (httpStatus ?? 0) >= 500));
    return { status, answers, costUsd, refusedId, tooLarge, transient };
  }
}

/** Runs async tasks with at most `limit` in flight; Infinity means all at once. */
export async function pool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(tasks.length, Number.isFinite(limit) ? limit : tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
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
      JSON.stringify({ [item.id]: item.state, q: { type: "choice", instructions: item.instructions, criteria: item.options } })
        .length / decider.charsPerToken;
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
