# Artificial Analysis LLM Leaderboard — snapshot

Vendored reference snapshot used as the provenance source for `aaIntelligenceIndex`
benchmark values and leaderboard-seeded model stubs in this catalog.

- **Source:** https://artificialanalysis.ai/leaderboards/models (All weights, All sizes)
- **Fetched:** 25 June 2026
- **Index column:** Artificial Analysis "AI Intelligence Index" (aggregate). `*` = estimated/approximate.
- Speed (output tok/s), Latency (first-chunk s), Total (response s) are provider-measured and volatile.
- Proprietary / API-only rows are retained here for provenance but do NOT get catalog
  model entries (the catalog models self-hostable open weights). Open-weights rows not
  already in the catalog were seeded as `stub` entries citing this file.

| Model | Creator | Context | AA Index | Price $/1M | Speed t/s | Latency s | Total s |
|---|---|---|---|---|---|---|---|
| Claude Fable 5 (with fallback) | Anthropic | 1M | 60 | 7.70 | -- | -- | -- |
| Claude Opus 4.8 (max) | Anthropic | 1M | 56 | 3.85 | 65 | 19.51 | 27.17 |
| GPT-5.5 (xhigh) | OpenAI | 922k | 55 | 4.35 | 68 | 86.71 | 94.10 |
| Claude Opus 4.7 (max) | Anthropic | 1M | 54 | 3.85 | 46 | 14.80 | 25.68 |
| GPT-5.5 (high) | OpenAI | 922k | 53 | 4.35 | 70 | 19.33 | 26.51 |
| GLM-5.2 (max) | Z AI | 1M | 51 | 0.90 | 141 | 1.61 | 19.31 |
| GPT-5.5 (medium) | OpenAI | 922k | 50 | 4.35 | 63 | 7.29 | 15.19 |
| Gemini 3.5 Flash | Google | 1M | 50 | 1.31 | 194 | 24.07 | 26.65 |
| Claude Sonnet 4.6 (max) | Anthropic | 1M | 47 | 2.31 | 53 | 123.77 | 133.15 |
| Gemini 3.1 Pro Preview | Google | 1M | 46 | 1.74 | 138 | 35.50 | 39.13 |
| Qwen3.7 Max | Alibaba | 1M | 46 | 1.43 | 207 | 2.50 | 16.55 |
| Gemini 3.5 Flash (medium) | Google | 1M | 45* | 1.31 | 189 | 16.59 | 19.24 |
| MiniMax-M3 | MiniMax | 1M | 44 | 0.22 | 86 | 2.19 | 31.24 |
| DeepSeek V4 Pro (Max) | DeepSeek | 1M | 44 | 0.18 | 80 | 1.42 | 62.47 |
| GPT-5.3 Codex (xhigh) | OpenAI | 400k | 44* | 1.87 | 88 | 85.73 | 91.43 |
| GPT-5.5 (low) | OpenAI | 922k | 43 | 4.35 | 61 | 1.97 | 10.20 |
| Muse Spark | Meta | 262k | 43 | -- | -- | -- | -- |
| Kimi K2.6 | Kimi | 256k | 43 | 0.70 | 28 | 3.04 | 176.79 |
| Claude Opus 4.7 (Non-reasoning, high) | Anthropic | 1M | 43* | 3.85 | 42 | 1.55 | 13.45 |
| MiMo-V2.5-Pro | Xiaomi | 1M | 42 | 0.18 | 45 | 3.10 | 59.23 |
| Kimi K2.7 Code | Kimi | 256k | 42 | 0.70 | 64 | 2.35 | 45.23 |
| Nex-N2-Pro | Nex AGI | 262k | 41 | 0.53 | 109 | 1.92 | 24.82 |
| DeepSeek V4 Pro (High) | DeepSeek | 1M | 41* | 0.18 | 70 | 1.87 | 37.66 |
| DeepSeek V4 Flash (Max) | DeepSeek | 1M | 40 | 0.06 | 130 | 1.47 | 48.37 |
| GLM-5.1 | Z AI | 200k | 40 | 0.90 | 88 | 1.53 | 50.19 |
| MiMo-V2.5 | Xiaomi | 1M | 40* | 0.06 | 83 | 2.75 | 32.80 |
| GPT-5.4 mini (xhigh) | OpenAI | 400k | 40 | 0.65 | 181 | 11.13 | 13.90 |
| Grok Build 0.1 0616 | xAI | 256k | 40 | 0.54 | 95 | 0.51 | 26.79 |
| Qwen3.6 Plus | Alibaba | 1M | 40 | 0.43 | 52 | 2.70 | 117.96 |
| Qwen3.7 Plus | Alibaba | 1M | 39 | 0.25 | 49 | 2.82 | 54.12 |
| GPT-5.4 nano (xhigh) | OpenAI | 400k | 38 | 0.18 | 160 | 3.81 | 6.94 |
| MiniMax-M2.7 | MiniMax | 205k | 38 | 0.22 | 48 | 2.16 | 63.59 |
| GLM-5-Turbo | Z AI | 200k | 38* | -- | -- | -- | -- |
| Nemotron 3 Ultra | NVIDIA | 262k | 38 | 0.58 | 144 | 1.32 | 20.65 |
| Grok 4.3 (high) | xAI | 1M | 38 | 0.64 | 140 | 17.46 | 21.04 |
| DeepSeek V4 Flash (High) | DeepSeek | 1M | 37* | 0.08 | -- | -- | -- |
| Qwen3.6 27B | Alibaba | 262k | 37 | 0.90 | 59 | 3.81 | 108.96 |
| MiMo-V2-Omni-0327 | Xiaomi | 256k | 36* | 0.34 | 85 | 2.95 | 32.24 |
| Grok 4.3 (medium) | xAI | 1M | 36* | 0.64 | 134 | 9.26 | 12.99 |
| Claude Sonnet 4.6 (Non-reasoning) | Anthropic | 1M | 36* | 2.31 | 44 | 1.39 | 12.68 |
| Grok 4.3 (low) | xAI | 1M | 35* | 0.64 | 124 | 5.20 | 9.24 |
| GPT-5.5 (Non-reasoning) | OpenAI | 922k | 35 | 4.35 | 63 | 0.92 | 8.81 |
| GLM-5.1 (Non-reasoning) | Z AI | 200k | 35* | 0.90 | 61 | 1.79 | 10.04 |
| MiMo-V2-Omni | Xiaomi | 256k | 35* | 0.00 | 81 | 2.78 | 33.68 |
| Gemini 3.5 Flash (minimal) | Google | 1M | 35* | 1.31 | 171 | 0.89 | 3.81 |
| Kimi K2.6 (Non-reasoning) | Kimi | 256k | 35* | 0.70 | 27 | 3.14 | 21.38 |
| GLM 5V Turbo | Z AI | 200k | 34* | -- | -- | -- | -- |
| Claude Sonnet 4.6 (Non-reasoning, Low Effort) | Anthropic | 1M | 34* | 2.31 | 45 | 1.38 | 12.60 |
| Qwen3.5 397B A17B | Alibaba | 262k | 34 | 0.90 | 52 | 2.88 | 73.26 |
| Hy3-preview | Tencent | 256k | 34* | 0.10 | 107 | 3.78 | 27.21 |
| GPT-5.5 Instant (May 2026) | OpenAI | 400k | 34* | 4.35 | -- | -- | -- |
| MiMo-V2-Flash (Feb 2026) | Xiaomi | 256k | 33* | 0.06 | 82 | 3.13 | 33.64 |
| Qwen3.5 122B A10B | Alibaba | 262k | 32 | 0.68 | 140 | 2.41 | 20.25 |
| Qwen3.5 397B A17B (Non-reasoning) | Alibaba | 262k | 32* | 0.90 | 52 | 2.52 | 12.19 |
| Qwen3.6 35B A3B | Alibaba | 262k | 32 | 0.37 | 175 | 2.32 | 36.00 |
| DeepSeek V4 Pro (Non-reasoning) | DeepSeek | 1M | 31* | 0.18 | 68 | 2.01 | 9.36 |
| Qwen3.5 Omni Plus | Alibaba | 256k | 31* | 0.84 | 53 | 2.38 | 11.85 |
| Ring-2.6-1T | InclusionAI | 262k | 31 | 0.52 | 129 | 3.37 | 22.72 |
| o3 | OpenAI | 200k | 30* | 1.55 | 137 | 5.47 | 9.13 |
| GPT-5.4 nano (medium) | OpenAI | 400k | 30* | 0.18 | 154 | 3.39 | 6.62 |
| Mistral Medium 3.5 | Mistral | 256k | 30 | 1.16 | 138 | 1.65 | 19.82 |
| GPT-5.4 mini (medium) | OpenAI | 400k | 30* | 0.65 | 171 | 7.82 | 10.75 |
| Step 3.7 Flash | StepFun | 256k | 30 | 0.18 | 401 | 0.95 | 7.19 |
| Claude 4.5 Haiku (Reasoning) | Anthropic | 200k | 30 | 0.77 | 97 | 18.95 | 24.13 |
| Gemma 4 31B | Google | 256k | 29 | 0.00 | 35 | 1.12 | 64.17 |
| Command A+ | Cohere | 192k | 29* | 0.00 | 203 | 0.37 | 12.69 |
| Qwen3.6 27B (Non-reasoning) | Alibaba | 262k | 29* | 0.90 | 62 | 3.78 | 11.79 |
| DeepSeek V4 Flash (Non-reasoning) | DeepSeek | 1M | 29* | 0.06 | 113 | 1.71 | 6.12 |
| JT-35B-Flash | China Mobile | 256k | 28* | -- | -- | -- | -- |
| Qwen3.5 122B A10B (Non-reasoning) | Alibaba | 262k | 28* | 0.68 | 151 | 2.59 | 5.89 |
| MiMo-V2.5-Pro (Non-reasoning) | Xiaomi | 1M | 28* | 0.58 | 49 | 2.68 | 12.89 |
| Gemini 2.5 Pro | Google | 1M | 27* | 1.34 | 132 | 20.20 | 23.97 |
| Hy3-preview (Non-reasoning) | Tencent | 256k | 26* | 0.10 | 100 | 3.56 | 8.54 |
| Ling-2.6-1T | InclusionAI | 262k | 26* | 0.52 | -- | -- | -- |
| Step 3.5 Flash 2603 | StepFun | 256k | 26* | 0.06 | 208 | 1.16 | 13.20 |
| Doubao Seed Code | ByteDance Seed | 256k | 26* | -- | -- | -- | -- |
| Gemma 4 26B A4B | Google | 256k | 26 | 0.14 | -- | -- | -- |
| NVIDIA Nemotron 3 Super | NVIDIA | 1M | 25 | 0.28 | 257 | 1.35 | 11.08 |
| Mercury 2 | Inception | 128k | 25* | 0.14 | 914 | 2.95 | 3.50 |
| Gemini 3.1 Flash-Lite | Google | 1M | 25 | 0.22 | 357 | 5.60 | 7.00 |
| Qwen3.5 9B | Alibaba | 262k | 25* | 0.11 | 57 | 1.40 | 45.42 |
| Gemma 4 31B (Non-reasoning) | Google | 256k | 25* | 0.17 | 45 | 2.27 | 13.26 |
| Grok 4.3 (Non-reasoning) | xAI | 1M | 25 | 0.64 | 135 | 0.79 | 4.50 |
| K-EXAONE | LG AI Research | 256k | 25* | -- | -- | -- | -- |
| Trinity Large Thinking | Arcee AI | 512k | 24* | 0.24 | 190 | 1.05 | 14.18 |
| Qwen3.6 35B A3B (Non-reasoning) | Alibaba | 262k | 24* | 0.56 | 192 | 2.29 | 4.89 |
| gpt-oss-120b (high) | OpenAI | 131k | 24 | 0.20 | 328 | 0.94 | 8.57 |
| Claude 4.5 Haiku (Non-reasoning) | Anthropic | 200k | 24* | 0.77 | 94 | 0.84 | 6.17 |
| Qwen3.5 35B A3B (Non-reasoning) | Alibaba | 262k | 23* | 0.42 | 194 | 2.23 | 4.81 |
| MiMo-V2-Flash | Xiaomi | 256k | 23* | 0.12 | 91 | 3.31 | 8.82 |
| EXAONE 4.5 33B | LG AI Research | 262k | 23* | -- | -- | -- | -- |
| HyperNova 60B 2605 | Multiverse Computing | 131k | 22* | 0.05 | 393 | 0.84 | 7.20 |
| Gemma 4 12B | Google | 256k | 22* | 0.12 | 126 | 2.41 | 22.24 |
| ERNIE 5.0 Thinking Preview | Baidu | 128k | 22* | -- | -- | -- | -- |
| Nova 2.0 Pro Preview (medium) | Amazon | 256k | 22 | 1.47 | 122 | 15.86 | 36.36 |
| Nemotron Cascade 2 30B A3B | NVIDIA | 1M | 21* | -- | -- | -- | -- |
| Qwen3 Coder Next | Alibaba | 256k | 21* | 0.43 | 107 | 1.95 | 6.63 |
| Nova 2.0 Omni (medium) | Amazon | 1M | 21* | 0.52 | -- | -- | -- |
| Mistral Small 4 (Reasoning) | Mistral | 256k | 21* | 0.20 | 159 | 0.76 | 16.50 |
| North Mini Code | Cohere | 256k | 21* | 0.00 | 112 | 0.32 | 22.56 |
| Nova 2.0 Lite (high) | Amazon | 1M | 21* | 0.52 | 138 | 18.72 | 36.87 |
| Qwen3.5 9B (Non-reasoning) | Alibaba | 262k | 20* | -- | -- | -- | -- |
| Magistral Medium 1.2 | Mistral | 128k | 20* | 2.30 | 37 | 1.77 | 68.63 |
| Gemma 4 26B A4B (Non-reasoning) | Google | 256k | 20* | 0.16 | 42 | 2.02 | 14.07 |
| Qwen3.5 4B | Alibaba | 262k | 20* | 0.04 | 27 | 0.92 | 92.70 |
| Qwen3 Next 80B A3B (Reasoning) | Alibaba | 262k | 20* | 1.05 | 184 | 2.14 | 15.70 |
| Nova 2.0 Pro Preview (low) | Amazon | 256k | 20* | 2.13 | 122 | 10.95 | 31.49 |
| Ling 2.6 Flash | InclusionAI | 262k | 19* | 0.06 | 197 | 1.50 | 4.03 |
| Nova 2.0 Lite (medium) | Amazon | 1M | 19* | 0.52 | 152 | 22.99 | 39.45 |
| Qwen3.5 Omni Flash | Alibaba | 256k | 19* | 0.17 | 264 | 1.94 | 3.83 |
| JT-MINI | China Mobile | 128k | 19* | -- | -- | -- | -- |
| Nova 2.0 Lite (low) | Amazon | 1M | 18* | 0.52 | 149 | 12.89 | 29.65 |
| gpt-oss-120b (low) | OpenAI | 131k | 18* | 0.20 | 332 | 0.94 | 8.46 |
| GPT-5.4 nano (Non-reasoning) | OpenAI | 400k | 18* | 0.18 | 155 | 0.58 | 3.80 |
| NVIDIA Nemotron 3 Nano (Reasoning) | NVIDIA | 1M | 18* | 0.07 | 78 | 2.89 | 34.80 |
| LongCat Flash Lite | LongCat | 256k | 17* | 0.00 | -- | -- | -- |
| K-EXAONE (Non-reasoning) | LG AI Research | 256k | 17* | -- | -- | -- | -- |
| GPT-5.4 mini (Non-reasoning) | OpenAI | 400k | 17* | 0.65 | 156 | 0.77 | 3.97 |
| Nova 2.0 Omni (low) | Amazon | 1M | 17* | 0.52 | -- | -- | -- |
| Mi:dm K 2.5 Pro | Korea Telecom | 128k | 16* | -- | -- | -- | -- |
| Qwen3.5 4B (Non-reasoning) | Alibaba | 262k | 16* | 0.04 | 33 | 0.86 | 16.10 |
| Mistral Large 3 | Mistral | 256k | 16 | 0.60 | 47 | 1.24 | 11.78 |
| INTELLECT-3 | Prime Intellect | 131k | 16* | -- | -- | -- | -- |
| Devstral 2 | Mistral | 256k | 15* | 0.00 | 28 | 1.70 | 19.79 |
| Solar Open 100B (Reasoning) | Upstage | 128k | 15* | -- | -- | -- | -- |
| Nemotron 3 Nano Omni 30B A3B (Reasoning) | NVIDIA | 256k | 15* | 0.10 | 290 | 1.01 | 9.64 |
| gpt-oss-20B (high) | OpenAI | 131k | 15 | 0.07 | 227 | 0.92 | 11.92 |
| Nova 2.0 Pro Preview | Amazon | 256k | 14 | 2.13 | 109 | 1.10 | 5.69 |
| gpt-oss-20B (low) | OpenAI | 131k | 14* | 0.07 | 233 | 0.89 | 11.62 |
| Llama 4 Maverick | Meta | 1M | 14 | 0.34 | 110 | 1.03 | 5.57 |
| Solar Pro 3 | Upstage | 128k | 14 | -- | -- | -- | -- |
| Qwen3 Next 80B A3B (Instruct) | Alibaba | 262k | 14* | 0.65 | 187 | 2.28 | 4.95 |
| Gemma 4 12B (Non-reasoning) | Google | 262k | 13* | 0.12 | 134 | 2.75 | 6.48 |
| Devstral Small 2 | Mistral | 256k | 13* | 0.00 | 46 | 1.68 | 12.62 |
| Motif-2-12.7B | Motif Technologies | 128k | 13* | -- | -- | -- | -- |
| Nova Premier | Amazon | 1M | 13* | 2.18 | 33 | 2.95 | 17.99 |
| Gemma 4 E4B (Reasoning) | Google | 128k | 12* | -- | -- | -- | -- |
| Llama Nemotron Super 49B v1.5 (Reasoning) | NVIDIA | 128k | 12* | 0.13 | 50 | 1.25 | 50.94 |
| Mistral Small 4 (Non-reasoning) | Mistral | 256k | 12* | 0.20 | 154 | 0.78 | 4.03 |
| MiniCPM5-1B (Reasoning) | OpenBMB | 128k | 12* | -- | -- | -- | -- |
| Magistral Small 1.2 | Mistral | 128k | 12* | 0.60 | 104 | 0.94 | 25.07 |
| Sarvam 105B (high) | Sarvam | 128k | 12* | 0.04 | 99 | 2.07 | 27.44 |
| Nova 2.0 Lite | Amazon | 1M | 12* | 0.52 | 138 | 1.30 | 4.93 |
| MiniCPM5-1B (Non-reasoning) | OpenBMB | 128k | 12* | -- | -- | -- | -- |
| EXAONE 4.0 32B (Reasoning) | LG AI Research | 131k | 11* | -- | -- | -- | -- |
| Nova 2.0 Omni | Amazon | 1M | 11* | 0.52 | -- | -- | -- |
| Qwen3.5 2B | Alibaba | 262k | 10* | 0.03 | 36 | 0.97 | 70.83 |
| Nanbeige4.1-3B | Nanbeige | 256k | 10* | -- | -- | -- | -- |
| Llama 4 Scout | Meta | 10M | 10 | 0.22 | 104 | 0.93 | 5.71 |
| Ministral 3 14B | Mistral | 256k | 10* | 0.20 | 78 | 0.89 | 7.27 |
| Falcon-H1R-7B | TII UAE | 256k | 10* | -- | -- | -- | -- |
| Qwen3 Omni 30B A3B (Reasoning) | Alibaba | 65.5k | 10* | 0.32 | 83 | 2.08 | 32.06 |
| Step3 VL 10B | StepFun | 65.5k | 9* | -- | -- | -- | -- |
| Gemma 4 E2B (Reasoning) | Google | 128k | 9* | -- | -- | -- | -- |
| Llama Nemotron Ultra (Reasoning) | NVIDIA | 128k | 9* | 0.72 | 52 | 2.42 | 50.92 |
| ERNIE 4.5 300B A47B | Baidu | 131k | 9* | 0.36 | -- | -- | -- |
| Solar Pro 2 (Reasoning) | Upstage | 65.5k | 9* | -- | -- | -- | -- |
| NVIDIA Nemotron Nano 12B v2 VL (Reasoning) | NVIDIA | 128k | 9* | 0.24 | 256 | 0.44 | 10.18 |
| Ministral 3 8B | Mistral | 256k | 9* | 0.15 | 87 | 0.79 | 6.51 |
| Gemma 4 E4B (Non-reasoning) | Google | 128k | 9* | -- | -- | -- | -- |
| Granite 4.1 30B | IBM | 131k | 9 | -- | -- | -- | -- |
| NVIDIA Nemotron Nano 9B V2 (Reasoning) | NVIDIA | 131k | 9* | 0.05 | 78 | 4.66 | 36.74 |
| NVIDIA Nemotron 3 Nano 4B | NVIDIA | 262k | 9* | -- | -- | -- | -- |
| Qwen3.5 2B (Non-reasoning) | Alibaba | 262k | 9* | 0.03 | 28 | 1.03 | 18.85 |
| Llama Nemotron Super 49B v1.5 | NVIDIA | 128k | 9* | 0.13 | 51 | 1.25 | 11.15 |
| Llama 3.3 70B | Meta | 128k | 9* | 0.59 | 89 | 1.62 | 7.25 |
| Kimi Linear 48B A3B Instruct | Kimi | 1M | 9* | -- | -- | -- | -- |
| Llama 3.1 405B | Meta | 128k | 9* | 3.13 | 68 | 2.45 | 9.83 |
| LFM2.5-8B-A1B | Liquid AI | 32.8k | 8* | 0.00 | 234 | 7.68 | 18.37 |
| Ring-flash-2.0 | InclusionAI | 128k | 8* | 0.18 | -- | -- | -- |
| Solar Pro 2 | Upstage | 65.5k | 8* | -- | -- | -- | -- |
| Command A | Cohere | 256k | 8* | 3.25 | 69 | 1.60 | 8.82 |
| Llama 3.1 Nemotron 70B | NVIDIA | 128k | 8* | 1.20 | 231 | 5.38 | 7.55 |
| NVIDIA Nemotron 3 Nano | NVIDIA | 1M | 7* | 0.07 | 75 | 0.44 | 7.10 |
| NVIDIA Nemotron Nano 9B V2 | NVIDIA | 131k | 7* | 0.06 | 156 | 2.93 | 6.14 |
| Granite 4.1 8B | IBM | 131k | 7* | 0.06 | 111 | 0.92 | 5.42 |
| Sarvam 30B (high) | Sarvam | 65.5k | 7* | 0.03 | 161 | 1.94 | 17.50 |
| Gemma 4 E2B (Non-reasoning) | Google | 128k | 6* | -- | -- | -- | -- |
| R1 1776 | Perplexity | 128k | 6* | -- | -- | -- | -- |
| Llama 3.2 90B (Vision) | Meta | 128k | 6* | 1.38 | 58 | 1.19 | 9.79 |
| EXAONE 4.0 32B | LG AI Research | 131k | 6* | -- | -- | -- | -- |
| Ministral 3 3B | Mistral | 256k | 6* | 0.10 | 153 | 0.65 | 3.92 |
| Jamba 1.7 Large | AI21 Labs | 256k | 5* | 2.60 | 58 | 1.59 | 10.26 |
| Granite 4.0 H Small | IBM | 128k | 5* | 0.08 | 479 | 10.40 | 11.45 |
| Qwen3 Omni 30B A3B (Instruct) | Alibaba | 65.5k | 5* | 0.32 | 96 | 1.99 | 7.20 |
| Qwen3.5 0.8B (Reasoning) | Alibaba | 262k | 5* | 0.01 | 32 | 0.83 | 79.74 |
| LFM2 24B A2B | Liquid AI | 32.8k | 5* | 0.04 | 128 | 0.59 | 4.49 |
| Phi-4 | Microsoft | 16k | 5* | 0.16 | 35 | 2.13 | 16.53 |
| Nova Micro | Amazon | 130k | 5* | 0.03 | 301 | 0.96 | 2.62 |
| NVIDIA Nemotron Nano 12B v2 VL | NVIDIA | 128k | 5* | 0.24 | 215 | 1.11 | 3.44 |
| Phi-4 Multimodal | Microsoft | 128k | 5* | 0.00 | 16 | 1.40 | 33.02 |
| Qwen3.5 0.8B (Non-reasoning) | Alibaba | 262k | 4* | 0.01 | 28 | 0.94 | 18.74 |
| MiniCPM-V 4.6 1.3B | OpenBMB | 262k | 4 | -- | -- | -- | -- |
| Jamba Reasoning 3B | AI21 Labs | 262k | 4* | -- | -- | -- | -- |
| Reka Flash 3 | Reka AI | 128k | 4* | 0.26 | -- | -- | -- |

*\* = estimated/approximate AA Intelligence Index.*
