# Screenshots needed

Two kinds of picture go on the site.

- **Rendered.** `npm run screens` renders it through the plugin's own view code from a scratch project with made-up work, and takes its picture with a browser on the machine. See the README. These are committed in `src/assets/screens/` with their alt text, caption and what drew them in `captions.json`, and ship as drawn.
- **Needs the app.** The desktop app's own chrome, its plugin browser, its native buttons and fonts, a permission prompt, the host's own transcript rows, a toast, or what a model says in a live session. On a page each of these is a text drawing, and the line under it says so. They do not block a release. The list below is later work.

## How the app's pictures get made

By a script that captures the app's window from a scratch project with made-up tickets that follows the same story: a folder called `photo-library`, the task `PAY-41`, tickets `PL-1` to `PL-3` with the titles below, the same answers. The script crops the capture to the chat and the pane. An uncropped capture is never kept or committed, because it shows the sidebar with session titles. No real project names, people, session ids or costs. The script is not written yet.

## The walk-through, frame by frame

One made-up task, `PAY-41` "Upload retry" in `photo-library`, from the first message to the pull request, then Quartermaster after the run, in the order things happen. The story is played once in `screens/sidequest-story.mts` (`STORY_STATES`) and every frame is drawn from it; `screens/made-up.mts` holds every word. The line under each frame is its `caption` in `captions.json`.

The tickets: `PL-1` Retry a failed upload once before giving up, `PL-2` Show which photos failed to upload, `PL-3` Try the failed photos again (blocked by `PL-2`). The plan is `PL-S1`. The person answers decisions 1 and 2 with the recommended answer and 3 with the other one, in their own words: "Build the button. It is why the mockup changed." Decisions 4 and 5 are taken by default. Their last answer is "A. Commit, push and open the pull request".

| # | Frame | Kind | File, or what must be on screen |
| --- | --- | --- | --- |
| 1 | The first message in the chat | Rendered (the board's tool row and the board are the plugin's; the person's message line, the prompt box, the band's place above it and the window are the docs' own) | `01-first-message.png` |
| 1a | The same message in the desktop app, with the model's reply pointing at the board | Needs the app | `Let's do PAY-41` typed, the reply that says the plan is on the board, and the board pane opening beside the chat with `3 decisions on the plan`. |
| 2 | The board with what waits on you | Rendered | `02-board-plan-waits.png` |
| 3 | The plan: its short version and the open decisions | Rendered | `03-plan-open-decisions.png` |
| 4 | The decisions answered as one form, the person's own words in it | Rendered | `04-plan-decisions-filled-in.png` |
| 5 | The plan after Send: each pick and the person's words kept | Rendered | `05-plan-decisions-answered.png` |
| 6 | The answers as the person's one message in the chat | Rendered (as frame 1) | `06-chat-decisions-sent.png` |
| 7 | The board waiting for the yes | Rendered | `07-board-waits-for-the-yes.png` |
| 8 | The plan before the yes | Rendered | `08-plan-before-the-yes.png` |
| 9 | The yes, and the build started | Rendered (the board's start rows, the Agent rows, the band and the board are the plugin's; the person's message line, the prompt box and the band's place are the docs' own) | `09-build-started.png` |
| 9a | The build started among the host's own rows | Needs the app | The two `board PL-n started` rows and the two Agent calls in a real terminal transcript, with the host's own agent rows under them. |
| 10 | Who decided what, after the yes | Rendered | `10-plan-who-decided-what.png` |
| 11 | A ticket opened in full while it is built | Rendered (its title, facts, What, Done when and Already decided; the pane leaves the ticket's log out) | `11-ticket-opened.png` |
| 12 | Agents running on the board | Rendered | `12-board-agents-running.png` |
| 13 | The agents finished | Rendered | `13-board-agents-finished.png` |
| 13a | The toast when an agent finishes | Needs the app | The host's toast for `PL-1` coming back, over the session. |
| 14 | One finished agent opened: its row opens its ticket | Rendered | `14-finished-agent-opened.png` |
| 14a | View into that agent's transcript | Needs the app, terminal only | The host's transcript view of `PL-1`'s agent, opened from View on its row while it runs. |
| 15 | The board being checked | Rendered | `15-board-being-checked.png` |
| 16 | What changed and how it was checked | Rendered | `16-ticket-being-checked.png` |
| 17 | The board with the one question | Rendered | `17-board-waits-on-you.png` |
| 18 | The question opened | Rendered | `18-ticket-waits-on-you.png` |
| 19 | An answer picked, before Send | Rendered | `19-ticket-answer-picked.png` |
| 20 | The answer sent, kept on the ticket | Rendered | `20-ticket-answer-sent.png` |
| 21 | The answer in the chat, and the board recording the pull request | Rendered (as frame 1) | `21-pull-request-recorded.png` |
| 21a | The turn that commits, pushes and opens the pull request | Needs the app | Between the person's answer and the board's row in frame 21: the host's Bash rows for `git commit` and `git push` on `PAY-41-retry`, and the one that opens the pull request, with its address `https://git.example/photo-library/pull/1`. |
| 22 | The board after the run | Rendered | `22-board-done.png` |
| 23 | Where the work ended: the pull request on the ticket | Rendered (`PL-1` opened: its facts say `pull request #1` and done) | `23-ticket-pull-request.png` |
| 23a | The merged result | Needs the app (the code host) | The pull request `PAY-41 Retry a failed upload and list what still failed` merged on the code host, with its description as the ticket gave it. The board records the pull request; it never draws a merge. |
| 24 | A Quartermaster proposal waiting in the pane | Rendered | `24-quartermaster-inbox.png` |
| 25 | The proposal opened | Rendered | `25-quartermaster-proposal.png` |
| 25a | The proposal applied | Needs the app | The chat after Approve on `P-0001`: the apply skill's lines and the `thumbs` line it adds to `package.json`. Model output, so only a real session shows it. |
| 26 | The pane after it was applied | Rendered | `26-quartermaster-applied.png` |
| 27 | What led to the standing yes: the blocked command, noticed | Rendered | `27-standing-yes-noticed.png` |
| 27a | The block itself | Needs the app | An agent's `npm run test:import` refused in a real session, as the host shows a blocked command. |
| 27b | The draft | Needs the app | The turn after Draft a fix on the noticed line: the session reads the evidence and writes `P-0002`, a proposal of kind `permission` for `npm run test:import`. Model output and the host's tool rows, so only a real session shows it. |
| 28 | The standing yes, asked | Rendered (a Quartermaster proposal of kind `permission`) | `28-standing-yes-asked.png` |
| 28a | The standing yes, answered and saved | Needs the app | Approve on `P-0002`, the apply skill's turn, and `.claude/settings.local.json` with `Bash(npm run test:import)` under `permissions.allow`. |
| 29 | The pane once it is saved | Rendered | `29-standing-yes-saved.png` |

Beside the walk-through, the pipeline also draws `older-toolshed-notice.png` (Quartermaster's notice lines for a made-up project the older Toolshed left things in), `upgrade-scan.png` (the upgrade's scan of that project) and `usage-page.png` (Observability's page for `photo-library`, from the same session's turns, with its clock set to UTC so every machine takes the same picture).

The pane pictures draw the terminal's look: a plain Button as its words, any other as `[ label ]`, and a field as its label and its text. The window, the pane's border and the prompt box around them are the docs' own, drawn plainly.

On the walk-through page, three of the moments above are text drawings: the first message with Claude's reply (1a), the merged pull request on the code host (23a) and the settings file after the standing yes (28a). The others are named in a paragraph at its end.

## Only the desktop app can show these

Besides the `a` frames above:

| # | Surface | What has to be on screen |
| --- | --- | --- |
| 1 | Desktop app | The **+** menu next to the message box, open on the plugin browser, with `sidequest` from `eigenwise-toolshed` in view. |
| 2 | Desktop app | The board pane beside the chat while two agents run, as frame 12: **Now** with two rows and their models, **Next** with one row, and the band above the message box. |
| 3 | Desktop app | The question opened from **Waits on you**, as frame 18, with the desktop's own buttons. |
| 4 | Desktop app | The `/quartermaster` pane with one proposal and the desktop's own Approve, Reject, Already handled and Later buttons, as frame 25. |
| 5 | Desktop app | The older-Toolshed notice as the desktop app shows it. `older-toolshed-notice.png` has its words as a plain line. |

2, 3, 4 and 5 are what a desktop user compares their screen with; the rendered frames cover the terminal.

## Where they go

Each file goes in `docs/src/assets/screens/` beside the rendered ones, under a name the pipeline does not write, and is used on the page in place of the text drawing.
