# Whittle host exports

Each directory is a self-contained policy export. Choose one directory and copy its contents to the listed destination yourself. The generator never writes consumer directories automatically.

| Host | Export path | Consumer destination |
| --- | --- | --- |
| AGENTS.md | `agents/AGENTS.md` | `AGENTS.md` |
| Codex | `codex/AGENTS.md` | `AGENTS.md` |
| Grok | `grok/AGENTS.md` | `AGENTS.md` |
| Gemini | `gemini/GEMINI.md` | `GEMINI.md` |
| Cursor | `cursor/.cursor/rules/whittle.mdc` | `.cursor/rules/whittle.mdc` |
| Windsurf | `windsurf/.windsurf/rules/whittle.md` | `.windsurf/rules/whittle.md` |
| Cline | `cline/.clinerules/whittle.md` | `.clinerules/whittle.md` |
| Copilot | `copilot/.github/copilot-instructions.md` | `.github/copilot-instructions.md` |
| Antigravity | `antigravity/AGENTS.md` | `AGENTS.md` |
| CodeWhale | `codewhale/AGENTS.md` | `AGENTS.md` |
| Swival | `swival/AGENTS.md` | `AGENTS.md` |
| VSCode-Codex | `vscode-codex/AGENTS.md` | `AGENTS.md` |
| Junie | `junie/AGENTS.md` | `AGENTS.md` |
| Amp | `amp/AGENTS.md` | `AGENTS.md` |
| Jules | `jules/AGENTS.md` | `AGENTS.md` |
| Kiro | `kiro/.kiro/steering/whittle.md` | `.kiro/steering/whittle.md` |
| Qoder | `qoder/.qoder/rules/whittle.md` | `.qoder/rules/whittle.md` |
| Zed | `zed/AGENTS.md` | `AGENTS.md` |
| generic agents | `generic/AGENTS.md` | `AGENTS.md` |
| OpenClaw | `openclaw/skills/whittle/SKILL.md` | `skills/whittle/SKILL.md` |

## Native adapters

| Host | Adapter | Delivery | Verification |
| --- | --- | --- |
| OpenCode | `adapters/opencode/whittle.mjs` | System transform | Callback shape checked; host not run. |
| Pi | `adapters/pi/whittle.mjs` | Before-agent callback | Callback shape checked; host not run. |
| Hermes | `adapters/hermes/` | Pre-LLM callback | Callback shape checked; host not run. |
| MCP | `mcp/` | Read-only instruction prompt/tool | SDK stdio checked with an isolated dependency install. |

The static paths are host-format equivalents, not evidence that each consumer binary loaded them. Gemini uses `GEMINI.md`; Cursor uses an always-applied rule.
