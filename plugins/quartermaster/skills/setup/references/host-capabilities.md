# Recommending host capabilities

A capability gap starts with the coding-agent host actually in use. Use direct evidence from the
current session, its configuration, or the user's statement. Do not infer Claude Code from
Quartermaster being present, and do not treat a local Claude plugin catalog as another host's
inventory.

For the capability the user's work needs, report these separately:

1. **Native capability**: the host documents it and it is available without an extension.
2. **Installed extension**: an extension or package is configured or present on disk. This does not
   prove that the current session loaded it.
3. **Live usability**: the agent can currently invoke the needed tool or workflow successfully.

A working native capability or live tool closes the gap. Do not recommend another extension just
because one exists. An installed but unloaded extension calls for its host's activation boundary and
a live-usability check, not a second installation.

When the capability is actually absent, research the identified host's official extensions,
examples, and suitable maintained third-party packages. Keep the search bounded and use generic
capability terms only. State what source was checked. An official example is source material that
may need local wiring or adaptation; do not present it as an installable package. A maintained
package can be proposed only after its source and applicability were checked. Show an install command
only when the checked source gives a command that applies to this host. Never invent one.

If the host, its extension state, or usable-tool evidence is unavailable, say that the conclusion is
uncertain. Do not run or suggest Claude-specific commands as evidence about another host. Every
installation or configuration change still needs its own explicit approval. After approval, stop at
the host's reload or restart boundary, then verify the capability is live before calling it ready.

## Checked Pi example

The Pi coding-agent repository's [Subagent Example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent)
starts separate Pi processes for delegated tasks and documents linking an extension, agent definitions,
and workflow prompts into Pi configuration directories. Treat that checked example as a pattern that
needs local fit and activation, not as a maintained package with a universal install command. The
source's documented parallel mode also has an eight-task maximum with four concurrent tasks.
