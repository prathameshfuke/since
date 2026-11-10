# Design

**Since** is a chat agent with exactly one tool, web search. The hard part of the target questions ("has any of these changed *since Monday*?", "is the answer I gave on 3 November *still right*?") is not searching. It is knowing which earlier conversation you mean, asking the web only for what changed after it, and not claiming a confirmation the sources do not contain. The architecture is built around those three things.

## How it works

One message goes through five steps. Only steps 3 and 5 call a model.

1. **Dates, in code.** `dates.js` turns "Monday", "last Tuesday", "3 November" into calendar days in the user's timezone. "Last Tuesday" said on a Wednesday is ambiguous, so both candidates are kept.
2. **Recall, not a tool.** The browser sends its saved history; `memory.js` picks the relevant turns: an exact date filter first, otherwise meaning (Gemini embeddings) plus keywords. The turns reach the model as dated text. Memory is not a second tool, so the model still has one.
3. **Plan.** A small model (`gpt-oss-20b`, 0.6 s) decides whether to search and writes one query per item, with a date floor and a word every relevant page must contain.
4. **Search, in parallel.** For "since" questions each query runs two searches: LangSearch with an exact date range (what was published since) and Tavily (the current official page). A vendor's pricing page is not "published" inside the window, so a date filter alone returns spam and misses the page that states today's price. Results are reranked by meaning, dropped if they do not mention the product, and boosted if the domain is the vendor's.
5. **Answer, then verify.** The main model streams from the results and may search once more. Afterwards `verifyLedger` checks each "same" or "changed" row: the cited source text must contain the figure, or the row is downgraded to "couldn't confirm". Citations only link to URLs that were actually retrieved.

Typical cost on the free tiers: 6 s end to end for a five-product re-check (0.7 plan, 4 search, 0.6 answer), 1.5 s for chit-chat.

## Why it is built this way

- **Stateless server, memory in the browser.** Free hosts wipe their disk; the server keeps nothing, and history travels in the request. Same behaviour on a laptop, Render or Vercel, and API callers can pass history themselves. Cost: memory is per browser and request size grows (about 1 MB at 300 turns).
- **Harness-driven fan-out.** I first let the model drive a tool loop. `gpt-oss` issued one search per round: 15 s for five products. A planner plus parallel searches cut that to 6 s and removed a class of tool-call failures.
- **Verification over trust.** In testing the model marked prices "same" with no source stating them. Deterministic checks catch that where prompting did not.
- **Zero dependencies.** Every provider speaks the OpenAI chat format, so `llm.js` is a table of routes plus one `fetch` client. `npm install` is instant and there is nothing to audit.
- **Failover is a feature.** Groq's free tier is 8,000 tokens a minute per model. Routes: `gpt-oss-120b` → `gpt-oss-20b` (separate bucket) → Gemini → OpenRouter. A failed route cools down for a while. Failover never happens after text has started streaming. Foreign tool calls are flattened to text on a switch (Gemini rejects them otherwise).

## Considered and rejected

- **Memory as a second tool**: breaks "one tool", and costs a model round trip.
- **Vector database / local embedding model**: a few hundred turns need a loop, not a database; the local model meant a native install and a cold-start download. Embeddings only *locate* old turns. Which claim is current comes from dated text, because similarity cannot tell a fact from its replacement.
- **Groq's built-in search, Gemini grounding**: billed or model-side, and no exact date range.
- **LangChain / AI SDK / multi-agent research**: more moving parts than the problem needs.
- **Letting the model say "unchanged"**: see verification above.

## Known limits

- Free-tier quotas decide capacity. Search is paced because LangSearch returns 429 under bursts.
- Verification proves a figure appears in the cited snippet, not that it is the right plan: one run compared a Starter price with a Growth price.
- Snippets are 400 characters to fit Groq's token window; some real prices are not in them and show as "couldn't confirm".
- Free-tier prompts may be used for training by some providers. Do not paste sensitive data.

## With another week

1. Read full pages for the top hit per claim (fetch plus extract) so verification checks the page, not a snippet.
2. Match plans by name before comparing prices, to stop tier mix-ups.
3. An evaluation set from the three example prompts and a scripted "week later" replay, run on every change.
4. Store claims as structured rows (item, value, date, source) so "what changed since" becomes a diff over data, not text.
5. Optional encrypted server-side history for cross-device memory.
