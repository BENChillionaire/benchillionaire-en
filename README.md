# benchillionaire-en

A benchmark for **System One models**: models that take a question and a set of options and
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
| GPT-6 Luna Decisions | 95.3% | $3.15B ($3.07B–$3.23B) | $2.68B ($2.60B–$2.76B) | $2.82B ($2.74B–$2.90B) | 339 | 213 ms | $0.017 |
| Jev 1.14 | 91.8% | $1.74B ($1.67B–$1.80B) | $740M ($698M–$783M) | $1.63B ($1.56B–$1.69B) | 857 | 207 ms | $0.005 |
| Jev 1.13 | 91.7% | $1.09B ($1.04B–$1.15B) | $766M ($720M–$811M) | $1.56B ($1.50B–$1.63B) | 811 | 199 ms | $0.005 |
| Clef-omni | 88.2% | $1.05B ($995M–$1.10B) | $513M ($475M–$550M) | $841M ($789M–$892M) | 126 | 246 ms | $0.023 |
| Clef | 88.2% | $731M ($687M–$773M) | $388M ($357M–$420M) | $858M ($804M–$909M) | 48 | 389 ms | $0.037 |
| Microsoft-Decision-1 | 84.2% | $700M ($653M–$746M) | $327M ($297M–$358M) | $372M ($337M–$407M) | 207 | 256 ms | $0.004 |

Money is the total over every game, with the range in which 95% of totals fall when the games are resampled. The real contestants won $166M on the 3,533 of these games where their result is known.

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

- Each question is sent with its four options and the country and year it was asked ("Asked in the
  UK in 2004."). The shared guidance says there is exactly one correct option, that questions may
  rely on wordplay, and to answer as of the year and for the country asked. The prompt never names
  the show.
- In games, each turn has two steps: the model answers, then sees its answer and confidence along
  with the whole ladder and chooses an action (lock in, walk away, or a lifeline it still has). A
  lifeline sends it back to the answer step with the new information. No thresholds are hard-coded:
  walking and lifelines are entirely the model's call.
- Requests go one at a time, models one after another. Requests that fail on the network, a rate
  limit or a server error are retried up to three times (1 s, 4 s, 15 s). Refusals are never retried;
  a refused batch is split and its questions asked alone. A question still refused counts as wrong
  in Throughput. In games it is passed and paid like a skipped question so the game goes on, and
  each game also records what it would have won had the first refusal been a wrong answer: results
  are reported both ways.

### The corpus and the skip list

`data/millionaire_questions.json.gz`: 240,919 questions from 19,552 wiki pages
covering versions of the show around the world, scraped from the Millionaire Wiki. The benchmark uses
the 12 English-language versions (UK, USA, India, Australia, Ireland, New Zealand, South Africa, Canada, Nigeria, Ghana, Uganda, Kenya): 92,536 multiple-choice questions.

A private held-out set is not published: 788 games, 10% of each version, with every copy
of their questions (6,397 in all). In the corpus they appear as `{"type": "held_out"}`, so
every other question keeps its key. Public games that contained a held-out question are left out of
the results. The held-out set is used for private evaluations.

Where the wiki marks the wrong option, `data/corrections.json` gives the answer as of the air date
(`answer`, with the wiki's in `was`); items that can't be asked as recorded (a guest's tea or
coffee, a comedy sketch, options that belong to another question) have `answer: null` and are
dropped. The corrections are applied when the corpus loads.

Some questions can't be asked fairly and are on the skip list (`data/skip-questions.json`, with a
reason for each):

| Reason | Questions | Rule |
|---|---|---|
| `media` | 3,128 | Needs a picture, audio or video clip the corpus doesn't have (wiki flag, wording such as "Whose voice is this?", or judged by a model to refer to something not shown). |
| `malformed` | 251 | Broken record: missing, duplicate or mismatched options, an answer outside A–D, or an empty question. |
| `undated` | 39 | Its answer depends on when it was asked, but the show's air date is unknown (wording such as "current", or judged by a model). |

A skipped question is never asked. In Throughput it counts as neither right nor wrong; in games it is
passed automatically, paying its rung with no decision.

The model-based rule comes from Throughput runs of the first four models (Jev 1.13, Jev 1.14,
Microsoft-Decision-1 and GPT-6 Luna Decisions). Questions every model gets wrong are kept: a hard
question asked with its year and country is fair. The skip list is frozen per benchmark version so
later models face the same set.

### Versions

`bench/version.json` pins the corpus, skip list, corrections, prompt wording (by hash) and seed. A
run records whether it matches; `bench/run.ts` refuses to start when it doesn't, unless you pass
`--unfrozen`. Results are only comparable within a version. This is **benchillionaire-en v2**.

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
run once the reported spend passes it. An interrupted run (out of credit, killed, over budget) is
finished with `--resume runs/<id>`: the new run reuses every successful response it recorded and
pays only for the rest, with the same results as an uninterrupted run.

To add a model, add it to `DECIDERS` in `shared/decisions.ts` with its provider's per-request limits,
run it alone (`--deciders <id>`) on the same version and seed, and combine its runs with earlier ones
of the same type: `bun bench/merge-runs.ts runs/<earlier run> runs/<new run>`. Every draw comes from
the seed, so both face identical questions, games and luck; the merge refuses runs that don't.

## Licence

Code: [MIT](LICENSE). Data and results: [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/),
from the Millionaire Wiki's contributors; see [data/README.md](data/README.md).
