# PostHog sink stub

`posthog` is reserved in the sink registry but cannot be enabled yet. Workbench's canonical OTLP observations need an explicit mapping to PostHog event names, properties, identity, batching, and failure semantics. That mapping also needs a credential and regional-host contract before remote egress is safe. SQ-515 tracks the implementation.

Use `grafana-lgtm`, `otlp`, or `none` until that provider is implemented.
