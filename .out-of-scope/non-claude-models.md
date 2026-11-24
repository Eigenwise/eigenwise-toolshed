# Models from other providers: not yet, planned

2026-11-18

**Asked:** tiers that run on a model from another provider, with a plugin that discovers a provider's models and writes them where routing reads them.

**Evidence:** three spikes on 2026-11-18. In process there is no way: a model id from another provider set on a spawn is sent to the session's own endpoint and the agent dies on a 404 with no reply. Out of process there is one, shown against a local stub only: a separate `claude -p` started with its own base URL. No real provider endpoint was ever tried. The plugin that wrote provider files could be installed and connected, and its routing could not work.

**Decision (2026-11-18):** Not now, since it complicates things, and the architecture has to keep the way in open. Not built and not offered. The plugin (`plugins/model-gateway`) was removed before the first public commit, and setup and outfit say nothing about providers. The way in stays open and tested: Sidequest's routing still reads a provider file, a tier may name a model one lists, and a tier whose model nobody provides falls back with a named reason. `ARCHITECTURE.md` says how a provider would plug in.

**Changed on 2026-11-19:** routing to other providers is planned to come back, replacing not-for-now.

**2026-11-25:** v2 went public without it. It is still not built and not offered, and waits for its turn.

**What must stay open until then:**

- Routing keeps reading a provider file.
- Nothing may assume every routed agent is an in-process subagent on a Claude model. An agent in its own process with its own base URL has no host lifecycle events, so anything that asks "is this run alive" or "when did it last move" has to give an honest answer for it too.
- Remote Control is part of the feature. The system has to know whether it can work in the current setup and say so in plain words, say why not when the main session talks to an endpoint that is not the first-party one, and offer the switch as one action per project. It never trades Remote Control away silently. A hosts-file trick is not a way to switch.

**First step when its turn comes:** measure on the real host under which setups Remote Control is offered, what exactly disables it, and whether a mod can read that state.
