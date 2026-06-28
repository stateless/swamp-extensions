# DGX Spark Evals (DanTup/spark-evals) — snapshot

Vendored snapshot of an independent **single-DGX-Spark** eval leaderboard. Used as
the provenance source for agentic/coding/tool-use quality points on models that
fit one GB10 (qwen36, gemma4, qwen3-coder-next, nemotron3, deepseek-v4-flash, …).

- **Source:** https://github.com/DanTup/spark-evals (README leaderboard)
- **Fetched:** 28 June 2026
- **Scope:** models that fit on a SINGLE DGX Spark (GB10, 128GB unified).
- **Harness:** `inspect_evals` (UK AISI Inspect) in a clean Ubuntu VM (run OFF the
  Spark; the Spark only serves the model over an OpenAI-compat endpoint).
- **Benchmarks (all agentic / coding / tool-use — NOT knowledge benches):**
  `bfcl` (Berkeley Function-Calling), `bigcodebench`, `IfEvalCode` (instruction-
  following for code; the `ts:` pair = TypeScript-restricted sub-scores),
  `TheAgentCompany` (multi-step agentic tasks).
- **Methodology:** `--limit 1-50 --epochs 7 --epochs-reducer median`,
  `--max-connections 6`, `--time-limit 1800`. **`Overall` = sample-weighted pass
  rate across all benchmarks** (every scored sample counts equally), so it is NOT
  a simple column average. `***bold***` in source = best-in-column.
- Run-cost column = wall time, input-k, output-k tokens (indicates harness load +
  whether a model failed out early on small token counts).

| Model | Quant/flags | bfcl | bigcodebench | IfEvalCode (ts a/b) | TheAgentCo | **Overall** | Run cost |
|---|---|---:|---:|---:|---:|---:|---|
| Qwen3.6 35B-A3B FP8 | kv-cache-dtype=fp8 | 76.0 | 60.0 | 20.0 (38/50) | 20.0 | **47.7** | 13h55m, 125.9M/6.1M |
| Qwen3.6 35B-A3B FP8 | — | 78.0 | 64.0 | 18.0 (38/44) | 10.0 | **46.9** | 13h41m, 117.2M/6.1M |
| Gemma4 31B | — | 78.0 | 72.0 | 18.0 (36/38) | 0.0 | **46.5** | 14h57m, 37.2M/0.69M |
| Gemma4 31B | +MTP (spec=gemma-4-31B-it-assistant,4) | 78.0 | 70.0 | 18.0 (36/40) | 0.0 | **46.5** | 8h15m, 35.8M/0.72M |
| Qwen3.6 35B-A3B NVFP4 | — | 80.0 | 64.0 | 12.0 (36/44) | 10.0 | **45.8** | 12h42m, 118.8M/6.2M |
| Gemma4 26B-A4B | — | 80.0 | 62.0 | 18.0 (30/44) | 0.0 | **45.0** | 9h10m, 469.4M/1.0M |
| Gemma4 31B | QAT w4a16-ct +MTP | 78.0 | 70.0 | 16.0 (32/32) | 0.0 | **43.8** | 5h19m, 113.7M/0.86M |
| Qwen3.6 27B | enable_thinking=False | 78.0 | 64.0 | 16.0 (32/36) | 10.0 | **43.8** | 9h23m, 44.5M/1.0M |
| Qwen3.6 27B FP8 | — | 78.0 | 66.0 | 14.0 (36/26) | 10.0 | **42.7** | 26h51m, 44.4M/3.6M |
| Qwen3.6 27B | dflash(15) | 78.0 | 68.0 | 16.0 (32/26) | 0.0 | **42.3** | 30h52m, 23.5M/2.9M |
| Qwen3.6 35B-A3B | — | 76.0 | 62.0 | 10.0 (28/38) | 20.0 | **41.9** | 24h20m, 98.7M/4.8M |
| Qwen3 Coder Next FP8 | — | 78.0 | 62.0 | 12.0 (24/34) | 20.0 | **41.2** | 5h33m, 136.6M/1.3M |
| Intern S2 Preview | — | 72.0 | 64.0 | 8.0 (20/28) | 10.0 | **37.3** | 17h5m, 105.4M/3.9M |
| Qwen3.6 27B | — | 78.0 | 62.0 | 12.0 (22/14) | 10.0 | **36.5** | 39h51m, 43.8M/2.4M |
| North Mini Code | — | 68.0 | 54.0 | 8.0 (26/14) | 0.0 | **32.7** | 36h41m, 64.3M/2.5M |
| Nemotron3 Nano Omni 30B-A3B BF16 | — | 76.0 | 54.0 | 4.0 (10/18) | 0.0 | **31.2** | 21h37m, 20.2M/2.6M |
| Laguna XS.2 | — | 16.0 | 54.0 | 14.0 (22/24) | 10.0 | **25.4** | 11h8m, 75.6M/2.5M |
| Nemotron3 Super 120B-A12B NVFP4 | — | 12.0 | 60.0 | 8.0 (32/18) | 10.0 | **25.4** | 20h25m, 24.6M/2.0M |
| Gemma4 Diffusion | — | 78.0 | 0.0 | 2.0 (2/4) | 10.0 | **16.9** | 4h30m, 258.5M/1.1M |
| Deepseek v4 Flash | antirez/ds4 (Q2, 1-Spark) | 70.0 | — | 0.0 (0/0) | 0.0 | **16.7** | 37h50m, 5.3M/0.23M |
| Jackrong Qwopus 3.6 27B | v1-preview | — | — | — | — | **0.0** | (no data) |

## Key findings

- **Small dense / small-active MoE dominate single-Spark agentic-coding.** The top
  cluster (Qwen3.6 35B-A3B, Gemma4 31B/26B, Qwen3.6 27B) all sit ~42–48 Overall.
  The big NVFP4 model (Nemotron3 Super 120B-A12B) lands at **25.4** — fitting a
  large model on one Spark via FP4 does NOT buy agentic quality here.
- **DeepSeek-V4-Flash on ONE Spark (ds4 Q2) collapses to 16.7** — bfcl 70 but
  **IfEvalCode 0 and TheAgentCompany 0**, on a tiny token budget (5.3M in / 0.23M
  out over 37h). Direct corroboration of the catalog caveat that aggressive Q2 on a
  single box guts multistep/agentic ability; the quality-preserving path is the FP8
  2×Spark cluster (toolEvalBench 89/100). The single-box "fit" is real, the quality
  is not.
- **FP8 ≈ NVFP4 ≈ BF16 at this resolution.** Qwen3.6 35B-A3B FP8 (46.9) vs NVFP4
  (45.8) vs un-tagged (41.9) — quant differences are within the band noise of a
  50-sample×7-epoch harness; setup (fp8 KV +0.8, thinking, spec-decode) moves
  Overall as much as the quant does.
- **Spec-decode is throughput-neutral on quality (as expected).** Gemma4 31B with
  vs without MTP = identical 46.5; the win is wall-time (14h57m → 8h15m), not score.
- **TheAgentCompany is the discriminator** — most models score 0–20% on it; it's
  where the genuinely-agentic models separate from the merely-good coders.

## Caveats

- **Coding/agentic only** — says nothing about knowledge (MMLU/GPQA), math, or chat.
  Read alongside the AA index and the per-model knowledge benches.
- **50 samples × 7 epochs, median** — low statistical resolution; ±a few points is
  noise. Single evaluator, single hardware; treat Overall as a coarse ranking.
- Quant/flags shown are summarized from each result's folder; consult the source
  repo's per-model `README.md` for the exact serving command.
- Private endpoint URLs in the source repo's run instructions are intentionally
  omitted here (publish hygiene).
