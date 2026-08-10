---
name: retro
description: >-
  Retrospective over recent Claude Code sessions: mines transcripts for friction (permission
  denials, interrupts, corrections, repeated manual work) and turns it into concrete setup
  improvements - plugins to install, rules to add, permissions to allow. Use when the user asks
  "what could we have done better", wants to improve their Claude Code setup or workflow, accepts
  the quartermaster nudge, or complains about repeated friction.
---

# Quartermaster retro

Look back at recent sessions, find what kept going wrong or kept being done by hand, and fix the
setup so it stops. Every fix is proposed to the user one at a time and applied only on explicit
approval. The mining is done by a local script; you interpret its bounded output. Never open raw
transcripts yourself.

## Process

1. **Mine.** Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" mine --project "${CLAUDE_PROJECT_DIR}"
   ```

   Default window is 30 days / 40 sessions. Add `--all-projects` only if the user asks for a
   global retro (much slower). The output is a bounded JSON aggregate: friction counts with
   samples, per-plugin/skill/MCP attribution, top repeated commands, per-session tallies, and
   `decisions` with fingerprints of previously applied and rejected recommendations.

2. **Check past decisions first.** Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" verify --project "${CLAUDE_PROJECT_DIR}"
   ```

   If any earlier decision has a verdict, open with a one-line report per decision ("the allowlist
   rule from last retro: denials went 2.1 to 0.3 per session"). If something made things worse or
   stayed flat, propose rolling it back as your first finding.

3. **Interpret.** Turn the aggregate into at most 7 findings, highest impact first. Map each to a
   destination using [references/routing.md](references/routing.md). The signal-to-destination
   shortlist:

   - Repeated permission denials on the same tool or command pattern → a `permissions.allow` rule
     in settings. `permission-rule` denials mean an existing rule is too strict; `user-rejected`
     means Claude keeps proposing something unwanted, which is a rule or CLAUDE.md fix instead.
   - Repeated corrections on one theme → a rule (live-rules if installed, else CLAUDE.md).
   - Repeated manual work (same commands, same web lookups, hand-rolled scripts) → search the
     catalog for a plugin that does it: `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" catalog
     --query "<terms>"`. Prefer plugins over rules over habits: plugins are versioned, updated,
     and removable. Heavy WebSearch/WebFetch on documentation domains with no context7 usage is
     the classic case.
   - Installed plugins with zero attribution (`installedWithoutAttribution`) → candidate disable.
     Caveat: hook-only plugins may legitimately show no tool attribution; check what the plugin
     does before proposing.
   - A recurring multi-step workflow with no plugin match → suggest creating a skill (via
     skill-creator if installed).

4. **Filter.** Drop any finding whose fingerprint is in `decisions.rejected` - the user already
   said no. Do not re-litigate unless they bring it up. If the remaining signals are thin, say so
   plainly and stop; an empty retro is a valid result.

5. **Propose, one at a time.** For each finding present: the evidence (counts and a quote or two),
   the proposed action with the exact command or diff, and any cost (for plugin installs, note
   context cost via `claude plugin details <name>` when relevant). Wait for an explicit yes/no
   before touching anything or moving on. Never batch-apply.

6. **Apply and record.** On approval, apply exactly what was shown, then record it. Record
   rejections too - that is what stops the same advice from resurfacing:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" decisions add --project "${CLAUDE_PROJECT_DIR}" \
     --title "<short title>" --fingerprint "<kind>:<stable-slug>" --status applied|rejected \
     --kind plugin-install|rule|permission|disable|skill|other \
     --signal denials|interrupts|corrections|toolErrors|any
   ```

   `--signal` is the friction the action targets; the next retro verifies against it.

7. **Close.** Run `node "${CLAUDE_PLUGIN_ROOT}/bin/quartermaster.js" mark-retro --project
   "${CLAUDE_PROJECT_DIR}"`, then summarize: what was applied, what was declined, and that the
   next retro will report whether the applied changes actually reduced the friction they targeted.

## Guidelines

- Human in the loop, always. Installs, uninstalls, file edits, settings changes: each needs its
  own approval, in this conversation, with the exact change visible first.
- Seven findings maximum. A retro that surfaces thirty gets skimmed and ignored; the tools that
  tried continuous suggestion drowned their users. Prioritize by occurrences x sessions.
- Attribution counts are evidence of use, absence is only a hint. Say "no recorded tool activity
  in the window", never "unused".
- Recommend from what exists: the catalog command searches every marketplace already known to this
  machine. For MCP servers with no plugin equivalent, the registry at
  `https://registry.modelcontextprotocol.io/v0/servers?search=<terms>` is queryable with WebFetch.
- Quotes from transcripts are the user's own words back at them; keep them short and only when
  they carry the finding.

## Success criteria

- [ ] Mining ran through the script; no raw transcript was opened in context
- [ ] Past decisions were verified and reported before new findings
- [ ] Every proposal showed the exact change and got an explicit yes/no
- [ ] Every decision, including rejections, was recorded with a fingerprint
- [ ] mark-retro ran at the end
