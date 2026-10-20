import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { decideItems, decisionRequest, DECISIONS_URL, prop, readCall, type Budget, type CallResult, type DecideResult, type Decider, type DecisionItem, type Transport } from "../shared/decisions";

export { Budget, pack, RETRY_DELAYS_MS, type DecisionItem, type ItemAnswer } from "../shared/decisions";

/** A successful response recorded in an earlier run's calls.jsonl, by the sha256 of its exact request. */
export interface Recorded {
  runId: string;
  latencyMs: number;
  text: string;
}
export type Replay = Map<string, Recorded>;

const requestKey = (request: unknown) => createHash("sha256").update(JSON.stringify(request)).digest("hex");

/**
 * Every successful response in an interrupted run's ledger, keyed by its request. Runs are
 * deterministic given the seed and the answers, so a resumed run sends the same requests in the
 * same order and reuses these instead of paying for them again.
 */
export async function loadReplay(runDir: string): Promise<Replay> {
  const runId = ((await Bun.file(`${runDir}/manifest.json`).json()) as { runId: string }).runId;
  const replay: Replay = new Map();
  const decoder = new TextDecoder();
  let buffer = "";
  const take = (line: string) => {
    if (!line) return;
    const call = JSON.parse(line) as { status: string; request: unknown; response: unknown; latencyMs: number };
    if (call.status === "ok") replay.set(requestKey(call.request), { runId, latencyMs: call.latencyMs, text: JSON.stringify(call.response) });
  };
  for await (const chunk of Bun.file(`${runDir}/calls.jsonl`).stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  }
  take(buffer.trim());
  return replay;
}

export class DecisionClient {
  /** Recorded latency of the responses reused from `replay`, for the run's wall time. */
  replayedMs = 0;

  constructor(
    readonly decider: Decider,
    private readonly apiKey: string,
    private readonly ledger: URL,
    private readonly timeoutMs: number,
    private readonly budget: Budget,
    private readonly replay: Replay = new Map(),
  ) {}

  /**
   * Decides every item (shared/decisions.ts `decideItems`: refusals asked alone, oversized
   * requests split, transient failures resent), logging each request. Items left when the budget
   * runs out are marked unattempted. `context` is the request state when the items carry no
   * state of their own.
   */
  decide(items: DecisionItem[], meta: Record<string, unknown>, context = ""): Promise<DecideResult> {
    return decideItems(items, (batch, attempt) => this.send(batch, { ...meta, attempt }, context), Bun.sleep);
  }

  /** Sends one request (or reuses its recorded response); returns null without calling when the budget is exhausted. */
  private async send(items: DecisionItem[], meta: Record<string, unknown>, context: string): Promise<CallResult | null> {
    if (this.budget.exhausted) return null;
    const request = decisionRequest(this.decider, items, context);
    const recorded = this.replay.get(requestKey(request));
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let transport: Transport;
    let httpStatus: number | null = null;
    if (recorded) {
      httpStatus = 200;
      transport = { httpStatus: 200, ok: true, text: recorded.text };
    } else {
      try {
        const res = await fetch(DECISIONS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        httpStatus = res.status;
        transport = { httpStatus: res.status, ok: res.ok, text: await res.text() };
      } catch (e) {
        transport = { networkError: e instanceof Error ? e.message : String(e) };
      }
    }
    const latencyMs = recorded ? recorded.latencyMs : performance.now() - t0;
    if (recorded) this.replayedMs += recorded.latencyMs;
    const result = readCall(items, transport);
    // Reused responses were paid for by the earlier run: they count in the answers' cost, not this run's spend.
    if (result.costUsd !== null && !recorded) this.budget.spent += result.costUsd;
    const { response } = result;
    const model = prop(response, "model");
    const provider = prop(response, "provider");
    const generationId = prop(response, "id");
    await appendFile(
      this.ledger,
      JSON.stringify({
        decider: this.decider.id,
        startedAt,
        latencyMs,
        status: result.status,
        httpStatus,
        error: result.error,
        meta,
        items: items.length,
        realizedModel: typeof model === "string" ? model : null,
        provider: typeof provider === "string" ? provider : null,
        generationId: typeof generationId === "string" ? generationId : null,
        usage: prop(response, "usage") ?? null,
        costUsd: result.costUsd,
        replayedFrom: recorded?.runId ?? null,
        request,
        response,
      }) + "\n",
    );
    return result;
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
