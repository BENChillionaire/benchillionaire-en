// Merges finished runs of one frozen workload into one run, so models benchmarked later sit beside
// the rest. Every random draw comes from the seed, so runs of the same type, version and seed face
// identical questions, games and luck whatever deciders they ran; this checks that and refuses
// anything else.
//
//   bun bench/merge-runs.ts runs/<base run> runs/<run> [runs/<run> …] [--out runs/<dir>]
//
// The merged run lists the deciders in argument order, concatenates the ledgers (calls.jsonl, and
// questions.jsonl or games.jsonl) and summaries, and records the source runs in `mergedFrom`.
// Default output: runs/<base run id>+<added decider ids>/.

import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";

interface Manifest {
  runId: string;
  runType: string;
  startedAt: string;
  corpus: unknown;
  seed: number;
  benchmark: { name: string; frozen: boolean };
  deciders: { id: string }[];
  prompts: { sha256: string };
  policy: Record<string, unknown>;
  type1?: unknown;
  games?: unknown;
  mergedFrom?: string[];
}
interface Summary {
  spentUsd: number;
  stoppedByBudget: boolean;
  results: unknown[];
}

const { values: flags, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string" } } });
const dirs = positionals.map((d) => d.replace(/\/$/, ""));
if (dirs.length < 2) throw new Error("Usage: bun bench/merge-runs.ts <base run> <run> [<run> …] [--out <dir>]");

const runs = await Promise.all(
  dirs.map(async (dir) => {
    const summary = Bun.file(`${dir}/summary.json`);
    if (!(await summary.exists())) throw new Error(`${dir} has no summary.json: merge finished runs only.`);
    return { dir, manifest: (await Bun.file(`${dir}/manifest.json`).json()) as Manifest, summary: (await summary.json()) as Summary };
  }),
);

/** What must match for runs to be one workload: everything but the deciders, ids, times and spend cap. */
const workload = ({ runType, corpus, seed, benchmark, prompts, policy, type1, games }: Manifest) =>
  JSON.stringify({ runType, corpus, seed, benchmark, prompts: prompts.sha256, policy: { ...policy, maxUsd: null }, type1, games });
const base = runs[0];
for (const run of runs.slice(1)) {
  if (workload(run.manifest) !== workload(base.manifest)) {
    throw new Error(`${run.dir} is not the same workload as ${base.dir} (run type, corpus, seed, version, prompts, policy, questions or games differ).`);
  }
}
if (!base.manifest.benchmark.frozen) throw new Error(`${base.dir} is not a frozen benchmark run.`);
const ids = runs.flatMap((r) => r.manifest.deciders.map((d) => d.id));
const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
if (repeated.length) throw new Error(`Decider${repeated.length > 1 ? "s" : ""} ${[...new Set(repeated)].join(", ")} appear in more than one run.`);

const added = runs.slice(1).flatMap((r) => r.manifest.deciders.map((d) => d.id));
const runId = `${base.manifest.runId}+${added.join("+")}`;
const out = (flags.out ?? `${new URL("../runs/", import.meta.url).pathname}${runId}`).replace(/\/$/, "");
if (await Bun.file(`${out}/manifest.json`).exists()) throw new Error(`${out} already exists.`);
await mkdir(out, { recursive: true });

const ledger = base.manifest.runType === "type1" || base.manifest.runType === "latency" ? "questions.jsonl" : "games.jsonl";
for (const file of ["calls.jsonl", ledger]) {
  const writer = Bun.file(`${out}/${file}`).writer();
  for (const { dir } of runs) {
    let last = 10;
    for await (const chunk of Bun.file(`${dir}/${file}`).stream()) {
      writer.write(chunk);
      if (chunk.length) last = chunk[chunk.length - 1];
    }
    // Keep one JSON object per line across the seam.
    if (last !== 10) writer.write("\n");
  }
  await writer.end();
}

const manifest: Manifest = {
  ...base.manifest,
  runId,
  startedAt: runs.map((r) => r.manifest.startedAt).sort()[0],
  deciders: runs.flatMap((r) => r.manifest.deciders),
  policy: { ...base.manifest.policy, maxUsd: runs.reduce((sum, r) => sum + Number(r.manifest.policy.maxUsd), 0) },
  mergedFrom: runs.flatMap((r) => r.manifest.mergedFrom ?? [r.manifest.runId]),
};
const summary = {
  runId,
  spentUsd: runs.reduce((sum, r) => sum + r.summary.spentUsd, 0),
  stoppedByBudget: runs.some((r) => r.summary.stoppedByBudget),
  results: runs.flatMap((r) => r.summary.results),
};
await Bun.write(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
await Bun.write(`${out}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(`merged ${runs.length} runs (${ids.join(", ")}) into ${out}`);
