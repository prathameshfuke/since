// One streaming chat client for every model provider. All three speak the OpenAI chat format,
// so a provider is a row in a table, not an SDK. Failover rules:
//   - try providers in order, skipping any that failed recently (cooldown)
//   - fail over on HTTP errors, timeouts, an empty reply or an invented tool name
//   - never fail over after text has started streaming (the user already saw it)

const PROVIDERS = [
  { id: 'groq', env: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b' },
  // Same key, separate 8,000-tokens-a-minute bucket: plans searches, and answers when the 120b bucket is empty.
  { id: 'groq', env: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-20b', small: true },
  { id: 'gemini', env: 'GEMINI_API_KEY', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.5-flash-lite' },
  { id: 'openrouter', env: 'OPENROUTER_API_KEY', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'nvidia/nemotron-3.5-lightning:free' },
];

const FIRST_BYTE_MS = 9000; // a Gemini model hung 168 s once; never wait that long
const STALL_MS = 15000;
const cooldown = new Map(); // "provider:model" -> time it may be tried again
const routeKey = (p) => `${p.id}:${p.model}`;

export const configured = () => PROVIDERS.filter((p) => process.env[p.env]);

/** Routes to try, in order. Planning calls (`small`) start with the small model so they never spend the answer model's tokens. */
function order(small) {
  const ok = configured();
  const live = ok.filter((p) => (cooldown.get(routeKey(p)) ?? 0) <= Date.now());
  const routes = live.length ? live : ok;
  return small ? [...routes.filter((p) => p.small), ...routes.filter((p) => !p.small)] : routes;
}

function cooldownFor(err) {
  if (err.status === 401 || err.status === 403) return 10 * 60_000; // bad key: stop retrying
  if (err.status === 429) return 60_000;
  if (err.status >= 500 || /timeout|empty/.test(err.message)) return 30_000;
  return 5_000;
}

const queryOf = (call) => {
  try { return JSON.parse(call.function.arguments).query || ''; } catch { return ''; }
};

/**
 * Prepares history for one provider. Tool calls made by a DIFFERENT provider are rewritten as
 * plain text: Gemini rejects tool calls that lack its own thought_signature, and other providers
 * reject unknown fields. The model still sees every search and its results.
 */
function clean(messages, provider) {
  const flattened = new Map(); // tool_call id -> query
  const out = [];
  for (const { _by, ...m } of messages) {
    if (m.tool_calls && _by && _by !== provider.id) {
      m.tool_calls.forEach((c) => flattened.set(c.id, queryOf(c)));
      out.push({ role: 'assistant', content: m.content || `Searching: ${m.tool_calls.map(queryOf).filter(Boolean).join('; ')}` });
    } else if (m.role === 'tool' && flattened.has(m.tool_call_id)) {
      out.push({ role: 'user', content: `Search results for "${flattened.get(m.tool_call_id)}":\n${m.content}` });
    } else if (m.tool_calls) {
      out.push({
        ...m,
        tool_calls: m.tool_calls.map(({ extra_content, ...c }) => (provider.id === 'gemini' && extra_content ? { ...c, extra_content } : c)),
      });
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Valid JSON or "{}": some models stream empty or truncated arguments, and the next call 400s on them. */
const safeArgs = (s) => {
  try { return JSON.stringify(JSON.parse(s || '{}')); } catch { return '{}'; }
};

const TOOL_MARKUP = /^\s*<\s*(tool_call|function[=\s>])/i; // weak models print a tool call as text

async function* attempt(p, { messages, tools, effort, signal, maxTokens }) {
  const ctl = new AbortController();
  const stop = () => ctl.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  let timer;
  const arm = (ms, why) => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(new Error(why)), ms); };
  arm(FIRST_BYTE_MS, `${p.id} first-byte timeout`);

  try {
    const model = p.model;
    const body = { model, messages: clean(messages, p), stream: true };
    if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; if (p.id === 'groq') body.parallel_tool_calls = true; }
    if (p.id === 'groq' || p.id === 'gemini') body.reasoning_effort = effort;
    if (p.id === 'groq') body.max_completion_tokens = maxTokens ?? 1800; // free tier allows 8,000 tokens a minute in total

    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env[p.env]}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      throw Object.assign(new Error(`${p.id} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`), { status: res.status });
    }
    yield { type: 'provider', id: p.id, model };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const calls = {};
    let text = '';
    let finish = '';
    let held = ''; // first characters are held back until we know it is prose, not tool markup
    let released = false;
    const release = function* () {
      if (TOOL_MARKUP.test(held)) throw new Error(`${p.id} printed a tool call as text`);
      released = true;
      if (held) yield { type: 'delta', text: held };
      held = '';
    };
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(STALL_MS, `${p.id} stalled (timeout)`);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const chunk = JSON.parse(data);
        if (chunk.error) throw new Error(`${p.id}: ${JSON.stringify(chunk.error).slice(0, 160)}`);
        finish = chunk.choices?.[0]?.finish_reason ?? finish;
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          text += delta.content;
          if (released) yield { type: 'delta', text: delta.content };
          else { held += delta.content; if (held.length >= 14) yield* release(); }
        }
        for (const tc of delta?.tool_calls ?? []) {
          const c = (calls[tc.index ?? 0] ??= { id: tc.id, type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name && !c.function.name) c.function.name = tc.function.name;
          if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
          if (tc.extra_content) c.extra_content = tc.extra_content;
        }
      }
    }

    const list = Object.values(calls)
      .filter((c) => c.function.name)
      .map((c, i) => ({ ...c, id: c.id || `call_${i}`, function: { ...c.function, arguments: safeArgs(c.function.arguments) } }));
    if (list.length) {
      yield { type: 'tool_calls', message: { role: 'assistant', content: text || null, tool_calls: list, _by: p.id } };
    } else if (text.trim()) {
      if (!released) yield* release();
      yield { type: 'done' };
    } else throw new Error(`${p.id} returned an empty message (finish: ${finish || 'none'})`);
  } catch (e) {
    throw ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/** One model turn collected into a string. For short structured replies such as the search plan. */
export async function ask(opts) {
  let out = '';
  for await (const ev of chat(opts)) if (ev.type === 'delta') out += ev.text;
  return out;
}

/**
 * Streams one model turn. Yields {type:'provider'|'delta'|'tool_calls'|'done'}.
 * A 'tool_calls' event carries the assistant message to append to the conversation.
 */
export async function* chat({ messages, tools, effort = 'low', signal, fast = false, maxTokens }) {
  const failures = [];
  for (const p of order(fast)) {
    let started = false;
    // An empty reply is usually reasoning tokens eating the output budget; one retry is cheaper
    // than failing over to a slower model.
    for (let tries = 0; tries < 2; tries++) {
      try {
        for await (const ev of attempt(p, { messages, tools, effort, signal, maxTokens })) {
          if (ev.type === 'delta') started = true;
          yield ev;
        }
        return;
      } catch (e) {
        if (signal?.aborted) throw e;
        if (started) throw e; // text already shown; switching models mid-sentence would garble it
        console.warn(`[llm] ${e.message.slice(0, 300)}`);
        if (/empty message/.test(e.message) && tries === 0) continue;
        cooldown.set(routeKey(p), Date.now() + cooldownFor(e));
        failures.push(e.message);
        break;
      }
    }
  }
  throw new Error(failures.length ? `No model answered. ${failures.join(' | ')}` : 'No model API key is configured. Add GROQ_API_KEY to .env.');
}
