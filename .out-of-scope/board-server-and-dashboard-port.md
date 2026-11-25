# No board server and no dashboard port

2026-11-16

**v1 had:** a board MCP server with dozens of tools over SQLite, plus a local dashboard server (`server.ts`, 1,612 lines), a Svelte app and a committed `dist/`.

**Evidence:** Since 2026-08-02 the dashboard saw 14 commits across the app and server, against 1,393 to Sidequest's source. Agents verifying dashboard changes stopped the live server. Its write API had no authentication, which is why a LAN bind was declined (#148). Listing the board overran the MCP size ceiling (#829).

**Decision:** The board is plain files. The view is a pane the host draws, with no server, no port and no build step. Four tools, compact by default.

**Would change if:** users need a view outside Claude Code, and a static render of the files cannot serve it.
