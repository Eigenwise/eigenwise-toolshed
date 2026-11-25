# Toolshed docs

The documentation site for the Toolshed. Astro 5 with Starlight. It deploys to GitHub Pages from `main` with `.github/workflows/docs.yml`, at `https://eigenwise.github.io/eigenwise-toolshed/`.

## Run it

```bash
npm install
```

```bash
npm run dev
```

It serves on `http://127.0.0.1:4330/eigenwise-toolshed/`. The folder is the `base` in `astro.config.mjs`, and `src/remark/prefix-base.mjs` adds it to links written as `/guides/...` in page text.

## Check it

```bash
npm run build
```

```bash
npm run check
```

```bash
npm run links
```

`links` reads the built site in `dist/`, so run it after `build`.

## The pictures

```bash
npm run screens
```

It writes every picture into `src/assets/screens/`, with `captions.json` beside them, after removing the ones its last run wrote (a screenshot taken in the app stays). Run twice, it writes the same files. The pictures are committed, so `build` and CI never need a browser. To write them somewhere else, say where:

```bash
npm run screens -- --into <folder>
```

What it does:

1. Makes a scratch folder in the system temp folder and deletes it at the end.
2. Plays one made-up task, `PAY-41` in a project called `photo-library`, from the first message to the pull request recorded on the board. Each step goes through Sidequest's own ticket tool, run tools and the functions the pane's buttons call, and the board is saved after it as a named state (`STORY_STATES` in `screens/sidequest-story.mts`): planned with open decisions, decisions answered, before the yes, building, agents finished, being checked, the commit question, answered, done. The merge happens on the code host, which the board does not draw.
3. Seeds the other plugins from the same story: Quartermaster's events (hand runs of the thumbnail build before the task, an agent blocked on the import proof during it) and its two proposals through its own store, a project the older Toolshed left things in, and Observability's ledger rows for the days before the task and for each turn of the task's session, through its own recording functions.
4. Draws each screen with the plugins' own view code. The views return the host's elements (`Box`, `Text`, `Button` and the rest); `screens/host-drawing.mts` draws those as HTML in a terminal's grid, and only as far as the host's types say: a field is its label and its text. The usage page is Observability's own HTML file.
5. Takes each picture with Chrome, Edge or Chromium already on the machine, through its own command line. No package is installed for it. With none found it prints which pictures it skipped, leaves the committed ones as they are and exits 0.

The numbered pictures are the walk-through, in order. Each has alt text, a `caption` (the line under it) and `drawnBy` (what drew it) in `captions.json`. `Frame.astro` puts one on a page by its file name and reads all three from there. The pictures ship exactly as the pipeline draws them: no editing step touches them. `SCREENSHOTS-NEEDED.md` lists every frame of the walk-through with its kind, and what only the app can show.

Every name, ticket, cost and session id comes from `screens/made-up.mts`. Keep it made up. A moment only the desktop app can show is not drawn here. On a page it is a text drawing, and `SCREENSHOTS-NEEDED.md` lists it.

To add a screen, pick a state of the story (or add a step to it) and a drawing in `screens/sidequest-screens.mts`, then add it to `screens/pictures.mts` with its alt text, caption and what drew it.

The usage page reads its clock in the viewer's time zone, and Chrome on Windows ignores `TZ`, so the pipeline sets the page's clock to UTC before the page's own script runs. Every machine takes the same picture.

`npm run check` type-checks the pipeline too, through `screens/tsconfig.json`, against the host's types in the repository's untracked `.types/` folder. In a linked worktree without them it copies the main checkout's, as the repository's own check does. Without either it says the pipeline's types were not measured. The docs CI runs only `build` and `links`, so it never runs this type check: run `npm run check` here before you commit a change to `screens/`.

## How it is put together

| Path | What |
| --- | --- |
| `src/content/docs/` | The pages. Hand-written, except `reference/`. |
| `src/content/docs/reference/` | Generated. Not committed. Rebuilt before every `dev`, `build` and `check`. |
| `scripts/generate-reference.mjs` | Writes the reference from the plugin manifests, skill and agent frontmatter, the tool specs and the default routing table. |
| `scripts/reference-notes.json` | One plain line per file a plugin writes and per script it ships. Each file entry has a proof string that must still be in the plugin, or the build fails. |
| `scripts/check-links.mjs` | Checks every internal link and anchor in the built site. |
| `src/mocks/*.txt` | The text of every text drawing: what a command prints, or a screen only the app draws. Taken from what the tools print, with machine paths replaced. |
| `src/components/Frame.astro` | A rendered picture from `src/assets/screens/`, with its alt text and caption from `captions.json`. |
| `src/components/Terminal.astro` | A terminal window drawn from a text file. It is tagged `text drawing`, and a caption that does not say so fails the build. |
| `src/components/AppFrame.astro` | A text drawing of a session with a pane beside the chat, as the terminal or the desktop app. |
| `src/components/MockLines.astro` | Turns mock text into styled lines. Its header says what a line's first characters mean. |
| `src/components/Flow.astro` | A row of named steps that wraps on a narrow screen. |
| `src/components/Diagram.astro`, `Sequence.astro`, `Mermaid.astro` | Diagrams. |
| `screens/` | The pipeline behind `npm run screens`. |
| `src/assets/screens/` | Generated by `npm run screens` and committed. `captions.json` holds each picture's alt text, caption and what drew it. |
| `SCREENSHOTS-NEEDED.md` | The walk-through frame by frame with its kind, and the screens only the desktop app can show. |

## Rules for a page

- One idea per page. Short sentences, plain words.
- Explain a word the first time it appears. `start/words.md` has them all.
- No em dashes and no marketing words.
- No person, project or company names in a page or a mock.
- Every command, file name and claim is checked against the repository. Where a page in the repository and the code disagree, the code wins.
- A picture of a screen comes from the pipeline, with `Frame`. Where the pipeline cannot draw it, a text drawing in `src/mocks/` is used, and its caption says it is a text drawing of what the app shows there. A caption that does not fails the build.
- A frame that borrows from the walk-through names the same task, `PAY-41` in `photo-library`.

## Adding a text drawing

1. Run the tool against a scratch project in a temp folder.
2. Copy what it printed into a new file in `src/mocks/`.
3. Replace anything that names your machine.
4. Import it with `?raw` and pass it to `Terminal` or `AppFrame`.
