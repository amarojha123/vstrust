# AI evaluation

The Python service supports deterministic terminology and fact checks plus optional LLM tone, guideline, and accessibility layers. Every finding remains advisory and requires human workflow decisions. Evidence is checked against the approved facts, rules, or approved chunks supplied by the backend. Instruction-like content is treated as data and can emit injection signals.

The labeled examples are in `ai-service (1)/ai-service/eval/dataset.json`; run `python -m eval.run_eval` from the AI service directory. These examples are a development regression set, not a representative quality benchmark. The default `mock` provider and lexical hash embeddings are for offline development only. Live provider quality, latency, cost, and factual accuracy have not been validated; no production accuracy claim is made.
