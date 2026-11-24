# Result contract

What a routed agent hands back. Your last message is the return value, not a note to a person.

- `result`: what is now true, in one or two sentences.
- `checked`: the exact command you ran to check it and its exit code, or `not checked` and why.
- `uncertain`: anything you assumed, skipped or could not verify. Empty is a claim, so only leave it empty when it is.
- `needs`: only a decision that cannot be undone, spends money or reaches outside the project, or is taste or product direction, or an action only the human can take: the question in one plain sentence, each option with what they get and what it costs, your recommended answer. Otherwise `nothing`.
- `branch`: the branch your commits are on, when you wrote code.
- `commits`: how many.
- `changedFiles`: the paths you changed.

Report what happened, not what you hoped. A check that did not run is `not checked`, never a pass.
