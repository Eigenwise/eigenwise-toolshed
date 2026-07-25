---
description: Automated release policy
prompt: ["ship", "publish", "release", "bump", "hotfix", "marketplace"]
---
- Integrate release work on `dev`.
- Daily publication runs automatically after exact-SHA CI is green.
- Use `workflow_dispatch` for an early or hotfix publication.
- Pause automation with `RELEASE_AUTOMATION` or `.release/HOLD`.
- Never tag or push `main` by hand.
