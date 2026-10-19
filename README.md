# benchillionaire-en

A benchmark for **System-1 decision models**: models that take a question and a set of options and
return one choice with a confidence for each option, fast and cheaply. benchillionaire-en asks them
real quiz questions from the English-language versions of *Who Wants to Be a Millionaire?*, and then
lets them play the full game: climbing the money ladder, deciding when to walk away, and when to
spend a lifeline.

Knowing the answer is only half of it. A model that knows 93% of the answers but walks away from
half of the ones it knows wins far less than one that commits.

Play against the models at **https://www.jevillionaire.com**. Not affiliated with the programme or its rights holders.

## Results

| Model | Accuracy | With lifelines | Can walk away | Never walks | Questions/s | One question | $ per 1,000 questions |
|---|---|---|---|---|---|---|---|
| GPT-6 Luna Decisions | 97.1% | $4.07B ($4.00B–$4.15B) | $3.73B ($3.65B–$3.81B) | $4.08B ($4.00B–$4.16B) | 403 | 191 ms | $0.016 |
| Jev 1.14 | 93.3% | $2.21B ($2.14B–$2.28B) | $1.01B ($961M–$1.07B) | $2.36B ($2.28B–$2.44B) | 956 | 150 ms | $0.005 |
| Jev 1.13 | 93.2% | $1.53B ($1.46B–$1.59B) | $1.05B ($996M–$1.10B) | $2.28B ($2.21B–$2.36B) | 850 | 156 ms | $0.005 |
| Microsoft-Decision-1 | 85.5% | $880M ($829M–$931M) | $448M ($413M–$481M) | $511M ($469M–$550M) | 211 | 231 ms | $0.004 |

Money is the total over every game, with the range in which 95% of totals fall when the games are resampled. The real contestants won $167M on the 3,562 of these games where their result is known.

Full results, per model and per question type: https://www.jevillionaire.com/#/results/benchillionaire-en

## What is measured

| Run | What it asks | Command |
|---|---|---|
| Throughput | Every question in the corpus, packed as many per request as each provider allows. Accuracy, questions per second, cost. | `bun bench/run.ts type1 --range corpus` |
| Can walk away | 15-question games from $100 to $1 million. Each turn the model answers, then chooses to lock in or walk away with what it has. | `bun bench/run.ts type2` |
| Never walks | The same games, every answer locked in. | `bun bench/run.ts lockin` |
| With lifelines | The same games with 50:50, Ask the Audience and Phone a Friend, once each. | `bun bench/run.ts type3` |
| Latency | 500 questions, one per request. | `bun bench/run.ts latency --limit 500` |

Games run the same question set for every model, in the order a real contestant would have met
them. Positions a show didn't air are filled from other shows at the same ladder level.

### How questions are asked

- Each question is sent with its four options and the year it was asked ("Asked in 2004."). The
  shared guidance says there is exactly one correct option, that questions may rely on wordplay, and
  to answer as of the year asked. The prompt never names the show.
- In games, each turn has two steps: the model answers, then sees its answer and confidence along
  with the whole ladder and chooses an action (lock in, walk away, or a lifeline it still has). A
  lifeline sends it back to the answer step with the new information. No thresholds are hard-coded:
  walking and lifelines are entirely the model's call.
- Requests go one at a time, models one after another. Requests that fail on the network, a rate
  limit or a server error are retried up to three times (1 s, 4 s, 15 s). Refusals are never retried;
  a refused batch is split and its questions asked alone.

### The corpus and the skip list

`data/millionaire_questions.json.gz`: 240,919 questions from 19,552 wiki pages
covering versions of the show around the world, scraped from the Millionaire Wiki. The benchmark uses
the 12 English-language versions (UK, USA, India, Australia, Ireland, New Zealand, South Africa, Canada, Nigeria, Ghana, Uganda, Kenya): 93,137 multiple-choice questions.

A private held-out set is not published: 788 games, 10% of each version, with every copy
of their questions (6,397 in all). In the corpus they appear as `{"type": "held_out"}`, so
every other question keeps its key. Public games that contained a held-out question are left out of
the results. The held-out set is used for private evaluations.

Some questions can't be asked fairly and are on the skip list (`data/skip-questions.json`, with a
reason for each):

| Reason | Questions | Rule |
|---|---|---|
| `media` | 2,798 | Needs a picture, audio or video clip the corpus doesn't have (wiki flag or wording such as "Whose voice is this?"). |
| `malformed` | 220 | Broken record: missing or duplicate options, an answer outside A–D, or an empty question. |
| `undated` | 31 | Asks about the present ("current", "this year", "now") but the show's air date is unknown. |
| `all_models_wrong` | 2,359 | Every model got it wrong in a Type 1 run: a broken answer key or translation is likely, though some are just very hard. |
| `refused` | 470 | A provider refused it even when asked on its own. |

A skipped question is never asked. In Throughput it counts as neither right nor wrong; in games it is
passed automatically, paying its rung with no decision.

The two model-based rules come from Throughput runs of the four models below. They hide some
questions that are genuinely hard, which is a known bias towards these models; the skip list is
frozen per benchmark version so later models face the same set.

### Versions

`bench/version.json` pins the corpus, skip list, prompt wording (by hash) and seed. A run records
whether it matches; `bench/run.ts` refuses to start when it doesn't, unless you pass `--unfrozen`.
Results are only comparable within a version. This is **benchillionaire-en v1**.

## Running it

Requires [Bun](https://bun.sh) and an [OpenRouter](https://openrouter.ai) key with access to the
Decisions API.

```sh
bun install
bun run setup                      # unpacks the corpus
echo "OPENROUTER_API_TOKEN=…" > .env
bun bench/run.ts type1 --range corpus --dry-run   # checks the version, sends nothing
bun bench/run.ts type1 --range corpus --max-usd 5
```

Each run writes `runs/<id>/`: `manifest.json` (version, prompts, settings), `summary.json`, every
request and response in `calls.jsonl`, and per-question or per-game results. `--max-usd` stops a
run once the reported spend passes it.

To add a model, add it to `bench/deciders.ts` with its provider's per-request limits.

## Licence

Code: [MIT](LICENSE). Data and results: [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/),
from the Millionaire Wiki's contributors; see [data/README.md](data/README.md).
