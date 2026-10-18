Use intent-revealing names with no abbreviations. Comments explain only why the code cannot. Use concrete types, never Any, casts, or bare ignores.
Before adding code, ask whether it needs to exist; reuse what's here, then the standard library or native platform, then an installed dependency. Prefer one clear line, otherwise the minimum code that works.
Write coverage that keeps CRAP below 6 for new and raised bodies, legacy bodies only may not get worse. Split when a body reaches complexity 6.
A shortcut with a known limit gets `shortcut: <limit>, <when to upgrade>` in source.
