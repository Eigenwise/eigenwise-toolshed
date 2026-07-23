# High-stakes tickets

Set `highStakes: true` (CLI: `--high-stakes`) when the approach is clear but a mistake can damage shared state or consumers: migrations, shared API or payload changes, and cross-consumer edits.

High stakes does not change the category, model, or effort. It raises the verification bar:

1. Enumerate every consumer of each changed surface and check each one.
2. Run every affected consumer suite. A board payload change includes the dashboard build and tests.
3. Before integration, run a review-audit pass. Record it with a ticket comment beginning `reviewed-by: <reviewer>`.

Integration stays advisory for now. `groomClose` with `integration: true` warns when a high-stakes ticket has no recorded review pass. Clear but dangerous work gets the normal route plus verification and review, not a higher model tier.
