# Running a wave

With five or more frontier tickets and workflows available, run the saved wave workflow and say so in one line. It runs each ticket and then a review of it as a pipeline. Call `start` for each ticket with `forWave: true`. The answer prints no brief and no Agent call. It gives the ticket's entry as one line of JSON, with the file that holds its brief, and the review route as another. Paste the entries as they are, never type or change them. An entry with `worktree` false is a ticket on a board whose folder has no git: its brief tells the worker to make its own worktree, so the entry asks for no isolation and you add none:

```
Workflow({ name: "sidequest:wave", args: {
  tickets: [<the entry line of each ticket>],
  reviewRoute: <the reviewRoute line>
} })
```
