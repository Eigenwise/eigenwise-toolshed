## Summary

<!-- What changed and why. -->

## Checklist

- [ ] This PR targets `develop`, not `main`.
- [ ] A release fragment exists at `.release/unreleased/<REF>.md` (see
      [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`.release/README.md`](../.release/README.md)),
      or I have no board ref and am asking a maintainer to add one.
- [ ] Agent-facing surfaces (MCP tool schemas/descriptions, refusal and guidance strings,
      agent/skill definitions, CLI help, live rules) are updated in this PR if this change
      affects what an agent is told.
- [ ] Verify command run and result:

  ```text
  <command and outcome, e.g. cd plugins/sidequest && npm ci && npm run test:full -> passed>
  ```

## Negative control

<!-- What fails without this change: a reverted assertion, an error, a repro that no longer reproduces. -->
