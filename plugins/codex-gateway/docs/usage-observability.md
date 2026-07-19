# Gateway usage observability

## Decision

The gateway is the primary token-usage producer. It emits one counts-only `gateway.token.usage` OTLP log after each successful proxied `/v1/messages` response. Throttled or failed responses with useful limit headers emit a counts-only `gateway.limit.signal` record instead. The existing loopback Collector and Workbench observer ingest those records. Claude Code telemetry remains useful for productivity and UX events, but the resolved usage views prefer gateway evidence.

The emitter stays inside codex-gateway as one small module. Workbench owns the canonical schema, resolved views, reports, and dashboard queries.

## Options considered

### Claude Code telemetry plus route-log joins

This already has broad client lifecycle coverage, but it reports the virtual `claude-codex-auto` model for Sidequest executors, does not expose request-body composition, and leaves token counts unavailable on some `llm_request` rows. Temporal joins against `request-routes.jsonl` also cannot provide exact per-request attribution.

### Direct Workbench observation POSTs

Posting canonical observations to `/v1/observations` would make database ingestion simple. It would couple codex-gateway to Workbench's private schema and bypass the OTLP path already used for gateway routing evidence.

### Counts-only OTLP log from the gateway

This uses the existing local transport, keeps codex-gateway independent of the observer database, preserves one authoritative response record, and can carry request, session, and agent IDs as first-class columns. This is the selected option.

## Emit path

1. After the request body is parsed for routing, build a counts-only input composition snapshot. Raw values are not retained by the emitter.
2. Capture the resolved route in process: backend, resolved model, advertised model, effort, and dispatch mode.
3. Read `x-claude-code-session-id`, `x-claude-code-agent-id`, and `x-claude-code-parent-agent-id` from the incoming request. Invalid or oversized identifiers are omitted.
4. Observe the response without delaying it:
   - JSON responses are parsed from the buffer the shim already needs, or from a bounded side buffer while passthrough bytes continue to the client.
   - SSE responses merge `message_start.message.usage` and the final `message_delta.usage`. The final defined value for each field wins.
   - Side buffers have a fixed byte ceiling. Crossing it disables body parsing for that response and releases retained chunks; response size can never grow telemetry memory without bound.
5. After the client response has ended, schedule a fire-and-forget OTLP/HTTP JSON POST to the loopback logs endpoint. Successful responses need a valid usage block. Non-2xx responses emit `gateway.limit.signal` only when recognized rate-limit, retry, or throttle headers were parsed. Socket errors, timeouts, malformed usage, overflow, and encoder errors are swallowed.

The endpoint order is `CODEX_GATEWAY_USAGE_ENDPOINT`, `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_EXPORTER_OTLP_ENDPOINT + /v1/logs`, then `http://127.0.0.1:4318/v1/logs`. Only loopback HTTP(S) endpoints are accepted. `CODEX_GATEWAY_USAGE_ENDPOINT=0` disables usage export.

## Record contract

`gateway.token.usage` carries these identifiers and labels:

- `request_id`, from the upstream `request-id` or `x-request-id` response header when present
- `client_request_id`, from a safe incoming request ID when present
- `session_id`, `agent_id`, `parent_agent_id`
- resolved `model`, advertised `requested_model`, `backend`, `effort`, and dispatch `via`
- `request.sequence`, a process-local monotonic request number for stable ordering when a provider request ID is absent

Exact provider measurements:

- uncached `input_tokens`
- `output_tokens`
- `cache_read_tokens`
- `cache_creation_tokens`
- cache creation at 5-minute and 1-hour TTL when the response supplies that breakdown
- thinking tokens when the response supplies a numeric thinking detail
- server-tool request counts when present

Exact gateway measurements:

- UTF-8 request-body bytes
- UTF-8 serialized bytes for `system`, all `tools`, native-tool schemas, MCP-tool schemas, all `messages`, first message, remaining history, and `tool_result` blocks
- gateway-observed duration

Estimated measurements:

- input tokens attributed to native tools, MCP tools, system, first message, and remaining history
- cache-read and fresh portions for each top-level source

No response content, prompt text, tool schema, tool arguments, tool results, arbitrary header values, credentials, trace baggage, or error text is emitted.

## Tokenization and accuracy

Calling a provider token-count endpoint would resend content, add latency, and create another billed or rate-limited dependency. Bundling a provider tokenizer would make the gateway much larger and still fail across resolved Codex and Anthropic tokenizers.

The gateway therefore uses UTF-8 serialized byte counts as exact composition evidence. Initial section weights use `ceil(bytes / 4)`. Once exact provider input usage arrives, the weights are normalized with largest-remainder allocation so section estimates sum to:

`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`

The render order is `tools`, `system`, then `messages`. Cache-read allocation consumes the normalized section estimates in that prefix order. The remainder is labeled fresh, which includes uncached input and cache writes. Every section-token and section-cache measurement is marked `estimate`; byte measurements stay `exact_client` and response usage stays `exact_provider`.

This gives a stable answer to the footprint question while staying honest about two limits:

- tokenizer overhead and bytes-per-token vary by model and content
- the provider exposes aggregate cache buckets, not a per-section cache map, so the section split is approximate

`tool_result` bytes are a nested diagnostic inside message bytes and are not added to the stacked top-level total.

## Cache semantics and economics

Anthropic usage fields are separate buckets. `input_tokens` is the uncached remainder, not the full prompt. Full input is the sum of uncached, cache creation, and cache read tokens.

Cache economics use the exact response buckets:

- 5-minute writes cost 1.25 times base input
- 1-hour writes cost 2 times base input
- reads cost 0.1 times base input

The observer reports base-price-equivalent savings and surcharge for every model. It reports USD only where a maintained input price is known. Subscription-backed Codex routes keep token-equivalent economics and leave USD unavailable rather than inventing a per-token subscription price.

## Limit and context signals

The same record parses numeric Anthropic `anthropic-ratelimit-*` response headers into limit, remaining, and reset measurements. It also accepts numeric `x-codex-*-used-percent` headers defensively and records the highest observed used percent. Missing or malformed headers are ignored.

The request timeline uses exact total input tokens to show context growth by session. Output has no source attribution and remains a request-level total.

## Observer and dashboard

Workbench treats `gateway.token.usage` as evidence rank 1 for resolved request usage. Existing Claude Code and Agent SDK usage remain fallback evidence.

The observer exposes:

- request rows keyed by provider request ID, session, agent, parent agent, resolved model, and effort
- session rollups
- orchestrator versus executor rollups, where a missing agent ID is the orchestrator and a present agent ID is an executor
- per-request input composition and context-growth rows
- exact cache buckets plus estimated per-section cache-read/fresh splits

The token report and Grafana dashboard use these gateway-backed rows. The footprint panel stacks native tools, MCP tools, system, first message, and history estimates; byte totals remain available beside token estimates.

## Operational checks and caveats

`doctor` and `/healthz` report whether `ANTHROPIC_BASE_URL` is present in user or project settings. A shell-only export is warned because background and headless sessions may not inherit it.

Two Claude Code checks bypass the configured base URL and remain unmetered: fast-mode availability and WebFetch domain safety. They do not carry consequential billable inference. Agent View naming and summary calls, internal utility calls, server-side tool usage, and WebFetch summarization use the normal provider path and are captured when the gateway is configured at settings level.

## Verification

- Unit tests cover byte-only composition, normalized token allocation, cache split, usage merging, limit-header parsing, counts-only payloads, bounded-buffer overflow, and fail-open transport.
- Gateway integration tests drive JSON and SSE responses through an isolated shim and fake upstream.
- An isolated Workbench observer receives the gateway record. Its request, session, agent, and composition views must match the raw response usage exactly for exact fields.
- A collector that deliberately delays its OTLP response must not delay the proxied response.
- Full gateway tests run with `node --test plugins/codex-gateway/test/*.test.js`; Workbench observability tests run with explicit Windows-safe globs.
