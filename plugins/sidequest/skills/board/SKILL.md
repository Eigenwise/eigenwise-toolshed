---
name: board
description: Open the sidequest board (live Kanban of your tickets) in the browser
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Launching the sidequest board:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/sidequest.js" dashboard`

The board should now be open in your browser (it shows every project's tickets, live). Report the URL
printed above so the user can click it if the browser didn't pop up.

If nothing was printed above, open the board by running the sidequest dashboard command yourself with
the Bash tool — the resolved CLI path is provided in your context by the sidequest hook (it looks like
`node "…/bin/sidequest.js"`). Then report the URL.
