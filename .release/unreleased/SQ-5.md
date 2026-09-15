---
ref: SQ-5
title: Manual delivery records a rebased or squash-merged candidate through deliveryRevision
bump: patch
plugins: [sidequest]
commit: 6c9b8ad5f9f29a7e3a52289ac5681225c2183aa6
---

A non-reachable pinned delivery can name the landed revision with deliveryRevision. Every submitted path is proven at that revision's tree instead of the integration working tree — identical content, a candidate deletion the revision also carries, or the candidate's own change reverse-applying onto it — so a candidate that was rebased, squash-merged, or conflict-resolved before landing can be recorded. Anything left over refuses delivery_content_diverged until resolvedPaths attests exactly those paths, and the record keeps the per-path proof. Without deliveryRevision the working-tree comparison is unchanged.
