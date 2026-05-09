# Cerebro changes required by Shifty Studio

> Handoff document. Self-contained. The implementer (neurocirujano de Cerebro)
> does NOT need to know Studio internals to execute these changes — every
> required Cerebro-side file path, function, and integration point is listed
> below, with the Studio-side calling code as reference only.

---

## Context

- **Cerebro** = `shift-cerebro` Python FastAPI service deployed on Railway
  (`https://shift-cerebro-production.up.railway.app`). Shared backbone for
  CL2, Studio, Centinela, and future Shift apps.
- **Studio** = `shiftstudio` Vite SPA + Vercel functions. Uses Cerebro for
  Peaje ingest (write), Punto Medio RAG (read), and `/v1/llm/invoke` (LLM
  proxy with Cerebro's OpenRouter key).
- **Why now**: production audit (2026-05-09) identified four Cerebro-side
  gaps that block real cost savings, billing attribution, and graceful
  failover for Studio. CL2 and Centinela benefit from the same changes.

## Audit findings driving these changes (pasted from audit so the implementer has full context)

> **Cost telemetry is completely flat**: Cerebro returns `usage` and
> `latency_ms` from `/v1/llm/invoke` but does NOT persist `call_id`,
> `trace_label`, or `usage` to disk. Studio cannot answer "how much did
> this user/workspace cost last week" because the data was never written.
>
> **Anthropic prompt caching unavailable**: Cerebro uses
> `langchain_openai.ChatOpenAI` against OpenRouter's OpenAI-compat shim.
> That path silently strips Anthropic-specific parameters like
> `cache_control`, so the (large, mostly stable) Studio system prompt +
> canvas context blocks pay full input-token cost on every turn. Native
> Anthropic SDK with `cache_control` would cut that by ~90% on cached
> input.
>
> **`InvokeLLMBody` has no `app_id`**: Studio sends `tenant: 'shift'` but
> there is no way to attribute cost to "studio" vs. "cl2" vs. "sentinel"
> when those products share a tenant. Peaje ingest already accepts
> `app_id` — `/v1/llm/invoke` should match.
>
> **`/punto-medio/rag/{tenant}` returns 5 separate string fields, no
> `combined_rag`**: Studio defensively concatenates global + tenant + 3
> pattern fields client-side (`puntoMedioClient.ts`). The concat order
> should be Cerebro's authority, not the consumer's.

## Out-of-scope (do NOT touch in this PR)

- Cerebro's existing Peaje ingest endpoint contract (Studio depends on
  current shape).
- Cerebro's swarm chat / debate / agents surfaces — Studio doesn't use
  those.
- Token-counting infrastructure (`peaje/router.py`) is fine as-is.
- LightRAG, MCP servers, embed copilot, etc. — orthogonal.

---

## Change 1 — Anthropic native SDK with `cache_control` for `anthropic/*` models (HIGH ROI)

### Problem

`shift-cerebro/config/models.py:34-43` (the `get_llm` factory) wraps
every LLM with `langchain_openai.ChatOpenAI(...)` pointed at OpenRouter.
That path goes:

```
Cerebro Python → ChatOpenAI(LangChain) → OpenRouter (OpenAI-compat shim)
   → Anthropic Claude (model="anthropic/claude-sonnet-4.6")
```

The OpenAI-compat layer **does not pass through `cache_control` markers**
on message content blocks. Anthropic prompt caching is therefore disabled
for every Cerebro caller, including Studio.

Documented Anthropic discount: **90% off input tokens that hit the cache**
(5-minute TTL, 1024-token minimum block). Studio's typical chat turn
sends ~10K input tokens, of which ~7K is stable across turns (persona +
canvas reading rules + workspace metadata + Punto Medio RAG block). At
$3/M input, that's $0.021 normal vs $0.003 cached — **70% reduction per
chat turn** at typical workload.

### Required change

Add a routing branch in `config/models.py`:

```python
# pseudocode — adapt to actual code style
def get_llm(model_id: str, **kwargs):
    if model_id.startswith("anthropic/"):
        # Strip 'anthropic/' prefix when passing to native SDK
        return _get_anthropic_llm(model_id.removeprefix("anthropic/"), **kwargs)
    # Existing path for non-Anthropic models
    return ChatOpenAI(model=model_id, ...)
```

`_get_anthropic_llm` should:

1. Use `langchain-anthropic`'s `ChatAnthropic` (already a transitive dep,
   confirm with `pip show langchain-anthropic`; install if not)
   OR the native `anthropic` Python SDK if you prefer raw control.
2. Read `ANTHROPIC_API_KEY` from env (Cerebro currently has only
   `OPENROUTER_API_KEY` — add `ANTHROPIC_API_KEY` to Railway env vars).
3. Accept `cache_control` markers on system blocks. Pattern:

```python
from anthropic import Anthropic

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
response = client.messages.create(
    model="claude-sonnet-4.6",
    max_tokens=4096,
    system=[
        {
            "type": "text",
            "text": persona_block,
            "cache_control": {"type": "ephemeral"}
        },
        {
            "type": "text",
            "text": canvas_rules_block,
            "cache_control": {"type": "ephemeral"}
        },
        {
            "type": "text",
            "text": workspace_meta_block,
            "cache_control": {"type": "ephemeral"}
        },
        {
            "type": "text",
            "text": punto_medio_rag_block,
            "cache_control": {"type": "ephemeral"}
        },
        # NO cache_control on the dynamic block (hojas + user query)
        {"type": "text", "text": dynamic_context}
    ],
    messages=[{"role": "user", "content": user_query}]
)
```

### Required change in `/v1/llm/invoke` (`agents/router.py:195+`)

The current `InvokeLLMBody` accepts:
```python
class InvokeLLMBody(BaseModel):
    model: str
    prompt: str       # flat user message
    system: Optional[str]  # flat system string
    tenant: Optional[str]
    max_tokens: Optional[int]
    temperature: Optional[float]
    trace_label: Optional[str]
```

Studio currently flattens its 4-block structured system prompt into a
single `system: str`. To enable caching, change the body to ALSO accept
a structured form:

```python
class CacheableBlock(BaseModel):
    text: str
    cacheable: bool = False  # if True, attach cache_control: ephemeral

class InvokeLLMBody(BaseModel):
    model: str
    # Either-or: caller picks one
    prompt: Optional[str] = None       # legacy flat path
    system: Optional[str] = None       # legacy flat path
    # New structured form (for caching)
    system_blocks: Optional[List[CacheableBlock]] = None
    messages: Optional[List[dict]] = None  # [{"role":"user"|"assistant","content":"..."}]
    # Existing
    tenant: Optional[str] = None
    app_id: Optional[str] = None       # NEW — see Change 2
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    trace_label: Optional[str] = None
```

Logic:
1. If `system_blocks` is provided AND model starts with `anthropic/`,
   pass each block to Anthropic native SDK with `cache_control` set on
   blocks where `cacheable=True`.
2. Else fall back to the legacy flat `system` + `prompt` path (existing
   behavior — preserves backwards compat for CL2 and any other current
   caller).

### Studio-side companion change (NOT part of this PR — track separately)

After Cerebro ships this change, Studio's `src/services/openRouterDirect.ts`
`callOpenRouter` will be updated to send `system_blocks` for the chat
path. The 4 blocks Studio will mark `cacheable: true`:

1. `agentPersona` (~50 tokens, byte-identical for ~50 turns)
2. `canvasReadingRules` (~250 tokens, byte-identical)
3. `[Current workspace] "title" — desc` (~50 tokens, changes ~1×/session)
4. `[Punto Medio — directrices del tenant]\n${combined_rag}` (~500 tokens, changes ~6h)

The dynamic block (selected hoja + 5 hoja blocks + 3 asset blocks +
history + user query) stays uncached.

### Acceptance criteria

- [ ] `ANTHROPIC_API_KEY` added to Cerebro Railway env (and to local
  `.env.example` of `shift-cerebro` repo).
- [ ] `config/models.py` routes `anthropic/*` model ids to a native
  Anthropic SDK call that supports `cache_control`.
- [ ] `agents/router.py` `InvokeLLMBody` accepts the new optional
  `system_blocks` + `messages` fields. Legacy `prompt` + `system` still
  work (backwards compat for CL2).
- [ ] When `system_blocks` is sent, each block with `cacheable: true`
  generates a `cache_control: {type: "ephemeral"}` marker in the
  Anthropic API call.
- [ ] Response contract unchanged (`{output, text, usage, latency_ms,
  call_id, model, agent_id}`). The `usage` field SHOULD now include
  `cache_creation_input_tokens` and `cache_read_input_tokens` from
  Anthropic's response — pass through.
- [ ] Smoke test: send the same `system_blocks` twice within 5min; the
  second `usage.cache_read_input_tokens` should be > 0.

---

## Change 2 — Add `app_id` to `InvokeLLMBody`

### Problem

`InvokeLLMBody` has `tenant: Optional[str]` but no `app_id`. When
multiple products share a tenant (`tenant: 'shift'` is shared by
Studio, internal CL2 dev calls, and future Centinela), there is no way
to attribute cost or rate-limits per app. Peaje ingest
(`peaje/router.py:34-55`) already takes `app_id`; this just brings the
LLM endpoint to parity.

### Required change

Add the field to `agents/router.py`:

```python
class InvokeLLMBody(BaseModel):
    # ...existing fields...
    app_id: Optional[str] = None  # NEW — 'studio' | 'cl2' | 'sentinel' | etc.
```

Pass it into the call log (Change 3 below) and into the response
metadata if useful for debugging.

### Acceptance criteria

- [ ] `InvokeLLMBody.app_id` accepted; default `None` for back-compat.
- [ ] Persisted into `cerebro_llm_calls` (Change 3).
- [ ] Studio's existing call sends `app_id: 'studio'` already (verified
  in `src/services/openRouterDirect.ts` — actually NO it doesn't yet,
  Studio side will need to add this — track as Studio-side follow-up).

---

## Change 3 — Persist `cerebro_llm_calls` table for cost telemetry

### Problem

Today every `/v1/llm/invoke` call generates a fresh `uuid.uuid4()` as
`call_id`, returns it to the caller, and **never writes it down**.
`trace_label`, `usage`, `model`, and latency are all visible in the
response but lost forever after the HTTP response is sent. There is no
way to answer:

- "How much did Studio spend on LLM last week?"
- "Which user is generating the most expensive turns?"
- "What's our cache hit rate per app?"
- "Which `trace_label` is the slowest p95?"

### Required change

#### Schema (Supabase / Postgres)

Cerebro's main DB is Supabase project (confirm which — likely the same
`lqrrtyqhlpupmjzydbck` Studio uses, OR a separate Cerebro project — the
neurocirujano knows). Add a migration:

```sql
-- migrations/<timestamp>_cerebro_llm_calls.sql

create table if not exists cerebro_llm_calls (
  id            uuid primary key default gen_random_uuid(),
  call_id       uuid not null,                -- the uuid returned to caller
  created_at    timestamptz not null default now(),
  app_id        text,                          -- 'studio' | 'cl2' | 'sentinel' | NULL
  tenant        text,                          -- 'shift' | per-tenant
  trace_label   text,                          -- 'studio.workspace.turn.chat' | etc.
  model         text not null,                 -- 'anthropic/claude-sonnet-4.6'
  -- usage breakdown
  input_tokens               integer,
  output_tokens              integer,
  cache_creation_input_tokens integer,         -- Anthropic prompt caching
  cache_read_input_tokens     integer,
  total_tokens               integer,
  -- pricing snapshot (computed at call time so historical reports survive price changes)
  cost_usd_input    numeric(10, 6),
  cost_usd_output   numeric(10, 6),
  cost_usd_total    numeric(10, 6),
  -- timing
  latency_ms        integer,
  -- error tracking
  status            text not null default 'ok', -- 'ok' | 'error' | 'timeout'
  error_code        text,
  error_message     text,
  -- optional caller-supplied identity (when caller wants to attribute to a user)
  user_id           uuid,
  workspace_id      uuid
);

create index if not exists cerebro_llm_calls_app_created
  on cerebro_llm_calls(app_id, created_at desc);

create index if not exists cerebro_llm_calls_trace
  on cerebro_llm_calls(trace_label, created_at desc);

create index if not exists cerebro_llm_calls_user
  on cerebro_llm_calls(user_id, created_at desc) where user_id is not null;
```

#### Insert from `agents/router.py`

Wrap the `/v1/llm/invoke` handler to write a row after the LLM call
completes (or fails):

```python
import time
from supabase import create_client

# at module level
_supa = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_ROLE_KEY"])

# pricing table — refresh when OpenRouter rates change
PRICING_USD_PER_M = {
    "anthropic/claude-sonnet-4.6": {"in": 3.00, "out": 15.00, "cache_read": 0.30},
    "anthropic/claude-opus-4.7":   {"in": 5.00, "out": 25.00, "cache_read": 0.50},
    "google/gemini-3.1-flash-lite-preview": {"in": 0.25, "out": 1.50, "cache_read": 0.25},
    # ... extend as needed
}

def _compute_cost(model: str, usage: dict) -> dict:
    rates = PRICING_USD_PER_M.get(model, {"in": 0, "out": 0, "cache_read": 0})
    cached_in = usage.get("cache_read_input_tokens", 0) or 0
    new_in = (usage.get("input_tokens", 0) or 0) - cached_in
    out = usage.get("output_tokens", 0) or 0
    cost_in = (new_in * rates["in"] + cached_in * rates["cache_read"]) / 1_000_000
    cost_out = out * rates["out"] / 1_000_000
    return {
        "cost_usd_input": cost_in,
        "cost_usd_output": cost_out,
        "cost_usd_total": cost_in + cost_out
    }

# inside invoke_llm handler, AFTER the LLM call returns:
def invoke_llm(body: InvokeLLMBody):
    t0 = time.time()
    call_id = str(uuid.uuid4())
    try:
        result = _do_llm_call(body)  # existing logic
        usage = _usage_from_result(result)
        latency_ms = int((time.time() - t0) * 1000)
        cost = _compute_cost(body.model, usage)

        # Fire-and-forget log (don't block response on DB failure)
        try:
            _supa.table("cerebro_llm_calls").insert({
                "call_id": call_id,
                "app_id": body.app_id,
                "tenant": body.tenant,
                "trace_label": body.trace_label,
                "model": body.model,
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
                "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
                "total_tokens": usage.get("total_tokens"),
                **cost,
                "latency_ms": latency_ms,
                "status": "ok"
            }).execute()
        except Exception as e:
            logger.warning(f"cerebro_llm_calls insert failed: {e}")

        return InvokeResponse(
            output=result["output"],
            text=result["output"],
            usage=usage,
            latency_ms=latency_ms,
            call_id=call_id,
            model=body.model,
            agent_id=None
        )
    except Exception as e:
        # Also log failures so we can compute error rates per app
        try:
            _supa.table("cerebro_llm_calls").insert({
                "call_id": call_id,
                "app_id": body.app_id,
                "tenant": body.tenant,
                "trace_label": body.trace_label,
                "model": body.model,
                "latency_ms": int((time.time() - t0) * 1000),
                "status": "error",
                "error_message": str(e)[:500]
            }).execute()
        except Exception:
            pass
        raise
```

### Acceptance criteria

- [ ] `cerebro_llm_calls` table created in Cerebro's Supabase project.
- [ ] Every `/v1/llm/invoke` call (success AND failure) inserts a row.
- [ ] DB write failures DO NOT block the LLM response (fire-and-forget
  pattern, log warning only).
- [ ] Cost computed at call time using `PRICING_USD_PER_M` and persisted.
- [ ] Anthropic cache token fields (`cache_creation_input_tokens`,
  `cache_read_input_tokens`) populated when present in `usage`.
- [ ] Smoke test: after 10 calls, `select count(*), sum(cost_usd_total)
  from cerebro_llm_calls` returns sensible numbers.

### Studio-side downstream

Studio gets a new admin page `/admin/usage` that hits a Cerebro endpoint
`GET /v1/llm/calls/summary?app_id=studio&from=...&to=...` returning
aggregated per-user/per-day cost. (Out of scope for this PR — once
the table exists, Studio adds the UI in a separate PR.)

---

## Change 4 — Add `combined_rag` field to `/punto-medio/rag/{tenant}` response

### Problem

Studio's `puntoMedioClient.ts` calls
`GET /punto-medio/rag/shift?scope=approved&limit=20`. Cerebro's handler
(`punto_medio_pkg/router.py:33`) ignores the query params (correctly — it
already filters by `approval_status='approved'`) and returns:

```json
{
  "tenant_id": "shift",
  "global_rag": "...",
  "tenant_rag": "...",
  "patterns": "...",
  "examples": "...",
  "objections": "...",
  "global_rag_length": 501,
  "tenant_rag_length": 238,
  "combined_rag_length": 741
}
```

But there's **no `combined_rag` field**. Studio defensively concatenates
the 5 string fields client-side. Three problems:

1. The concatenation order (and which fields to include) is the
   consumer's choice, not Cerebro's. Different consumers might compose
   the RAG block differently → inconsistent behavior across products.
2. The `combined_rag_length` field reports a length the response doesn't
   contain — confusing.
3. The audit found this is the consumer-side concat that runs in EVERY
   Studio chat turn — adding the field server-side caches one composition
   step.

### Required change

`punto_medio_pkg/router.py:33` (the GET handler) — compose the field
server-side:

```python
@router.get("/punto-medio/rag/{tenant_id}")
def get_dynamic_rag(tenant_id: str):
    # ... existing logic that produces global_rag, tenant_rag, patterns,
    # examples, objections ...

    # NEW: server-side composition with explicit ordering
    blocks = []
    if global_rag.strip():
        blocks.append(f"## Directrices globales\n{global_rag.strip()}")
    if tenant_rag.strip():
        blocks.append(f"## Directrices del tenant\n{tenant_rag.strip()}")
    if patterns.strip():
        blocks.append(f"## Patrones aprendidos\n{patterns.strip()}")
    if examples.strip():
        blocks.append(f"## Ejemplos\n{examples.strip()}")
    if objections.strip():
        blocks.append(f"## Objeciones comunes\n{objections.strip()}")
    combined_rag = "\n\n".join(blocks)

    return {
        "tenant_id": tenant_id,
        "global_rag": global_rag,       # keep for backwards compat
        "tenant_rag": tenant_rag,
        "patterns": patterns,
        "examples": examples,
        "objections": objections,
        "combined_rag": combined_rag,    # NEW
        "global_rag_length": len(global_rag),
        "tenant_rag_length": len(tenant_rag),
        "combined_rag_length": len(combined_rag)
    }
```

### Acceptance criteria

- [ ] `/punto-medio/rag/{tenant}` response includes `combined_rag` field.
- [ ] All 5 individual fields preserved (backwards compat).
- [ ] `combined_rag_length` accurately reflects `len(combined_rag)`.
- [ ] Composition order: global → tenant → patterns → examples → objections.
- [ ] Empty fields are skipped (no empty `## Patrones aprendidos\n` headers).

### Studio-side downstream

After Cerebro ships, Studio drops the client-side concat fallback in
`puntoMedioClient.ts:121-125` (now uses the field directly). Studio's
defensive null-check stays.

---

## Change 5 (optional but recommended) — Per-app rate limits / quotas

### Problem

OpenRouter API key is shared across all Cerebro callers. CL2 burning
through credits on a demo blocks Studio. There is no per-app rate limit
or quota inside Cerebro — first-come-first-served at OpenRouter's
shared bucket.

### Required change (sketched, full design TBD)

Add middleware in `agents/router.py` for `/v1/llm/invoke`:

```python
# pseudocode
PER_APP_LIMITS = {
    "studio":   {"rpm": 60,  "tokens_per_day": 5_000_000},
    "cl2":      {"rpm": 120, "tokens_per_day": 20_000_000},
    "sentinel": {"rpm": 30,  "tokens_per_day": 1_000_000},
}

# Check rate limit (Redis-backed counter, sliding window)
def check_rate_limit(app_id: str) -> None:
    if app_id not in PER_APP_LIMITS:
        return  # unknown app, no limit (back-compat)
    limit = PER_APP_LIMITS[app_id]
    current = _redis_incr(f"rl:{app_id}:{minute_bucket}")
    if current > limit["rpm"]:
        raise HTTPException(429, "rate_limited")

    # Daily token budget (read after call, decrement against budget)
    used_today = _redis_get(f"tokens:{app_id}:{day_bucket}") or 0
    if used_today >= limit["tokens_per_day"]:
        raise HTTPException(402, "daily_token_budget_exhausted")
```

### Acceptance criteria

- [ ] Per-app RPM limit enforced; returns 429 when exceeded.
- [ ] Daily token budget tracked per app; returns 402 when exhausted.
- [ ] Limits configurable via env (`CEREBRO_RATE_LIMITS_JSON` or
  similar), not hardcoded.
- [ ] Bypass for unknown apps (back-compat).

This is OPTIONAL for the first Cerebro PR. Track as Change 5 if there's
appetite; otherwise defer to a follow-up.

---

## Rollout sequence (recommended)

### Phase 1 — Cerebro PR #1: telemetry + RAG composition (low risk)

- Change 2 (add `app_id` to `InvokeLLMBody`)
- Change 3 (persist `cerebro_llm_calls`)
- Change 4 (add `combined_rag` to Punto Medio response)

These 3 are independent and additive. No existing caller breaks. Ship to
Cerebro Railway, smoke-test, leave for ~1 week to confirm no regressions.

### Phase 2 — Cerebro PR #2: Anthropic native + caching (high ROI, more risk)

- Change 1 (Anthropic native SDK with `cache_control`)

This is the cost-saving bomb but requires:

- Adding `ANTHROPIC_API_KEY` to Railway env.
- Possibly adding `langchain-anthropic` to Cerebro's `requirements.txt`.
- Coordinated rollout with Studio (Studio has to start sending
  `system_blocks` to actually exercise the new path; can ship behind a
  feature flag like `CEREBRO_USE_ANTHROPIC_NATIVE=true`).

Smoke-test the cache hit rate manually after Studio starts sending
structured blocks. Goal: see `cache_read_input_tokens > 0` in the
`cerebro_llm_calls` table within minutes of Studio chat traffic.

### Phase 3 (optional) — Cerebro PR #3: rate limits

- Change 5 (per-app RPM + daily token budgets)

Only ship if a real cost-incident pattern shows up in `cerebro_llm_calls`
data after Phases 1+2 are live.

---

## Testing checklist

After Cerebro ships, verify from a Studio dev environment:

```bash
# 1. /v1/llm/invoke still works for legacy flat callers (CL2)
curl -X POST $CEREBRO_URL/v1/llm/invoke \
  -H "Content-Type: application/json" \
  -d '{"model":"google/gemini-3.1-flash-lite-preview","prompt":"di hola","max_tokens":50}'
# Expected: 200 with {output, ...}

# 2. /v1/llm/invoke accepts new structured form
curl -X POST $CEREBRO_URL/v1/llm/invoke \
  -H "Content-Type: application/json" \
  -d '{
    "model": "anthropic/claude-sonnet-4.6",
    "system_blocks": [
      {"text": "You are a helpful assistant. Be concise.", "cacheable": true}
    ],
    "messages": [{"role": "user", "content": "say hi"}],
    "max_tokens": 50,
    "app_id": "studio",
    "tenant": "shift",
    "trace_label": "test.cache_smoke"
  }'
# Expected: 200, usage.cache_creation_input_tokens > 0

# 3. Repeat the same call within 5 min
curl -X POST $CEREBRO_URL/v1/llm/invoke ... (same body)
# Expected: 200, usage.cache_read_input_tokens > 0 (cache hit)

# 4. /punto-medio/rag/shift returns combined_rag
curl $CEREBRO_URL/punto-medio/rag/shift
# Expected: {..., "combined_rag": "## Directrices globales\n...", ...}

# 5. cerebro_llm_calls has rows
# (run in Supabase SQL editor for Cerebro's project)
select app_id, count(*), sum(cost_usd_total) from cerebro_llm_calls
  where created_at > now() - interval '1 hour'
  group by app_id;
```

---

## File reference (Cerebro repo paths, relative to repo root)

- `config/models.py` — LLM factory (Change 1)
- `agents/router.py` — `/v1/llm/invoke` handler + `InvokeLLMBody` (Changes 1, 2, 3)
- `punto_medio_pkg/router.py` — `/punto-medio/rag/{tenant}` (Change 4)
- (new) `migrations/<timestamp>_cerebro_llm_calls.sql` — schema (Change 3)
- (new) `requirements.txt` — add `anthropic>=0.40` and possibly
  `langchain-anthropic>=0.3` if not already present.
- (env) Railway: add `ANTHROPIC_API_KEY` (Change 1).

## Studio-side reference (read-only context)

These are the Studio call sites that will benefit. The neurocirujano
does NOT need to modify them — they're listed so the impact is visible:

- `src/services/openRouterDirect.ts:174-209` — `callOpenRouter` flattens
  messages into `prompt`+`system` today. After Cerebro ships, Studio
  will switch to `system_blocks` for chat path.
- `src/services/puntoMedioClient.ts:121-125` — defensive concat fallback
  becomes dead code after Change 4.
- `src/routes/workspace.ts:1391-1395` — Studio's `ragBlock` builder will
  use the new `combined_rag` field directly.
- `src/routes/workspace.ts:1276-1280` — model defaults
  (`TURN_CHAT_MODEL=anthropic/claude-sonnet-4.6`,
  `ARCHITECT_MODEL=anthropic/claude-sonnet-4.6`, etc.) — these all hit
  Cerebro's new Anthropic native path automatically.

## Cost projection delta

Source: Studio audit 2026-05-09, projected at 10 users × 30 turns/day.

| Stack | $/turn (avg) | $/month (10u × 30/d) |
|---|---|---|
| Today (no caching) | $0.054 | ~$300 |
| + Change 1 (Anthropic native + cache_control) | $0.024 | ~$170 |
| + Studio-side context trimming (Phase 2.A, already shipped) | $0.013 | ~$120 |
| + Per-app rate limits (Change 5) | bounded | ~$120 + safety cap |

At 10× scale (Studio + CL2 + Centinela embedded, ~9000 calls/mo each):
**savings ~$3,000/month** when Phase 2 ships.

---

## Questions for the neurocirujano (please answer or flag back)

1. Cerebro's Supabase project — same `lqrrtyqhlpupmjzydbck` as Studio
   shares with Brandhub, OR a separate Cerebro-owned project? The
   `cerebro_llm_calls` table goes wherever Cerebro's own DB is.
2. Is `langchain-anthropic` already in Cerebro's `requirements.txt`? If
   not, you can also use the raw `anthropic` SDK directly without going
   through LangChain.
3. Any preference on cache TTL? Default Anthropic ephemeral is 5min
   (matches Studio's typical session pacing). 1-hour TTL is also
   available but doubles input cost on misses. Recommend stick with 5min.
4. Should Phase 1 (telemetry) ship without Phase 2 (caching)? My
   recommendation: yes, ship Phase 1 first to get visibility, then ship
   Phase 2 once you can measure the before/after cache hit rate.

End of handoff document.
