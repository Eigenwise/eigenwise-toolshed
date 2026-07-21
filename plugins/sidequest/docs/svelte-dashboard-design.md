# Svelte 5 dashboard rewrite

This document is the parity contract and pinned architecture for replacing `dashboard/index.html` with a typed Svelte 5 application. The first implementation is a rewrite of the current dashboard, not a product redesign. A behavior listed here must either survive the rewrite or be called out in a follow-up ticket before the rewrite ships.

## Pinned decisions

- Build a client-only Svelte 5 application with plain Vite and TypeScript.
- Keep one browser route at `/`. Do not add a client router.
- Keep the existing same-origin JSON API. API routes stay under `/api/`.
- Keep polling at 2.5 seconds for the parity release. There is no server-sent events endpoint today.
- Commit the production build under `plugins/sidequest/dashboard/dist/`. The plugin never installs frontend dependencies or builds assets on a user's machine.
- Serve `dist/index.html` and its hashed assets from the rewritten local server.
- Put shared reactive state in rune-based `.svelte.ts` classes, instantiate it in `App.svelte`, and pass it through typed context.
- Use `$state.raw` for server response arrays that are replaced as snapshots, `$state` for local interaction state, `$derived` or `$derived.by` for projections, and `$effect` only when synchronizing an external system cannot be expressed through an event or lifecycle boundary.
- Keep the current light visual theme and system font stack for parity. Centralize semantic CSS custom properties so another theme can be added later without changing components.
- Use the real built application and a synthetically seeded, isolated Sidequest server in Playwright. Never point tests or screenshots at a live board.

## Source inventory

The current browser application is one file:

- Theme and layout CSS: `dashboard/index.html:15-683`
- Static shell and ticket dialog: `dashboard/index.html:686-948`
- State, rendering, API calls, and interaction wiring: `dashboard/index.html:950-3365`

The current HTTP contract is in `lib/server.js:252-955`. The server has no event-stream response and the client never constructs an `EventSource`.

The Svelte style references were read-only:

- `C:\dev\personal-website\svelte.config.js:72-103` forces runes mode.
- `C:\dev\personal-website\src\lib\components\ArticleEngage.svelte:7-74` keeps props, derived values, small local state, and event handlers close to the component.
- `C:\dev\Cantizans\svelte.config.js:3-18` forces runes mode for application code.
- `C:\dev\Cantizans\src\lib\state\settings.svelte.ts:28-102` uses a class with `$state` fields and methods for shared reactive state.
- `C:\dev\Cantizans\src\routes\(app)\+layout.svelte:11-35` derives view state from a small set of inputs instead of synchronizing duplicate values.

The rewrite should follow those runes and component-boundary habits. It should keep Sidequest's existing handcrafted CSS rather than bring in Tailwind.

## Current feature inventory

### Application shell and project rail

- The page has a Sidequest wordmark, a project rail, the main workspace, a global ticket dialog, an image lightbox, and a toast region.
- `All boards` is a synthetic project row. It aggregates todo, doing, done, and open counts across active projects.
- Every active project row shows its name, filesystem path, open count, a three-segment status bar, an unread-change badge, and a muted-notification icon when applicable.
- Selecting a project scopes tickets and stories, resets the card-arrival baseline, clears that project's unseen badge, leaves the archive view, and updates the title and subtitle.
- On first load, exactly one active project is selected automatically. Multiple projects leave the user on `All boards`.
- Unseen badges count background changes since the project's locally stored `lastSeen` timestamp. Changes whose source is `dashboard` do not count. Disabled notification kinds also do not count.
- The selected board is continually marked seen while it is open. Selecting `All boards` marks every active board seen.
- Active project rows have a context menu. It supports archive and permanent delete. Both actions show native confirmation dialogs with ticket counts.
- Archived projects appear in a collapsible `Archived boards` group. Clicking one restores it. Its context menu also offers restore.
- The archive button shows the archived-ticket count for the current scope and toggles between board and archive views.
- The rail footer shows `live` or `offline` based on refresh success.

### Toolbar and filters

- The title is `All boards` with project and ticket totals, or the selected project's display name and path.
- Search matches case-insensitively against ref, title, description, and labels. It updates on every input event.
- Priority chips filter by all, urgent, high, normal, or low.
- The assignee menu filters by everyone, assigned to `you`, agent-held, or unassigned. A ticket with a live or stale agent claim counts as agent-held. A ticket assigned to the human does not count as unassigned.
- The story filter is hidden when no stories exist in the current scope. It offers all stories, no story, and each story with color, ref, and live ticket count. A stale selection resets to all.
- Sorting applies within each status column:
  - Manual: descending `order`.
  - Priority: urgent through low, then manual order.
  - Latest: newest `updatedAt`, then manual order.
  - Newest: newest `createdAt`, then manual order.
- Sort mode persists in `localStorage`. Priority, assignee, story, search, selected project, and archive view are session-only.
- Story, assignee, sort, notification, and settings popovers are mutually exclusive. Clicking outside closes them. The settings backdrop also closes settings.
- `New ticket` opens the create dialog.

### Board and ticket cards

- The board has todo, doing, and done columns with live counts.
- Each empty column has its own copy. A board with no tickets at all has a larger onboarding empty state.
- A non-empty board whose active filters match nothing still renders three empty columns. There is no separate `no matches` panel today.
- The done column shows `Archive all` when it contains visible tickets. The action archives all done tickets in the current project scope, including all projects when the current scope is `all`.
- Cards are keyed by ticket id and show:
  - ref and priority;
  - project name while viewing all boards;
  - story rail and story chip;
  - category chip;
  - title and a plain-text, markdown-stripped description preview;
  - up to three lazy-loaded image thumbnails and a remaining-image count;
  - needs-reply, blocked, and reminder chips;
  - human assignee and agent claim chips, including stale-claim treatment;
  - resolved model and effort when routing is enabled, plus legacy complexity context;
  - up to four labels;
  - affected-file and comment counts;
  - relative update time.
- New cards animate once when they first appear. Reduced-motion preferences collapse animations and transitions.
- Clicking a card opens its ticket. Pressing Enter on a focused card does the same. Clicking a card thumbnail opens the lightbox instead.
- Cards can be dragged to another status column. Drop targets highlight. Moving is optimistic and assigns `order = Date.now()`. Dropping into the current status is a no-op. There is no within-column drag reorder.
- Poll-driven board replacement pauses during a drag and while mutations are in flight, so cards do not jump under the pointer.

### Archive view

- Archive scope follows the selected project or all boards.
- Archived tickets sort newest first by `archivedAt`, falling back to `updatedAt`.
- Rows show priority, ref, title, optional project badge, relative archive time, and a restore button.
- Clicking an archived ticket title opens the same ticket dialog. The dialog's archive button becomes `Restore`.
- The view has a distinct empty state and keeps the project rail visible.

### Ticket create and edit dialog

- Create mode uses an explicit `Create` and `Cancel` footer. Edit mode autosaves and hides both buttons.
- Creating from all boards shows a board selector. Creating from one board fixes the target to that board. An empty project list blocks creation.
- Required create fields are title plus either a category or the explicit `Leave unclassified` choice. The server still accepts legacy complexity data from other clients.
- Fields are title, details, priority, status, human assignee, category, story, labels, affected files, images, reminder, links, and comments.
- Existing tickets show created time, relative updated time, and optional `workedBy` model and effort.
- Agent claims are read-only in the dialog and identify live or stale holders. Human assignment remains a separate `Me` or `Unassigned` control.
- Title, details, labels, and affected files autosave on blur in edit mode. An empty edited title reverts to the stored title.
- Priority, status, assignee, category, story, image changes, reminders, links, and comments persist immediately in edit mode.
- Closing an edited dialog blurs the focused control first, so pending title, details, label, or file changes are not dropped.
- A successful autosave briefly shows `saved` in the dialog header, then returns to the relative updated time.
- Delete removes an existing ticket immediately. Archive and restore use the same dialog action.
- The details field is rendered markdown until clicked or activated with Enter or Space. Blur returns it to rendered form and autosaves.
- The escape-first markdown renderer supports fenced code, headings, horizontal rules, block quotes, nested unordered and ordered lists, paragraphs, line breaks, inline code, bold, italic, and links.
- Markdown links allow `http`, `https`, `mailto`, relative URLs, and anchors. Other schemes render as plain text. Source text is escaped before markup is added.

### Stories

- Stories load across all active projects and carry project, ref, title, color, and ticket count.
- A ticket can be assigned to a story or cleared from one in either create or edit mode.
- Story choices are limited to the ticket's board. Changing the board selector while creating resizes the story list.
- `New story` opens an inline title and color picker. Eight colors mirror the store palette. Color is optional because the server can assign one.
- A created story is inserted into client state, selected, and immediately attached to an edited ticket.
- The current UI has no story rename, recolor, description edit, or delete controls, though the server exposes update and delete routes.

### Comments, links, and blockers

- Existing tickets have a chronological comment thread with author, relative timestamp, kind, and rendered markdown.
- The composer posts a regular comment. Dashboard-authored entries use `by: "you"` and source `dashboard` so they do not notify the same user.
- Ticket links support `blocks`, `depends on`, and `related to`. The server stores reciprocal link types.
- Link targets are other tickets from the same project. Linked done tickets get a check mark.
- Links can be removed from the dialog. Open blocking links produce the card's blocked chip.

### Reminders

- Existing tickets can schedule reminders in one hour, three hours, tomorrow at 09:00 local time, or at a custom future date and time.
- Empty, invalid, and past custom times are rejected in the client.
- The active reminder appears in the dialog and on the card and can be cancelled.
- Due reminders enter the persistent notification queue.
- The server has its own 15-second due-reminder sweep, so reminders can fire while no dashboard is polling.

### Attachments and lightbox

- Only image files are accepted.
- While a ticket dialog is open, images can be pasted anywhere or dropped on the drop zone.
- `FileReader` converts images to data URLs. New-ticket images stay in the draft and travel as `imagesData` on create.
- Edit-mode images upload immediately through the ticket patch route. Existing images also delete immediately.
- Images are fetched through the asset route, never by reading filesystem paths in the browser.
- Dialog thumbnails and card thumbnails open a full-screen lightbox. Clicking the lightbox or pressing Escape closes it.
- JSON request bodies currently have a 25 MiB server limit, which includes base64 image overhead.

### Notification queue and desktop notifications

- The bell opens a persistent notification queue.
- The client loads the newest 50 notifications globally and tracks unread totals.
- Notifications cover comments, reminders, and status changes. Each row links to its ticket.
- Users can mark one notification read by opening it or mark all read.
- Opening a notification opens the referenced active ticket. If the ticket is no longer active, the client looks in that project's archive.
- Notification dismissal exists in the API but has no current UI.
- Desktop notifications distinguish comment, reminder, and status events. They include the project when more than one project exists.
- Desktop notifications are suppressed while the dashboard has focus and for any change whose source is `dashboard`.
- A notification click focuses the window and selects the ticket's project. Notification tags deduplicate across multiple dashboard tabs.
- The page generates its favicon and desktop notification icon on a canvas at runtime.

### Settings and routing

- Settings is a modal-sized popover with execution settings on the left and notification settings on the right.
- Desktop notification permission states are unsupported, default, granted, and denied. The current client makes a best-effort permission request at boot and again on the first user click, then allows an explicit click or keyboard activation on the settings row.
- Notification-kind toggles cover comment, reminder, and status. Defaults are enabled.
- Preferences persist both in `localStorage` and on the server. The server wins during startup so background queueing follows the same policy with no tab open.
- Per-project notification toggles are optimistic. A muted project queues no notification kind and shows a muted icon in the rail.
- A selected board has a routing enabled or disabled control. All-boards scope asks the user to open a board first.
- Disabling routing hides global fallback, category settings, category selection, and routing chips for that board. A note explains that direct claims still work.
- Global fallback selects a concrete model and effort. Discovered models join the built-in Claude choices. An unavailable stored model remains visible and labelled unavailable.
- Categories have `Default settings` and selected-board scopes. Board scope is disabled while viewing all boards.
- Category rows show name, id, resolved route, usage count, classifier description, route warnings, and layer state.
- Board scope separates local changes from inherited defaults. It identifies board-only additions, detached or overridden categories, disabled categories, and inherited categories.
- A board override shows changed values and their default values. It can reset to the shared default. Inherited categories can be disabled locally. Disabled categories can be re-enabled. Board-only categories can be deleted.
- Default categories can be edited, enabled or disabled, added, and deleted except for protected `general` deletion behavior.
- Category forms contain id on create, name, classifier description, primary model and effort, optional category fallback, the final global fallback display, executor instructions, and the enabled switch for defaults.
- When the server reports category drafting available, a sentence can be sent for a generated draft. The draft fills the form for review and never saves automatically.
- Category save validates id and name. Saving in board scope creates an independent board copy.

### Keyboard, focus, responsive behavior, and errors

- `N` opens a new ticket when focus is outside an input, textarea, or select and no ticket dialog is open.
- Ctrl+Enter or Command+Enter runs the dialog save path. In edit mode this performs a full patch and closes the dialog even though the visible Save button is hidden.
- Escape closes the project context menu first, then settings, then the lightbox, then the ticket dialog. Other toolbar popovers close on outside click rather than Escape in the current client.
- Cards and the rendered details field are keyboard activatable. Desktop notification permission is keyboard activatable.
- At 820 px and below, the project rail becomes a horizontal strip, its footer and project paths disappear, the toolbar wraps, search grows full width, and board columns stack.
- At 720 px and below, the ticket dialog changes from main-plus-sidebar to one column.
- At 700 px and below, category headings and rows collapse.
- At 880 px and below, settings changes from two columns to one.
- `prefers-reduced-motion` effectively disables animation and transition duration.
- The current document fixes `data-theme="light"`. There is no dark theme control.
- API failures produce action-specific toasts. Refresh failure changes the live status to offline. A later successful refresh returns it to live.
- Optional stories, category data, notification preferences, and older-server compatibility degrade to empty or local defaults instead of blanking the whole board.
- There is no initial loading panel today. The shell renders first and data appears after the initial refresh.

## Current data flow

### Boot

1. Build static controls and event handlers.
2. Generate the icon and initialize browser notification permission state.
3. Load server notification preferences and the routing model catalog independently.
4. Fetch active projects, all active tickets, global notifications, all stories, and categories in parallel.
5. Establish the initial desktop-notification baseline so existing tickets do not notify.
6. Render the rail, board, filters, notification badge, and settings data.
7. Select the only project when exactly one exists.
8. Start the 2.5-second poll.

### Live updates

The dashboard uses HTTP polling. It does not use server-sent events, WebSockets, long polling, or filesystem watchers in the browser.

Every 2.5 seconds the client refreshes projects, all active tickets, notifications, stories, and categories, then checks `/api/health`. Hidden tabs continue polling because desktop notifications still need ticket changes. Returning to a visible tab triggers an immediate refresh.

The client keeps an `id|updatedAt` set to identify changes after the first snapshot. Only background-origin changes produce desktop notifications. It keeps a second signature to avoid rebuilding the board when the visible data did not change. Refresh rendering pauses during drag and mutations.

The health identity is `version|pid|startedAt`. A changed identity means the local server restarted or upgraded. The client shows a short toast and reloads the page once. Health failures during handoff are ignored until the next poll.

### Mutations

All writes use same-origin JSON requests. A mutation counter prevents poll rendering from overwriting optimistic state while a request is in flight. Status moves, notification reads, and project notification toggles update optimistically. Errors restore from the server or force a refresh. Most successful ticket actions force an immediate refresh.

Ticket writes performed through the dashboard are stamped with source `dashboard`. That source is part of the product contract because it stops the user from receiving notifications about their own edits.

### Browser persistence

- `sq_lastseen`: per-project epoch timestamps for rail change badges.
- `sq_notify`: notification-kind toggles, mirrored to the server with the server winning at startup.
- `sq_sort`: active sort mode.

No other view state survives reload.

## HTTP endpoint inventory

All endpoints are same-origin. JSON routes return `{ error }` on failure. Ticket, story, reminder, link, and asset routes use a project slug to disambiguate ids across boards.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/`, `/index.html` | Production application shell. The rewrite serves `dashboard/dist/index.html`. |
| GET | `/api/health` | `{ ok, name, pid, startedAt, version }` for connectivity and server identity. |
| GET | `/api/projects` | Active projects with counts, notification state, routing state, and metadata. |
| GET | `/api/projects/archived` | Archived projects. |
| POST | `/api/projects/:slug/archive` | Archive a board. |
| POST | `/api/projects/:slug/unarchive` | Restore a board. |
| DELETE | `/api/projects/:slug` | Permanently delete the exact board slug. |
| PUT, POST | `/api/projects/:slug/routing` | Set `{ routing: "enabled" | "disabled" }`. |
| PUT, POST | `/api/projects/:slug/notify` | Set `{ on }` for server-side notification queueing. |
| GET | `/api/stories?project=slug|all` | Stories with project identity and ticket counts. |
| POST | `/api/stories` | Create from project, title, optional description and color. |
| PATCH, PUT | `/api/stories/:id?project=slug` | Update a story. |
| DELETE | `/api/stories/:id?project=slug` | Delete a story. |
| GET | `/api/categories?project=slug|all` | Resolved categories, layer data, usage counts, and warnings. |
| POST | `/api/categories/draft` | Draft category fields from `{ sentence, project? }`; can return 503 when unavailable. |
| POST | `/api/categories` | Create a shared or board-local category. |
| POST | `/api/categories/:id/detach` | Detach a category for `{ project }`. Exposed even though the current page does not call it directly. |
| POST | `/api/categories/:id/relink` | Remove an override or detach for `{ project }`. Exposed even though the current page uses scoped delete for reset. |
| PATCH, PUT | `/api/categories/:id?project=slug` | Update a shared category, fork a board copy, or set `{ disable: true }`. |
| DELETE | `/api/categories/:id?project=slug` | Delete shared category, remove local category, reset local override, or re-enable local disable according to scope. |
| GET | `/api/routing-fallback` | Global fallback and model catalog. |
| PUT, POST | `/api/routing-fallback` | Set a global fallback from `{ fallback }` or the route object itself. |
| GET | `/api/routing-models?project=slug` | Models, efforts, discovered routes, categories, fallback, and category-draft availability. |
| GET | `/api/tickets?project=slug|all&archived=1` | Active tickets by default or archived tickets when requested, with pending reminders attached. |
| POST | `/api/tickets` | Create a ticket, including base64 images and routing classification fields. |
| PATCH, PUT | `/api/tickets/:id?project=slug` | Update ticket fields, add `imagesData`, or remove assets. Server forces source `dashboard`. |
| DELETE | `/api/tickets/:id?project=slug` | Delete a ticket. |
| POST | `/api/tickets/:id/comment?project=slug` | Add `{ by, body, kind }`, forced to dashboard source. |
| POST | `/api/tickets/:id/reminder?project=slug` | Set `{ fireAt }`. |
| DELETE | `/api/tickets/:id/reminder?project=slug` | Cancel a pending reminder. |
| POST | `/api/tickets/:id/link?project=slug` | Link with `{ verb, to }`. |
| DELETE | `/api/tickets/:id/link/:other?project=slug` | Remove the reciprocal link. |
| POST | `/api/tickets/:id/archive?project=slug` | Archive a ticket. |
| POST | `/api/tickets/:id/unarchive?project=slug` | Restore a ticket. |
| POST | `/api/archive-done?project=slug|all` | Archive every done ticket in scope. |
| GET | `/api/notifications?project=&unread=&kind=&includePending=&limit=` | List notifications plus unread totals. |
| POST | `/api/notifications/read` | Mark `{ id }` or `{ all: true }` read. |
| DELETE | `/api/notifications/:id` | Dismiss a notification. No current UI. |
| GET | `/api/notify-prefs` | Server-side event-kind preferences. |
| PUT, POST | `/api/notify-prefs` | Replace server-side event-kind preferences. |
| GET | `/api/asset/:slug/:id/:filename` | Read a ticket asset with a content type and no-store caching. |

Unknown routes return JSON 404. API matching must happen before static asset handling in the rewritten server.

## Architecture

### Plain Vite SPA over SvelteKit static

Use plain Vite with `@sveltejs/vite-plugin-svelte`.

The dashboard has one URL, one client mount, no server-rendered content, no route-level data loading, and an existing local API server. Standalone Vite produces the exact artifact needed here: an HTML entry plus hashed JavaScript and CSS under `dist/`. The server can serve those files without a Svelte runtime or adapter.

SvelteKit with `adapter-static` would add filesystem routing, adapter configuration, generated framework output, and SPA fallback behavior. None of those solve a current dashboard requirement. It would also create two server models in the source tree even though Sidequest's local Node server remains the runtime authority. Reconsider SvelteKit only if the dashboard gains real browser routes, route-level loading, or independently deployable pages.

### Files and build ownership

```text
plugins/sidequest/dashboard/
  package.json
  package-lock.json
  tsconfig.json
  vite.config.ts
  playwright.config.ts
  index.html
  src/
    main.ts
    App.svelte
    styles/
      reset.css
      theme.css
      app.css
    lib/
      api.ts
      markdown.ts
      persistence.ts
      time.ts
      types.ts
      state/
        board.svelte.ts
        polling.ts
        context.ts
      components/
        shell/
        board/
        ticket/
        notifications/
        settings/
        common/
  e2e/
    fixtures/
    dashboard.spec.ts
  test/
    markdown.test.ts
    board-state.test.ts
  dist/
    index.html
    assets/
      <content-hashed files>
```

`src/`, configuration, tests, and `index.html` are authored files. `dist/` is generated and committed. Reviewers should never hand-edit `dist/`.

Keep the frontend package private and isolated in this directory. Use a committed lockfile and dev dependencies only. The production server must not import anything from `node_modules` in this package.

The build uses `base: '/'`. API and production assets share the local server origin. Vite's dev server proxies `/api` to a configurable isolated Sidequest server.

### Component tree

```text
App
├─ ProjectRail
│  ├─ ProjectRow
│  ├─ ArchivedProjects
│  └─ ProjectContextMenu
├─ MainWorkspace
│  ├─ Toolbar
│  │  ├─ SearchInput
│  │  ├─ PriorityFilters
│  │  ├─ StoryFilter
│  │  ├─ AssigneeFilter
│  │  ├─ SortMenu
│  │  ├─ NotificationInbox
│  │  └─ SettingsDialog
│  │     ├─ BoardRoutingControl
│  │     ├─ GlobalFallbackControl
│  │     ├─ CategorySettings
│  │     │  ├─ CategoryRow
│  │     │  └─ CategoryForm
│  │     └─ NotificationSettings
│  ├─ BoardView
│  │  └─ BoardColumn
│  │     └─ TicketCard
│  └─ ArchiveView
├─ TicketDialog
│  ├─ RichText
│  ├─ TicketMetadata
│  ├─ StoryPicker
│  ├─ AttachmentPicker
│  ├─ CommentThread
│  ├─ LinkEditor
│  └─ ReminderEditor
├─ Lightbox
└─ ToastRegion
```

These are responsibility boundaries, not a requirement to split every small markup fragment. A component should own a coherent interaction or repeatable visual unit. Keep API calls and cross-panel state transitions in the state class. Keep field focus, open state, and draft values in the nearest component when no sibling needs them.

Pass typed data and callbacks through `$props`. Use keyed `{#each}` blocks for projects, tickets, stories, notifications, comments, categories, and attachments. Use normal DOM event attributes such as `onclick`, not legacy `on:click` syntax.

### State model

Create one `BoardState` instance in `App.svelte` and expose it with typed `createContext`. This gives components one domain API without a module singleton leaking between tests.

Use `$state.raw` for server snapshots because polling replaces them wholesale:

- active and archived projects;
- active tickets across every project;
- archived tickets for the current archive scope;
- stories;
- categories;
- notifications;
- routing catalog and server notification preferences.

Use `$state` for interaction state:

- current project and board/archive view;
- priority, assignee, story, search, and sort filters;
- editor and attachment draft;
- open popover or dialog;
- drag state;
- mutation count;
- live/offline state;
- health baseline and reload guard;
- first-snapshot desktop notification baseline;
- toast queue.

Use reactive `SvelteSet` or reassigned plain sets for seen ticket ids and notification event keys. Cap the notification key set at the current 4,000-entry behavior.

Compute these with `$derived` or `$derived.by`:

- current project metadata and routing availability;
- tickets and stories in the current scope;
- visible tickets after every filter;
- todo, doing, and done groups with their selected sort;
- project and archive totals;
- story options and ticket counts;
- unread notification totals;
- active category scope, groups, and route labels;
- card blocker, claim, story, and route presentation.

Do not mirror derived arrays into writable state. Do not use `$effect` to recalculate filters, columns, counts, or form values.

Methods on `BoardState` own domain transitions: select project, open archive, create or patch ticket, move ticket, mark notifications read, schedule reminder, mutate categories, and apply a poll snapshot. Components call these methods from event handlers.

### Polling controller

Keep polling in a plain controller owned by `BoardState` or `polling.ts`.

- `App.svelte` starts it in `onMount` and returns its cleanup function.
- Only one refresh may be in flight. A request made during a refresh sets one queued refresh flag instead of starting an overlapping request.
- The initial and periodic refresh fetch active projects, all active tickets, notifications, stories, and the active category scope in parallel.
- Preferences and the routing catalog load independently at boot and reload after relevant writes.
- Archive view performs its archived-ticket request in addition to the common snapshot.
- A successful snapshot applies atomically so projects, tickets, stories, categories, and notification totals agree for one render.
- While dragging or mutating, keep the newest fetched visual snapshot in a pending slot. Apply it as soon as the interaction lock clears. Notification event detection can still inspect the fetched ticket list so a background event is not lost.
- Every successful ticket mutation requests a coalesced immediate refresh.
- Continue the 2.5-second timer while hidden and refresh immediately on `visibilitychange` when the document becomes visible.
- Check health on each timer tick. Reload once when `version|pid|startedAt` changes.
- The first ticket snapshot establishes a baseline and never emits desktop notifications.
- Optional resource failure keeps the last good optional snapshot. Mandatory project or ticket failure marks the connection offline and leaves the last good board on screen.

Use `<svelte:document>` for visibility and paste events and `<svelte:window>` for global key handling where practical. Event handlers should call named state methods. Avoid an effect that installs document listeners.

Keep polling for the first release. An SSE migration needs a new server endpoint, heartbeat and reconnect policy, an initial full snapshot, ordered revision ids, replay or forced resync after gaps, and tests for server handoff. Adding only an `EventSource` would lose the current consistency and upgrade behavior.

### API and mutations

`api.ts` defines typed request and response shapes for every endpoint in the inventory. Its base URL is same-origin in production. It should:

- parse JSON success and `{ error }` failures;
- throw an `ApiError` with HTTP status and server message;
- encode every path segment and query value;
- omit a request body for bodyless methods;
- preserve the server's 25 MiB limit in attachment validation copy;
- never retry writes automatically.

Mutation methods increment and decrement one counter with `try/finally`. Each optimistic mutation captures enough prior state to roll back, or forces a refresh on error. Server-returned tickets replace optimistic tickets because they include derived routing, warnings, reminder data, timestamps, and normalized links.

Keep the source contract server-side. The client must not be allowed to spoof a background source through a ticket patch.

Move the escape-first markdown parser and URL sanitizer into `markdown.ts`. Cover it with unit tests for every supported block and inline form, malformed markdown, entity handling, and rejected `javascript:` or `data:` links. Render only the parser's trusted output through `{@html}`.

### Static production serving

The rewritten server resolves the dashboard directory once and serves files only from `dashboard/dist`.

- `/` and `/index.html` return `dist/index.html` with `Cache-Control: no-store`.
- `/assets/<hashed-name>` returns the matching contained file with the correct MIME type. Content-hashed assets may use `public, max-age=31536000, immutable`.
- Static path resolution must reject traversal and encoded traversal before reading a file.
- `/api/*` is matched before static handling and always returns JSON, including 404s.
- There is no history fallback for arbitrary paths because the application has one route.
- A missing `dist/index.html` returns the current reinstall guidance. The server never shells out to npm or Vite.

A build check must fail when authored frontend files change without a matching committed `dist` update.

### Theming and CSS

Put the current palette, type stacks, radii, focus ring, and motion policy in `styles/theme.css` as semantic custom properties. Preserve the fixed light theme in the parity release with `data-theme="light"` on the document element.

Use scoped component styles for component layout and states. Keep only reset, root sizing, shared typography primitives, toast/lightbox layers, and responsive shell rules global. Use custom properties for values shared across component boundaries.

Do not add external fonts, remote assets, or a CSS framework. Preserve the current system sans, serif, and monospace stacks. Preserve the 820, 720, 700, and 880 px behavior unless a component-level container query can reproduce it exactly.

A dark theme can be added later as a complete `[data-theme="dark"]` token set with contrast and Playwright coverage. The parity implementation should not infer a theme from `prefers-color-scheme` because the current dashboard is explicitly light.

## Development workflow

From `plugins/sidequest/dashboard/`:

1. Run `npm ci`.
2. Start an isolated Sidequest server with a temporary `SIDEQUEST_HOME` and a non-shared port.
3. Set the dev API target for that port and run `npm run dev`.
4. Vite serves the Svelte source with hot module replacement and proxies `/api` to the isolated server. Asset requests also use the proxy when they begin with `/api/asset/`.
5. Run `npm run check` for `svelte-check` and TypeScript.
6. Run unit tests.
7. Run `npm run build`.
8. Run Playwright against the built app served by the rewritten server.
9. Confirm the committed `dist/` exactly matches a clean build.

Recommended scripts:

```json
{
  "dev": "vite --host 127.0.0.1",
  "check": "svelte-check --tsconfig ./tsconfig.json",
  "test": "vitest run",
  "build": "vite build",
  "test:e2e": "playwright test",
  "verify": "npm run check && npm test && npm run build && npm run test:e2e"
}
```

The implementation wave must use the installed `svelte-core-bestpractices` skill while editing Svelte code and run the Svelte MCP autofixer on every changed `.svelte`, `.svelte.ts`, or `.svelte.js` file before submitting. Autofixer findings must be fixed or recorded with a concrete reason.

## Playwright verification

Run Chromium through `@playwright/test` against production assets, not Vite's development page. A test worker should:

1. Create a temporary Sidequest home.
2. Seed synthetic projects, stories, categories, tickets, claims, links, comments, reminders, assets, archived records, and notifications through store or CLI APIs.
3. Spawn the real rewritten server in a child process with the temporary home set before modules load and port `0` or another isolated port.
4. Wait for `/api/health`.
5. Navigate to the server URL.
6. Stop the child process and remove the temporary data during teardown.

Never stop, restart, seed, or screenshot the shared dashboard server. Test data and screenshots must contain only synthetic names and ids.

Minimum browser scenarios:

- boot, single-project auto-selection, all-boards aggregation, and offline/live recovery;
- project selection, unseen badges, active and archived project actions;
- search plus priority, assignee, story, and all four sort modes;
- three columns, filtered-empty columns, card metadata, thumbnail lightbox, and cross-column drag;
- create-ticket validation, board choice, category or unclassified choice, story choice, labels, files, and pending images;
- edit autosave on blur, immediate segment/category/story saves, close-time blur commit, Ctrl/Command+Enter, delete, archive, and restore;
- markdown rendering and unsafe-link rejection;
- comment, links, blockers, reminder presets, custom reminder validation, and cancel;
- paste and drag/drop images, immediate edit upload/removal, and asset display;
- notification queue, unread counts, opening active and archived targets, mark one read, and mark all read;
- desktop permission states, background-only toast behavior, event-kind preferences, and project mute;
- routing enable/disable, global fallback, category default and board scopes, add/edit/draft/fallback, disable/re-enable, reset, warnings, and unavailable model display;
- archive-all behavior in a single project and all boards;
- keyboard activation, outside-click closing, Escape precedence, and focus return expectations;
- responsive layouts at widths spanning 880, 820, 720, and 700 px;
- reduced-motion behavior;
- health identity change causing exactly one reload.

Prefer response waits, visible state, and server-observed mutations over fixed sleeps. Intercept requests only for failures, delayed responses, and health identity changes. Keep the main parity flows on the real local API.

Add focused Vitest coverage for pure filters and sorts, state snapshot buffering, optimistic rollback, persistence parsing, markdown safety, relative-time boundaries, and notification bucketing. Playwright remains the acceptance gate because the main regression risk is interaction across panels.

## Rewrite acceptance checklist

The implementation is ready to replace the single-file dashboard when all of these are true:

- Every feature in the inventory has a passing test or a linked follow-up approved before ship.
- Every endpoint in the HTTP inventory remains available with the same method, query, body, status, and response behavior unless a coordinated server contract change says otherwise.
- Polling remains single-origin, 2.5 seconds, hidden-tab capable, visibility-aware, interaction-safe, and health-identity-aware.
- Dashboard-authored changes still suppress self-notifications.
- Local persistence keys and startup precedence remain compatible.
- Markdown stays escape-first and unsafe schemes cannot become anchors.
- Attachment paths and static asset paths reject traversal.
- The light theme, breakpoints, reduced motion, keyboard behavior, and empty/error states match the parity list.
- `npm run verify` passes from a clean frontend install.
- A clean build produces no diff from committed `dashboard/dist/`.
- Svelte MCP autofixer has been run on every changed Svelte component or module.
- Playwright uses only an isolated synthetic board and the committed production build.
- Starting the plugin dashboard on a machine without frontend dependencies serves the committed app successfully.
