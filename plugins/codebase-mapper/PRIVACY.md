# Codebase Mapper privacy statement

Last updated: 3 October 2026. This statement covers Codebase Mapper, not every plugin in Eigenwise Toolshed.

## What it processes

Codebase Mapper helps your coding assistant understand and maintain a map of your project. Its skills instruct the assistant to read relevant project files, inspect the repository and its changes, and write map documents. Project files and generated maps can contain personal information if that information is present in your project.

The bundled hooks read local map documents and map state, together with hook metadata supplied by the host, such as the project directory, session identifier, event type, tool name, and whether the assistant announced or invoked a map update. They use this information to load the map, report changed documents, and coordinate map maintenance. A stop-hook coordination record stores a hash derived from the assistant's message and stop reason, rather than the full message.

## Local files and commands

- Project maps and state live under `.claude/.codebase-info/`. State records document paths, content hashes, the plugin version, mapping date, and the current Git commit when available. Migration can preserve an older state file as a local backup.
- Local session and coordination files normally live under `~/.claude/codebase-mapper-state/`. `CODEBASE_MAPPER_STATE_DIR` can change this location. These files include map document paths and hashes, timestamps, session-derived identifiers, update markers, and lock metadata such as process identifiers.
- Hooks use the project location supplied by `CLAUDE_PROJECT_DIR`, hook input, or the working directory. Test-only environment variables support local locking tests; they are not authentication credentials.
- The bundled map-state script runs `git rev-parse HEAD` locally. The mapping skills can inspect Git changes and create local commits of generated maps and state. They can adjust `.gitignore` to make the map trackable. An explicit no-commit instruction leaves changes uncommitted. The skills do not instruct the assistant to push the map to a remote repository.

## Where information goes

Codebase Mapper's bundled hooks and scripts do not make network requests or send project information to an Eigenwise-operated service. The plugin declares no MCP server and requires no Eigenwise account or API key.

The hooks provide map content and instructions to your coding assistant. The assistant also reads project content while following the skills. That information can therefore be processed by the model provider and other services configured in your assistant. Their own terms, privacy settings, retention practices, and your host's permissions apply. This plugin does not make the assistant's model processing local or override those settings.

If you use the optional Sidequest handoff, dispatched work follows Sidequest's configuration and the selected executor/model provider. Sidequest is a separate plugin and is not required to use Codebase Mapper.

Maps that you commit may be shared when you or another tool pushes the repository, syncs files, or creates backups. Review generated documents before sharing them. The skills instruct the assistant to describe configuration without copying secret values, but generated output still needs review.

## Retention and removal

Map documents, map state, migration backups, and Git history remain under your control until you remove them. The session ledger attempts to remove stale files from project ledger directories after seven days when ledger cleanup runs. This is best-effort cleanup, not a guaranteed deletion schedule for all coordination files. Other markers and locking state are removed as their coordination flows complete, and leftovers can remain after interruption.

Disable or uninstall the plugin before manually removing its local state. Removing files from the working tree does not remove earlier Git commits, remote copies, backups, or data retained by your model provider.

## Contact

Questions about this plugin: **kenny@eigenwise.io**. If you send a support message or open a GitHub issue, the contents you choose to send are shared through that email or GitHub service. Do not include private code, credentials, or unnecessary personal information in public issues.
