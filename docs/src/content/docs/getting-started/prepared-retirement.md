---
title: Retire a prepared dispatch
description: Cancel your own never-claimed attempt without reporting a failure.
---

The session that prepared a dispatch can retire it before anyone claims it. Prepared, launched, bound, and briefed attempts all qualify. Give a reason of at least 20 characters:

```sh
sidequest release SQ-123 --retire-prepared --reason "The task changed before this attempt claimed."
```

The MCP equivalent is `dispatch { ref: "SQ-123", retireOnly: true, reason: "The task changed before this attempt claimed." }`. Omit `retireOnly` to retire and prepare a replacement in one dispatch call. Sidequest records `retired_by_preparer`, the reason, and the attempt history. `recoveryEvidence` remains accepted. Foreign sessions still need observed failure evidence and the existing retirement deadline. Once a claim exists, use the claim recovery flow.
