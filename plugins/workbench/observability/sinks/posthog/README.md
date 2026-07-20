# PostHog sink

The PostHog sink sends the canonical Workbench observation ledger to PostHog's batch capture API. Both Claude and gateway observations use the same observer and durable outbox path.

```json
{
  "observability": {
    "sink": "posthog",
    "sinks": {
      "posthog": {
        "host": "https://us.i.posthog.com",
        "apiKey": "phc_project_key",
        "allowRemote": true,
        "batchSize": 50,
        "maxAttempts": 8,
        "baseDelayMs": 1000,
        "maxDelayMs": 60000
      }
    }
  }
}
```

Use `https://us.i.posthog.com` or `https://eu.i.posthog.com`. Remote egress requires `allowRemote: true` and HTTPS. `apiKey` must be a PostHog project key (`phc_`), never a personal API key. It stays in the private current-user `observability.json`, is placed only in the HTTPS batch body, and is omitted from health and runtime summaries.

Each canonical event becomes `workbench.<canonical event name>`. `session_id` is PostHog's `distinct_id` and `$session_id` when present; observations without a session use `project_id`, then the observation ID. Canonical IDs, schema-approved attributes, and measurements are prefixed as `workbench_*` properties. `$process_person_profile` is disabled. Prompt text, responses, tool inputs/results, raw request bodies, credentials, and environment values never enter the mapping.

The observer sends at most `batchSize` events per request. A successful response acknowledges the whole batch. HTTP or transport failures keep every event durable and retry the batch members with bounded exponential backoff until `maxAttempts`, after which they remain in the ledger with an exhausted outbox record.
