# Since

A chat agent with one tool, web search, built for questions that change over time: *"Has any of these changed pricing since Monday?"*, *"What did I ask you on 3 November, and is it still right?"*

It remembers what you asked, finds the earlier conversation by date or by meaning, re-checks each claim against the live web, and shows the result as a ledger: earlier value, current value, status. A row only says "Still current" or "Changed" if the cited source text actually contains the figure.

## Run it

```sh
npm install        # no dependencies, finishes instantly
cp .env.example .env   # then add your keys
npm run dev        # http://localhost:3000
```

Needs Node 22 or newer. `npm test` runs the unit tests (no network, no keys).

### Keys (all free tiers, listed in `.env.example`)

| Key | Needed for |
|---|---|
| `GROQ_API_KEY` | Main model (`gpt-oss-120b`, with `gpt-oss-20b` as a second route) |
| `LANGSEARCH_API_KEY` | Search with exact date ranges |
| `GEMINI_API_KEY` | Semantic recall (embeddings) and the second model |
| `TAVILY_API_KEY` | Optional. Search for current pages, fallback for LangSearch |
| `OPENROUTER_API_KEY` | Optional. Third model fallback |

`.env` is git-ignored. Only `.env.example` (names, no values) is committed.

## Try the three example questions

Open the app, click **Load sample history**, then ask:

1. *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
2. *What did I ask you on 3 November? Is your answer still correct today?*
3. *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*

The sample history is dated relative to today, so these phrases always resolve.

## API

```sh
curl -s localhost:3000/api/chat -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"message":"Compare Neon and Supabase pricing","tz":"Europe/London"}'
```

Returns `{ answer, sources, meta }`. Send `accept: text/event-stream` for streaming events (`status`, `sources`, `delta`, `ledger`, `vectors`, `done`, `error`).

To give the agent memory over the API, pass history in the body: `memory: [{ id, ts, q, a }]` and `recent: [{ id, q, a }]`. The server stores nothing.

`GET /api/health` lists which providers are configured (names only).

## Layout

```
server/  dates.js    "last Tuesday" → dates, in code
         memory.js   recall past turns: exact date first, then meaning
         search.js   the one tool: Tavily + LangSearch, reranked, filtered
         llm.js      one streaming client, failover across models
         agent.js    plan → parallel search → answer → verify
         index.js    HTTP + server-sent events
public/  the app (plain ES modules, no build step)
tests/   dates, recall, ledger verification, citation safety
```

See [DESIGN.md](DESIGN.md) for why it is built this way.
