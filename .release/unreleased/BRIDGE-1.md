---
ref: BRIDGE-1
title: Bridge Codex requests to a real Claude Code orchestrator
bump: minor
plugins: [quartermaster]
---

Add project-pinned CLI and MCP handoffs with resumable bridge-owned conversations, idempotent requests, durable job states and owned cancellation. Keep native Sidequest execution in Claude and preserve host permission/provider policy. This owner-directed change is tracked by the local release reference BRIDGE-1; it is not a Sidequest ticket or external issue claim.

Include a versioned provider-neutral receipt for ownership and lifecycle evidence. Claude Code is the first supported adapter; unsupported adapters refuse without fallback, and host success remains separate from verified task delivery.

Handle native indexed continuation results with bounded diagnostics, strict session/order checks and retained earlier errors and permission denials.
