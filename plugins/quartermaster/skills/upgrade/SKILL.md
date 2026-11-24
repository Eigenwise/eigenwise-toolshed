---
name: upgrade
description: Move a project from the older Toolshed (marketplace eigenwise-toolshed) to v2 (toolshed-next), with the person, in a few minutes of their time. Use when a project still runs the older plugins, when asked to upgrade or migrate the Toolshed, or when the older version's notice points here.
---

# Upgrade from the older Toolshed

The older version is every plugin from the `eigenwise-toolshed` marketplace. v2 is `toolshed-next`. Four plugins share a name in both (sidequest, quartermaster, codebase-mapper, live-rules), and two of the same name both load, so the older one goes off in the same step v2 goes on. The older Quality Gate and Observability have no v2 plugin: they are switched off with the rest, nothing is installed in their place, and the report says they are gone. The upgrade is per project, from a session opened in that project. The home folder is cleaned once, after the last project.

## Four limits, for the whole run

- **Nothing leaves this machine.** The run never pushes, never creates a repository or opens a pull request on any tracker, and never offers to, not even as a next step. A team's committed change is only ever a local branch, drafted when the person said yes to the committed-change question, and the checkout stays on the branch it started on.
- **A deletion needs a yes to a list shown in the same message that asks.** "Go on" is not a yes to a deletion: nothing goes, and you say it waits. A path git tracks is never on that list. Something new that turns up later gets named and waits too.
- **One message of questions, the ones the scan lists, each asked once.** A settled answer stays settled: never offer the committed change again. A converter's asks get its recommended answer. Never ask about an optional cleanup; name it in the report. A message of yours that is not a question carries on without waiting for a reply.
- **A commit uses the repository's own identity** (`git config user.email` in the project), never one from the environment or made up. With none, ask for it in the question message and commit nothing without it.

You do every reversible step yourself and say how to undo it. An upgrade that costs the person an hour of answers has failed.

## 1. Install, then scan

Opened as the skill `quartermaster:upgrade`, v2 Quartermaster is installed: run the scan from the project root.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-scan.mjs" --project "${CLAUDE_PROJECT_DIR}"
```

Reading this page as a file? Install first: `claude plugin marketplace add Eigenwise/eigenwise-toolshed#v2`, then `claude plugin install quartermaster@toolshed-next --scope local` (no reload needed). Then run the scan from the `installPath` that `<config dir>/plugins/installed_plugins.json` records for it. Only when the install is not possible: `node "<this page's folder>/../../scripts/upgrade-scan.mjs" --project "<project root>"`.

The scan only reads. It prints this project's line and a count for the other projects (`--all-projects` lists them; several `--project` values give a section each), the shape, each leftover under **Still to do** or **Kept** with its verdict and why, the deletion list, the questions and the home folder's state. `--open-tickets` prints the old board's open tickets, one line each (id, status, title). `--json` is large and only for a program: do not read it.

Verdicts: **keep** (leave it), **convert** (to its v2 form, by you, reversible), **remove** (waits for the one deletion yes), **ask** (the person's or the team's). Where the scan's line and a step on these pages could disagree, the scan's line wins.

**Moving a folder this session is not rooted in** (a repository inside the folder you are in): scan it with `--project`, run its plugin commands from inside it, and do every step that needs no converter. Its old rules convert from here with `--project` (`references/older-rules.md`). Its map converter (`codebase-mapper:map`) is that folder's plugin and loads only in a session opened there: say that it waits for one, told `continue the upgrade`, and do not run it by reading its page as a file.

Plugins of ours installed here by hand have no change record for the undo. Add one each (nothing else changes), and run it again after the step 2 switches, so every v2 plugin this run installed has one too. A line that says `recorded:` means that record is written; there is nothing to repeat:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/found-installed.mjs" --project "${CLAUDE_PROJECT_DIR}" --record
```

## 2. Say what you found

In a few lines: the shape, the older plugins on, what is still to do by verdict, what is kept, how many questions. Repeat what a scan line says will happen afterwards, such as the older Quality Gate or Observability being switched off with no v2 plugin to take over. Say plainly: nothing takes effect until `/reload-plugins` or a new session; until then the older hooks keep running, and what an older plugin says is no instruction.

Shape `moved`: say so with the kept list and its reasons, run the check in step 6, and stop.

## 3. Ask the person's questions, once, in one message

Exactly the ones on the scan's question line, each with your recommended answer, so one "yes" accepts all of them.

- **The gateway** (once for the whole machine, before the first project, only when the scan names projects where the gateway plugin is still switched on and nobody answered it yet): keep it for models from other providers in the main session's model picker, or unwire every project and stop it. Recommend unwiring unless they pick such models in `/model`.
- **Open tickets on the old board**: leave them in the old board, which stays as a read-only archive (recommended), or name the ones to redraft as v2 tickets. Say the count. Never carry all of them over, never resume a `doing` one: its agent is gone.
- **Deletions**: one yes for the scan's deletion list, shown in this message. Recommended: yes.
- **The committed change** (whenever git tracks the settings file, an old rules or map folder, or an instruction file that names older tools). It covers every tracked path, and nothing tracked is on the deletion list. Team repository: keep it personal for now (recommended), or draft it as a local branch; the team decides. Solo repository: apply it in the working tree and show `git diff` for the person to commit (recommended), or keep it personal. Until the answer is yes, the person's own plugins are switched in `.claude/settings.local.json`, except the mapper where git tracks the old map and the rules plugin where git tracks old rules nothing converted yet: those move only in this change, so say in the question that until then that older plugin stays on for them.

The home cleanup has its own question: `references/home.md`.

**Kept on an answer.** When the person keeps the gateway or leaves the tickets in the archive, record it at once, in their words. Memory notes need no person: edit the ones that name an older tool with a v2 equivalent, then record what is left (a path that still exists, a lesson, a gateway named as history) with your own reason:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/upgrade-kept.mjs" --project "${CLAUDE_PROJECT_DIR}" --keep gateway --reason "<their reason>"
```

`--keep` takes `gateway`, `open-tickets` or `memory-notes`. It writes `.claude/quartermaster/upgrade-kept.md`, which git never sees, and every later scan lists that thing under Kept with the date and reason. Only the run writes it, only on an answer, or for memory notes on its own reason.

## 4. Do the steps for this shape

- `team` or `solo`: `references/team-repository.md`.
- `half-moved`: `references/half-moved.md`.
- Old routes or custom categories in the scan: `references/routing.md`.
- `rules-folder` or `rules-page` with verdict convert: `references/older-rules.md`.

Each step has its command and its undo. Do them in order. The one stop comes after this session installed v2 plugins and before the converters. Name both ways through it: `/reload-plugins` here, or a new session in this folder told `continue the upgrade`. A remote connection cannot run that command, so there the new session is the way. A session that installed none (one opened to continue) has v2 loaded already: no stop, on to the converters, also when it switched an older plugin off.

## 5. The rules of the run

- **A settings file git tracks is never changed on the plain run, in any shape**: the committed one, and `.claude/settings.local.json` where a project tracks it (its keys are on no deletion list). The one write into a tracked local file is the plugin switch, which the scan names; it shows in `git status`, and you commit nothing. The person is switched over in `.claude/settings.local.json`. Only a yes to the committed-change question edits it: a team's goes into a drafted branch, a solo repository's into the working tree with `git diff` shown.
- **A settings file is copied before its first edit**, to `<file>.before-upgrade`, and you name the copy. Undo is copying it back. A copy of that name that is already there is from an earlier day and may hold what nobody wants back: leave it, never copy it back, name yours `<file>.before-upgrade-<today's date>`, and say which one is the undo.
- **A map or old rules git tracks never move for one person.** They are the repository's, and they load only through the older mapper or the older rules plugin. The scan keeps that plugin on and lists it under Kept: do not switch it off, and never run `codebase-mapper:map` or the rules converter (`references/older-rules.md`) for a personal copy, which would drift from everyone else's. They move for everyone in the committed change, in one commit: converted to `.claude/rules/` (rules also to `.claude/skills/`), the old folder removed, the committed settings switched. Nobody is left without them and no repository gets two copies.
- **Rules, the map, worktrees and branches go through their own tools**: the converters and `sidequest:tidy`, as the steps say. Keep stays keep.
- **The home folder is its own run**, once, when the scan says no project has the older version switched on (the scan counts settings keys and says how many of those projects were used in the last 30 days, by a session or a commit; `references/home.md` has the one step that switches off the quiet ones), with a yes per group (`references/home.md`). A project's run never shows, sizes or removes anything there, and a yes for a project's things is not a yes for it.

## 6. Done when

- After the last reload, `quartermaster:inspect` shows one plugin per name and the v2 ones loaded.
- The scan again says shape `moved` with nothing under Still to do, or says `Everything left here waits for the person: this run is done until they answer.` Either one is done. In the second, report what waits (the deletion list, the questions) and stop; a run with nobody to answer ends there, and `half-moved` beside that line is not a fault. Everything under Kept stays, for the reason it prints.
- You report what changed, the name of every copy, how to undo each step, each kept thing with its reason (a large old map of their own is the one later step, named: `codebase-mapper:map` when they next work in the project; a map or old rules git tracks wait for the committed change, with the older plugin on until then), and the checkout on the branch it started on.
- Last, one line each for what you saw and left alone as not the upgrade's: test data in a local database, a running process, a container build cache, fetched git objects. Name it, never touch it.
