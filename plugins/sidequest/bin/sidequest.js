#!/usr/bin/env node
"use strict";
const store = require("../lib/store");
const { fail } = require("./sidequest-cmd-shared");
const { PLUGIN_VERSION, cmdDashboard, cmdServe, cmdStop } = require("./sidequest-cmd-server");
const { cmdAdd, cmdList, cmdPulse, cmdChanges, cmdUpdate, cmdRm } = require("./sidequest-cmd-tickets");
const { cmdProfile, cmdCategory, cmdGlobalFallback } = require("./sidequest-cmd-configuration");
const { cmdClaim, cmdCheckpoint, cmdVerdict, cmdRelease, cmdDone, cmdGroomClose, cmdScopeRequest, cmdCommit, cmdRework, cmdSubmit, cmdIntegrate, cmdPublish } = require("./sidequest-cmd-execution");
const { cmdSweepClaims, cmdWorktrees, cmdRecoverShared, cmdNext, cmdWork, cmdReconcile, cmdAssign, cmdRemind, cmdUnremind, cmdComment, cmdComments, cmdLink, cmdUnlink, cmdReady, cmdArchive, cmdUnarchive } = require("./sidequest-cmd-collaboration");
const { cmdDispatch, cmdBriefing, cmdTempCleanup, cmdNativeAgent, cmdModels, cmdRoute, cmdBoardConfig, cmdProjects, cmdRouting, cmdArchiveBoard, cmdUnarchiveBoard, cmdMerge } = require("./sidequest-cmd-dispatch");
const { cmdStory } = require("./sidequest-cmd-story");
const ARRAY_FLAGS = /* @__PURE__ */ new Set(["image", "label", "file", "always-in-scope", "read-only-denied-tool", "auto-approve-scope", "produces", "changes", "consumes"]);
const ARRAY_FLAG_ALIASES = { files: "file", labels: "label" };
const ALIASES = {
  t: "title",
  d: "desc",
  p: "priority",
  l: "label",
  i: "image",
  s: "status",
  b: "by",
  m: "body",
  message: "message",
  append: "append"
};
function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--") || a.startsWith("-")) {
      const isLong = a.startsWith("--");
      let key = a.replace(/^-+/, "");
      let val = null;
      const eq = key.indexOf("=");
      if (eq !== -1) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      if (!isLong && ALIASES[key]) key = ALIASES[key];
      if (ARRAY_FLAG_ALIASES[key]) key = ARRAY_FLAG_ALIASES[key];
      if (key === "no-open") {
        opts.open = false;
        continue;
      }
      if (key === "no-worktree-isolation") {
        opts["worktree-isolation"] = false;
        continue;
      }
      if (key === "no-auto-approve-test-scope") {
        opts["auto-approve-test-scope"] = false;
        continue;
      }
      const BOOL = /* @__PURE__ */ new Set(["json", "brief", "open", "help", "force", "done", "archived", "all", "dry-run", "yolo", "wave", "unclassified", "enabled", "disabled", "no-fallback", "global", "clear", "steal", "shared-tree", "direct", "sweep", "yes", "integration", "override-legacy-scope", "skip-verify", "contract-waiver", "full", "rotate", "worktree-isolation", "auto-approve-test-scope", "high-stakes", "unverified-transport", "allow-repeat-failure", "allow-unscoped"]);
      if (val === null) {
        if (BOOL.has(key)) {
          opts[key] = true;
          continue;
        }
        val = argv[i + 1];
        i++;
      }
      if (key === "project" && opts.project !== void 0) {
        opts.project = Array.isArray(opts.project) ? opts.project.concat(val) : [opts.project, val];
      } else if (ARRAY_FLAGS.has(key)) {
        (opts[key] = opts[key] || []).push(...String(val).split(","));
      } else {
        if (opts[key] !== void 0) fail(`--${key} cannot be repeated; received "${opts[key]}" and "${val}".`);
        opts[key] = val;
      }
    } else {
      positional.push(a);
    }
  }
  return { opts, positional };
}
const HELP_COMMANDS = {
  add: 'sidequest add -t "title" (--category <id> | --complexity 1-10 --why "motivation" | --unclassified) [--file <path>]... [--route-model <model> --route-effort <effort>] [-d desc] [-p low|normal|high|urgent] [--high-stakes] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver] [--readonly true|false] [-i image]... [-s todo|doing|done] [--dry-run] [--json]   (--file declares write scope; a write ticket without it is refused at dispatch)',
  list: "sidequest list [--status todo|doing|done] [--archived] [--json] [--brief] [--limit N] [--cursor <nextCursor>] [--all]  (defaults to active tickets; --status done or --all includes done)",
  pulse: "sidequest pulse <SQ-n> [--project <path-or-slug>]",
  changes: "sidequest changes [--since <iso>] [--project <path-or-slug>]",
  update: 'sidequest update <id|SQ-n> [-t title] [-d desc] [-p priority] [-s status] [--file <path>|--file none]... [--high-stakes[=false]] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver[=false]] [--readonly true|false] [-i image]... [--category <id|none>] [--route-model <model> --route-effort <effort>|--route none] [--complexity 1-10 --why "motivation"] [--by who]',
  rm: "sidequest rm <id|SQ-n> [--force]",
  profile: "sidequest profile <hygiene|list|show|get|create|edit|retire|use|repoint|promote|new-board> ... [--retired] [--project <path-or-slug>] [--dry-run] [--json]",
  category: "sidequest category <list|add|edit|rm|disable|enable|pin|reset> <id> [--profile <profile>|--project <path-or-slug>] [--route-model <model> --route-effort <effort>] [--fallback-model <model> --fallback-effort <effort>|--no-fallback] [--readonly true|false] [--json]",
  "global-fallback": "sidequest global-fallback [--model <model> --effort <effort>] [--json]",
  claim: 'sidequest claim <id|SQ-n> [--by who] [--token-file path] [--token nonce] [--effort level] [--force] [--direct --reason "why"]',
  checkpoint: 'sidequest checkpoint <id|SQ-n> --by who (--commit <hash> | --worktree <absolute-path>) --verify "command: result" [--ttl-minutes N] [--json]',
  claims: "sidequest claims sweep [--project <path-or-slug>]",
  worktrees: "sidequest worktrees sweep [--dry-run] [--yes] [--min-age-hours N] [--project <path-or-slug>]",
  next: 'sidequest next [--by who] [-p priority] [--model <model>] [--category <id>] [--direct --reason "why"]',
  reconcile: 'sidequest reconcile [--session <id>] [--reason "..."]',
  work: "sidequest work|drain",
  "groom-close": "sidequest groom-close <id|SQ-n> --reason <evidence> [--by who] [--integration] [--override-legacy-scope]",
  done: "sidequest done <id|SQ-n> [--by who] [--model tier] [--effort level] [--body-file path]",
  commit: 'sidequest commit <id|SQ-n> --by who --message "message"',
  rework: 'sidequest rework <id|SQ-n> --by candidate-owner --review <review-ticket-or-evidence> --reason "what needs repair"',
  submit: 'sidequest submit <id|SQ-n> --by who (--commit <hash> [--base <hash>] [--gitref refs/sidequest/SQ-n] [--verify "command"] [--worktree path] [--body-file path] [--force] | --clear [-s todo])',
  integrate: "sidequest integrate <id|SQ-n> --by who [--mode merge|replay|apply] [--skip-verify] [--override-legacy-scope] [--json]",
  publish: "sidequest publish <lock|unlock|status|queue> [--repo path] [--steal] [--force] [--json]",
  release: 'sidequest release <id|SQ-n> [--by who] [-s todo] --reason "why" --release-kind technical_blocker --command "failed command" --exit-code N --output-tail "failure output" | --reason "why" --release-kind contradiction --command "verbatim probe" --output-tail "probe output" [--exit-code N] | --reason "why" --release-kind handback | --status doing --oracle "human verdict ask" [--candidate <hash>] [--deliverable <path-or-url>]',
  verdict: 'sidequest verdict <id|SQ-n> --text "verbatim user words" --outcome accepted|rejected|inconclusive [--why "orchestrator reading"] [--constraint "rule bought"]',
  "scope-request": "sidequest scope-request <id|SQ-n> --file path [--file path...] [--by who]",
  assign: "sidequest assign <id|SQ-n> [--to who=you]",
  unassign: "sidequest unassign <id|SQ-n>",
  remind: 'sidequest remind <id|SQ-n> (--in 1h|3h|tomorrow | --at "date/time")',
  unremind: "sidequest unremind <id|SQ-n>",
  comment: 'sidequest comment <id|SQ-n> (-m "body" | --body-file path) [--by who]',
  comments: "sidequest comments <id|SQ-n> [--json] [--full]",
  link: "sidequest link <id|SQ-n> <blocks|depends-on|related> <id|SQ-n>",
  unlink: "sidequest unlink <id|SQ-n> <id|SQ-n>",
  ready: "sidequest ready [--model <model>] [--category <id>] [--json] [--brief]",
  archive: "sidequest archive [<id|SQ-n>] [--done]",
  unarchive: "sidequest unarchive <id|SQ-n>",
  dispatch: "sidequest dispatch <SQ-n> [--shared-tree] [--allow-repeat-failure] [--allow-unscoped] [--project <path-or-slug>] [--session id] [--unverified-transport]",
  briefing: "sidequest briefing <SQ-n> (--token-file <path> | --token <token>) [--project <path-or-slug>]",
  "native-agent": 'sidequest native-agent <SQ-n> [--prompt "task"] [--shared-tree] [--json] [--unverified-transport]',
  temp: "sidequest temp cleanup [--root <path>] [--json]",
  "cleanup-temp": "sidequest cleanup-temp [--root <path>] [--json]",
  models: "sidequest models [--project <path-or-slug>] [--full] [--json]",
  route: "sidequest route <category> [--ticket SQ-n] [--project <path-or-slug>] --json",
  "board-config": 'sidequest board-config [--always-in-scope path]... [--read-only-denied-tool pattern]... [--auto-approve-scope glob]... [--generated-pairs <json>] [--integration-mode <mode>] [--integration-branch <branch>] [--delivery merge|replay|apply] [--integration-verify-timeout-ms <ms>] [--worktree-isolation|--no-worktree-isolation] [--not-integrated-salvage-age-hours <hours>] [--auto-approve-test-scope|--no-auto-approve-test-scope] [--worktree-setup "command"] [--worktree-dependency-paths <json>] [--json]',
  projects: "sidequest projects [--archived] [--json]",
  routing: "sidequest routing [enabled|disabled] [--project <path-or-slug>] [--json]",
  "archive-board": "sidequest archive-board <board-ref> [--json]",
  "unarchive-board": "sidequest unarchive-board <board-ref> [--json]",
  merge: "sidequest merge <src> <dst> [--dry-run]",
  dashboard: "sidequest dashboard [--port N] [--no-open]",
  serve: "sidequest serve [--port N]",
  stop: "sidequest stop",
  story: "sidequest story <add|list|show|contract|update|rm> ... [--full] [--json]"
};
const HELP_ALIASES = {
  new: "add",
  ticket: "add",
  ls: "list",
  edit: "update",
  set: "update",
  remove: "rm",
  delete: "rm",
  profiles: "profile",
  categories: "category",
  global_fallback: "global-fallback",
  take: "claim",
  grab: "next",
  drain: "work",
  complete: "done",
  finish: "done",
  unclaim: "release",
  scope_request: "scope-request",
  restore: "unarchive",
  native_agent: "native-agent",
  board_config: "board-config",
  boards: "projects",
  archive_board: "archive-board",
  unarchive_board: "unarchive-board",
  "restore-board": "unarchive-board",
  open: "dashboard",
  board: "dashboard"
};
function commandHelp(command) {
  const name = HELP_ALIASES[command] || command;
  const usage = HELP_COMMANDS[name];
  if (!usage) return false;
  console.log(`Usage:
  ${usage}

Run "sidequest help" for all commands.`);
  return true;
}
function help() {
  const colorNames = Object.keys(store.STORY_COLOR_NAMES || {}).join(", ");
  console.log(
    `sidequest — a Trello-light quest log for Claude Code

Usage:
  sidequest add -t "title" (--category <id> | --complexity 1-10 --why "<motivation>" | --unclassified) [--file <path>]... [--route-model <model> --route-effort <effort>] [-d desc] [-p low|normal|high|urgent] [--high-stakes] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver] [--readonly true|false] [-i image]... [-s todo|doing|done]
      --file declares the write scope. A write-capable ticket with no --file is refused at dispatch, because it can never win a scope request.
  sidequest list [--status todo|doing|done] [--json] [--brief] [--limit N] [--cursor <nextCursor>] [--all]   active tickets by default; use --status done or --all for completed tickets. --brief: compact JSON, no bodies; implies --json. Follow nextCursor until null.
  sidequest pulse <SQ-n> [--project <path-or-slug>]   compact liveness read for one ticket
  sidequest changes [--since <iso>] [--project <path-or-slug>]   compact ticket delta (defaults to last 60 min)
  sidequest update <id|SQ-n> [-t title] [-d desc] [-p priority] [-s status] [--file <path>|--file none]... [--high-stakes[=false]] [-l label]... [--produces name]... [--changes name]... [--consumes name]... [--contract-waiver[=false]] [--readonly true|false] [-i image]... [--category <id|none>] [--route-model <model> --route-effort <effort>|--route none] [--complexity 1-10 --why "<motivation>"]
  sidequest profile hygiene|list|show|get|create|edit|retire|use|repoint|promote|new-board ... [--json]
  sidequest category list|add|edit|rm|disable|enable|pin|reset <id> (--profile <profile> | --project <path-or-slug>) [--route-model <model> --route-effort <effort>] [--fallback-model <model> --fallback-effort <effort> | --no-fallback] [--readonly true|false] [--json]
  sidequest global-fallback [--model <model> --effort <effort>] [--json]
  sidequest rm <id|SQ-n> [--force]
  sidequest projects [--archived] [--json]
  sidequest routing [enabled|disabled] [--project <path-or-slug>] [--json]
  sidequest archive-board <board-ref>                  archive a board
  sidequest unarchive-board <board-ref>                restore an archived board
  sidequest dashboard [--port N] [--no-open]     open the live board in the browser
  sidequest serve [--port N]                     run the board server in the foreground
  sidequest stop                                 stop the running board server

  -d/-m accept full markdown (headings, lists, fenced code, blockquotes, links, **bold**/*italic*/inline
    code) — use real newlines in the value (heredoc or $'...\\n...'), never a literal backslash-n.

Working the board safely (multi-agent):
  sidequest ready [--model <model>] [--category <id>] [--json] [--brief]   the ready set (unclaimed, unblocked) — fan subagents over it
  sidequest claim <id|SQ-n> [--by who] [--force] [--token-file path] [--token nonce] [--effort level] [--direct --reason "why this is inline-safe"]   atomically take a ticket (category-routed executor claims require a prepared token file and exact executor; direct is an inline-safe exception)
  sidequest checkpoint <id|SQ-n> --by who (--commit <hash> | --worktree <absolute-path>) --verify "<command: result>" [--ttl-minutes N]   record a live review candidate while the claim and dispatch stay active
  sidequest next [--by who] [-p priority] [--model <model>] [--category <id>] [--direct --reason "why this is inline-safe"]   claim the best available ticket (routed tickets need --direct here because next has no dispatch token)
  sidequest done <id|SQ-n> [--by who] [--model tier] [--effort level] [--body-file path]   close non-repo or active authorized artifact work
  sidequest groom-close <id|SQ-n> --reason <evidence> [--by who] [--integration] [--override-legacy-scope]   control-plane closure; --integration consumes a submitted ticket after publish, and the override permits only legacy submissions without a scope snapshot
  sidequest release <id|SQ-n> [--by who] [-s todo] --reason "why" --release-kind technical_blocker --command "failed command" --exit-code N --output-tail "failure output" | --reason "why" --release-kind contradiction --command "verbatim probe" --output-tail "probe output" [--exit-code N] | --reason "why" --release-kind handback | --status doing --oracle "human verdict ask" [--candidate <hash>] [--deliverable <path-or-url>] drop the claim without finishing
  sidequest verdict <id|SQ-n> --text "verbatim user words" --outcome accepted|rejected|inconclusive [--why "orchestrator reading"] [--constraint "rule bought"] record an oracle verdict
  sidequest scope-request <id|SQ-n> --file path [--file path...] [--by who] request scope and receive an immediate ruling
  sidequest commit <id|SQ-n> --by who --message "message"  commit only the ticket's declared scope; staged foreign paths stay staged
  sidequest rework <id|SQ-n> --by reviewer --review <review-ticket-or-evidence> --reason "what needs repair"  reject a ready submission for repair, retain its candidate and review evidence, then dispatch the same ticket for a normal replacement claim
  sidequest submit <id|SQ-n> --by who --commit <hash> [--base <hash>] [--gitref refs/sidequest/SQ-n] [--verify "<cmd>"] [--worktree path] [--body-file path] [--force]
    executor terminal for repo-changing tickets: park the verified LOCAL commit as READY_FOR_INTEGRATION
    (releases the claim, status stays doing; no push, no version bumps — the orchestrator publishes).
    --force only lets the existing submitted candidate owner replace their own pending candidate; it never authorizes a foreign submit or rejection.
  sidequest submit <id|SQ-n> --clear [-s todo]     orchestrator reset: drop a submission after a bounced integration
  sidequest integrate <id|SQ-n> --by who [--mode merge|replay|apply]   deliver a ready submission and close it with the durable ref recorded
  sidequest publish lock|unlock|status [--repo path] [--steal] [--force]   cross-process publish lock (owner pid +
    session metadata in the repo's common git dir; stale/dead holders reclaimable, --steal takes over explicitly)
  sidequest publish queue [--json]                 tickets awaiting the publish transaction, oldest first
  A claim guarantees no other worker is on the ticket. Never work a ticket whose claim did not succeed.
  When 2+ ready tickets are independent (no shared files), fan out one subagent per ticket in parallel.
  sidequest add/update ... --file path [--file path...] (or --files "path,...")   declare the files a ticket will touch — repeat for
    several; "none" clears (update only). 'ready' groups tickets into parallel-safe waves by declared file
    scope: tickets in the same wave never touch overlapping files/directories; untagged tickets never conflict.
  sidequest add/update ... --produces name --changes name --consumes name   declare free-form contract edges;
    'ready --brief' reports a produce/consume or change/change collision in waveDependencies. --contract-waiver
    is a reviewed override and can be cleared with --contract-waiver=false.
  sidequest add/update ... --anchors "file:line symbol" --verify "<exact command>"
    seed a bounded executor with investigation findings and its exact check. Anchors (4k), verify (1k), and the
    final prompt (7.6k) stay below the Windows command-line ceiling; values are preserved verbatim.

Complexity is legacy input. Category routing chooses the concrete model and effort:
  sidequest add ... --category <id>
  sidequest update <id|SQ-n> --category <id|none>
  sidequest ready --model <model> --category <id>  ·  sidequest next --model <model> --category <id>
  sidequest models [--project <path-or-slug>] [--full] [--json]  available models and effective category routes (use --full for detailed configuration)
  sidequest route <category> [--ticket SQ-n] [--project <path-or-slug>] --json  live workflow agent recipe for a category or ticket
  sidequest global-fallback [--model <model> --effort <effort>] [--json]
  Legacy --complexity + --why remains supported for existing intake and maps to a category at read time.
  Ticket model and effort are resolved from its category. Use category add/edit to change routing policy.

Native Agent dispatch (routed work stays in this conversation):
  sidequest dispatch <SQ-n> [--shared-tree] [--allow-repeat-failure] [--allow-unscoped] [--project <path-or-slug>] [--session id] [--unverified-transport]  prepare a token-gated dispatch: declared-file tickets use worktrees unless shared state or bounded artifact output is explicit; --allow-unscoped explicitly accepts a write ticket can block before submission; CLI transport refuses unless --unverified-transport (does not prove any session gets the board MCP); use the board MCP dispatch tool instead
  sidequest briefing <SQ-n> --token-file <path> [--project <path-or-slug>]  print the current token-gated executor briefing
  sidequest native-agent <SQ-n> [--prompt "task"] [--shared-tree] [--json] [--unverified-transport]  return an already-registered native Agent spawn spec + bounded prompt; CLI transport refuses unless --unverified-transport
  sidequest native-agent cleanup --name <name>        clean up any legacy temporary native Agent definition
    Invoke the returned executor through the current conversation's Agent tool. It is already registered; native-agent does not write a temporary definition.
    \`sidequest work\`/\`drain\` are disabled because they cannot invoke Agent and never start a separate Claude process.
  sidequest reconcile [--session <id>] [--reason "..."]   release a session's claims back to todo now
    (the SessionEnd hook calls this automatically on the session id it's given, so a crashed/ended worker's
    tickets recover immediately; safe — it only touches that session's claims).
    Defaults to $CLAUDE_CODE_SESSION_ID when --session is omitted.
  sidequest claims sweep [--project <path-or-slug>]  audit residual claims after terminal failures already release their exact claim,
    then two activity-based backstops: no board activity for SIDEQUEST_CLAIM_IDLE_MIN (default 60m) with no live executor
    associated, or SIDEQUEST_CLAIM_ABANDON_MIN (default 1440m) for a death nothing observed. A running executor's claim is
    never swept on age, and closeout (commit/submit/done) never consults these windows.
  sidequest worktrees sweep [--dry-run] [--yes] [--min-age-hours N] [--project <path-or-slug>]  list unlocked stale agent worktrees; backs up dirty cleanup before removal
  sidequest recover-shared --project <path-or-slug> --stash <stash@{n}> --yes  reset a dirty shared checkout only after verifying its named stash

Assigning (persistent owner, e.g. handing a ticket to the human — separate from a claim):
  sidequest assign <id|SQ-n> [--to who=you]        assign a ticket (defaults to "you", the human)
  sidequest unassign <id|SQ-n>                      clear the assignee

Reminders (fires into the notification queue/bell inbox when the dashboard server is running):
  sidequest remind <id|SQ-n> --in 1h|3h|tomorrow   schedule a reminder from a preset
  sidequest remind <id|SQ-n> --at "<date/time>"    or a specific date/time
  sidequest unremind <id|SQ-n>                      cancel a pending reminder

Comments:
  sidequest comment <id|SQ-n> (-m "body" | --body-file path) [--by who]   durable cross-actor handoff; keep going
  sidequest comments <id|SQ-n> [--json] [--full]   list a ticket's comment thread

Links / dependencies:
  sidequest link <id|SQ-n> <blocks|depends-on|related> <id|SQ-n>   relate two tickets (inverse auto-set)
  sidequest unlink <id|SQ-n> <id|SQ-n>             remove the link between two tickets
  A ticket blocked by an unfinished ticket is skipped by 'next'/'ready' and shown as blocked.

Archive (put finished work out of the way, restorable):
  sidequest archive <id|SQ-n>                      archive one ticket    ·    --done archives ALL done
  sidequest unarchive <id|SQ-n>                    restore an archived ticket
  sidequest list --archived                        list archived tickets
  sidequest archive-board <board-ref>               archive a board (explicit reference required)
  sidequest unarchive-board <board-ref>             restore an archived board
  sidequest projects --archived                     list archived boards

User stories (a lightweight grouping tickets can belong to):
  sidequest story add -t "title" [-d desc] [--color <name|hex>]   create a story (prints its US-n ref)
  sidequest story list                             list stories with their color and ticket count
  sidequest story show US-n                         show a story and the tickets in it
  sidequest story contract US-n [-m text|--body-file path]  read or set its execution contract
  sidequest story log US-n [-m text|--body-file path] [--ref SQ-n] [--by who] [--rotate]  read, append, or rotate its decision log
  sidequest story update US-n [-t] [-d] [--color]  edit a story
  sidequest story rm US-n                           delete a story (member tickets are detached)
  sidequest add ... --story <US-n>                 file a ticket straight into a story
  sidequest update <id|SQ-n> --story <US-n|none>   move a ticket into a story, or "none" to clear
  --color names: ${colorNames} (or any #rrggbb hex)

Project selection:
  Boards are anchored to the git repo you're in: the CLI walks up from
  $CLAUDE_PROJECT_DIR (or the current directory) to the nearest .git, so running
  it from a subfolder uses the repo's one board instead of minting a duplicate.
  A folder with no repo is used as-is.
  --project <path-or-slug>   target another board  ·  --name <name>   set its display name
    A slug or display name must already be registered. An absolute path to a real
    directory is created on first use, so you can file into another repo's board
    (even one that doesn't exist yet) from anywhere by passing its full path.
  sidequest board-config [--name <display-name>] [--always-in-scope <path>...] [--read-only-denied-tool <pattern>...] [--auto-approve-scope <glob>...] [--generated-pairs <json>] [--integration-mode <auto|local|remote>] [--integration-branch <branch>] [--delivery <merge|replay|apply>] [--worktree-isolation|--no-worktree-isolation] [--not-integrated-salvage-age-hours <hours>] [--auto-approve-test-scope|--no-auto-approve-test-scope] [--worktree-setup <command>] [--worktree-dependency-paths <json>]
    View or update board settings. --name changes only the display name; the slug, path, tickets, claims, and refs stay put.
  sidequest merge <src> <dst> [--dry-run]   fold one board entirely into another
    (renumbers refs above the destination's, remaps links, moves assets, then
    deletes the source). --dry-run prints the ref mapping without touching disk.

Tickets and their images are stored centrally (default ~/.claude/sidequest), so
one dashboard shows every project's board at once.`
  );
}
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const { opts, positional } = parseArgs(argv.slice(1));
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    console.log(PLUGIN_VERSION || "unknown");
    return;
  }
  if (opts.help) {
    if (!commandHelp(cmd)) help();
    return;
  }
  switch (cmd) {
    case "add":
    case "new":
    case "ticket":
      await cmdAdd(opts);
      break;
    case "list":
    case "ls":
      await cmdList(opts);
      break;
    case "pulse":
      await cmdPulse(opts, positional);
      break;
    case "changes":
      await cmdChanges(opts);
      break;
    case "update":
    case "edit":
    case "set":
      await cmdUpdate(opts, positional);
      break;
    case "rm":
    case "remove":
    case "delete":
      await cmdRm(opts, positional);
      break;
    case "profile":
    case "profiles":
      await cmdProfile(opts, positional);
      break;
    case "category":
    case "categories":
      await cmdCategory(opts, positional);
      break;
    case "global-fallback":
    case "global_fallback":
      await cmdGlobalFallback(opts);
      break;
    case "claim":
    case "take":
      await cmdClaim(opts, positional);
      break;
    case "checkpoint":
      await cmdCheckpoint(opts, positional);
      break;
    case "claims":
      if (positional[0] !== "sweep") fail("claims: expected `sidequest claims sweep`");
      await cmdSweepClaims(opts);
      break;
    case "worktrees":
      await cmdWorktrees(opts, positional);
      break;
    case "recover-shared":
      await cmdRecoverShared(opts);
      break;
    case "next":
    case "grab":
      await cmdNext(opts);
      break;
    case "reconcile":
      await cmdReconcile(opts);
      break;
    case "work":
    case "drain":
      await cmdWork(opts);
      break;
    case "groom-close":
      await cmdGroomClose(opts, positional);
      break;
    case "done":
    case "complete":
    case "finish":
      await cmdDone(opts, positional);
      break;
    case "scope-request":
    case "scope_request":
      await cmdScopeRequest(opts, positional);
      break;
    case "commit":
      await cmdCommit(opts, positional);
      break;
    case "rework":
      await cmdRework(opts, positional);
      break;
    case "submit":
      await cmdSubmit(opts, positional);
      break;
    case "integrate":
      await cmdIntegrate(opts, positional);
      break;
    case "publish":
      await cmdPublish(opts, positional);
      break;
    case "verdict":
      await cmdVerdict(opts, positional);
      break;
    case "release":
    case "unclaim":
      await cmdRelease(opts, positional);
      break;
    case "assign":
      await cmdAssign(opts, positional, false);
      break;
    case "unassign":
      await cmdAssign(opts, positional, true);
      break;
    case "remind":
      await cmdRemind(opts, positional);
      break;
    case "unremind":
      await cmdUnremind(opts, positional);
      break;
    case "comment":
      await cmdComment(opts, positional);
      break;
    case "comments":
      await cmdComments(opts, positional);
      break;
    case "link":
      await cmdLink(opts, positional);
      break;
    case "unlink":
      await cmdUnlink(opts, positional);
      break;
    case "ready":
      await cmdReady(opts);
      break;
    case "archive":
      await cmdArchive(opts, positional);
      break;
    case "unarchive":
    case "restore":
      await cmdUnarchive(opts, positional);
      break;
    case "dispatch":
      await cmdDispatch(opts, positional);
      break;
    case "briefing":
      await cmdBriefing(opts, positional);
      break;
    case "temp":
      await cmdTempCleanup(opts, positional);
      break;
    case "cleanup-temp":
      await cmdTempCleanup(opts, positional);
      break;
    case "native-agent":
    case "native_agent":
      await cmdNativeAgent(opts, positional);
      break;
    case "models":
      await cmdModels(opts, positional);
      break;
    case "route":
      await cmdRoute(opts, positional);
      break;
    case "board-config":
    case "board_config":
      await cmdBoardConfig(opts);
      break;
    case "projects":
    case "boards":
      await cmdProjects(opts);
      break;
    case "routing":
      await cmdRouting(opts, positional);
      break;
    case "archive-board":
    case "archive_board":
      await cmdArchiveBoard(opts, positional);
      break;
    case "unarchive-board":
    case "unarchive_board":
    case "restore-board":
      await cmdUnarchiveBoard(opts, positional);
      break;
    case "merge":
      await cmdMerge(opts, positional);
      break;
    case "dashboard":
    case "open":
    case "board":
      await cmdDashboard(opts);
      break;
    case "serve":
      await cmdServe(opts);
      break;
    case "stop":
      await cmdStop();
      break;
    case "story":
      await cmdStory(opts, positional);
      break;
    default:
      fail(`unknown command "${cmd}". Run "sidequest help".`);
  }
}
main().catch((err) => {
  console.error(`sidequest: ${err && err.message || err}`);
  process.exit(1);
});
