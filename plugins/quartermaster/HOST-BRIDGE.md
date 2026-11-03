# Codex to Claude Code bridge

Use this when the current host can call a local command or MCP server, but the work needs Claude Code's tools and installed Toolshed plugins. Quartermaster starts a separate, bridge-owned Claude orchestrator and returns its progress and result. It does not attach to an existing terminal conversation.

Sidequest's board MCP is not an agent launcher. Its dispatch response must be executed by Claude's native Agent tool. The bridge keeps that responsibility inside the real Claude host instead of pretending that Codex has the same runtime.

## Requirements

- Node.js and an installed `claude` executable.
- A working Claude provider/login and the plugins the task needs. The bridge preserves that configuration; it does not read credentials or substitute a provider or model.
- An explicitly selected, trusted project directory. Normal Claude startup loads its instructions, plugins, hooks and MCP configuration.

The default `plan` profile uses Claude's plan permission mode and Read/Glob/Grep built-ins. It does not promise that startup hooks or installed MCP servers are side-effect-free. Project routing is not a filesystem sandbox.

The optional `work` profile retains the host's current permission policy. Both profiles deny actions that would require an unanswered permission prompt. The bridge never enables permission bypass or automatically broadens an allowlist. A blocked tool must remain a reported blocker.

Claude's plan mode may refuse Sidequest board MCP calls even when the server is connected and the operation is a read. For an authorized task that needs those tools, select `work` explicitly and retain the host's existing permissions. That profile can still report a denial; the bridge does not retry with broader permissions.

## Use immediately from a command-capable host

Put the message in a UTF-8 file, then run:

```text
node <quartermaster>/bin/quartermaster-bridge.js start --project <absolute-project-path> --request <new-request-uuid> --message-file <message.txt>
```

For a new job, the command prints the accepted handle, remains responsible for its child, and prints a terminal result when the Claude turn ends. A replay of an active job owned by another process returns the existing handle with `accepted:true` and `terminal:false`, then exits successfully; that original owner continues the work. A completed replay returns the recorded result. Keep the returned conversation and job IDs.

Send the next message to that exact conversation:

```text
node <quartermaster>/bin/quartermaster-bridge.js followup --project <same-project-path> --conversation <conversation-uuid> --request <new-request-uuid> --message-file <next-message.txt>
node <quartermaster>/bin/quartermaster-bridge.js status --project <same-project-path> --conversation <conversation-uuid>
node <quartermaster>/bin/quartermaster-bridge.js result --project <same-project-path> --conversation <conversation-uuid>
```

Reuse a request ID only when retrying the same message after an uncertain call. A replay returns the original handle; changing its payload is refused. A follow-up uses `--resume` with the bridge's recorded session. Arbitrary Claude session IDs and `--continue` are not accepted.

## Connect Codex through MCP

Use the absolute path to the installed Quartermaster directory:

```text
codex mcp add toolshed-bridge -- node <quartermaster>/bin/quartermaster-bridge-mcp.js --project <absolute-project-path>
```

This server is pinned to one project. Calls naming a different project are refused. To scope the configuration to a repository, use its `.codex/config.toml`:

```toml
[mcp_servers.toolshed_bridge]
command = "node"
args = ["<quartermaster>/bin/quartermaster-bridge-mcp.js", "--project", "<absolute-project-path>"]
```

Codex must load the new server before its native MCP tools are available. Configuration on disk does not prove activation. The command-line route above remains usable without waiting for a new MCP roster.

The MCP surface provides `quartermaster_bridge_start`, `quartermaster_bridge_followup`, `quartermaster_bridge_status`, `quartermaster_bridge_result` and `quartermaster_bridge_cancel`. Start and follow-up return immediately. Poll status/result for the exact returned job; do not resubmit a task with a new request ID merely because its first response was delayed.

## What a result proves

Keep these states separate:

1. A request was accepted and assigned a handle.
2. A real Claude process started.
3. The host returned a successful structured result.
4. The requested artifact or Sidequest completion was independently verified.

Only the last step establishes task delivery. A zero exit code, a plausible answer or a successful transport does not establish that an edit, test or release happened. Check the named files, test results and board evidence before reporting completion.

Only one turn can own a conversation at a time. Cancel active MCP work through the connection that owns its child. CLI cancellation refuses to kill a foreign process based on a PID read from disk. After an owner is lost, unfinished work is reported as interrupted, without automatic retry. A later follow-up remains an explicit new request.

If termination cannot be confirmed, the bridge reports `terminationPending` and retains its live ownership lock instead of claiming the host stopped. If that owner subsequently dies, the conversation is marked unsafe to resume. Inspect the receiver before starting replacement work; no stored PID is killed during recovery.

The bridge bounds runtime, turn count and output. `QUARTERMASTER_BRIDGE_HOME` selects private bridge state; `QUARTERMASTER_BRIDGE_CLAUDE` can select the Claude executable. Do not put private prompts or bridge state in a public repository. Provider credentials remain with the native Claude host.

## Compatibility and release status

This interface runs Claude Code; it does not port every Claude plugin into Codex. Native Sidequest execution, hooks, claims and verification still belong to Claude. Check the installed plugin version and the actual tools loaded in the receiver before relying on them. A source checkout, a published release and a loaded installation are separate states.
