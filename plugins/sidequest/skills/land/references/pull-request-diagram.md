# A diagram of the change in the pull request

Optional, and the person's call. Nothing is uploaded or hosted: the diagram is a fenced `mermaid` block in the pull request text, which the code host draws if it can.

## Asking once

`pullRequestDiagram` in `.sidequest/board.json` settings holds the answer. Absent means nobody asked yet.

- The first time you prepare a pull request in this project and the story has a path worth drawing, offer it in one line, beside the rest of the pull request text.
- When you know this project's code host draws Mermaid blocks from text (the remote's address tells you which host it is), name that host in the offer by its own name and say nothing is uploaded: `add a diagram of the change to pull requests here? <host> draws it from text in the description, nothing is uploaded`.
- When you cannot tell, say what it needs instead: `add a diagram of the change to pull requests here? The code host has to be able to draw Mermaid blocks`.
- Write their answer into the setting, `true` or `false`, and never ask again. They can change it by saying so.
- No yes, no diagram.

## Adding it

Only with the setting `true`, and only when the change has a path worth drawing: a one-line fix gets none.

- Take the block from the board tool's `diagram` view of the story, as it is. Never type a diagram yourself.
- Mark the stops the change touches with `changed` on the story's path first, so the diagram shows them.
- It is part of the words that go out: show it with the rest of the pull request text before sending, drop it if they say so, and let the pass on outgoing words check it against the diff like any claim.
- Nothing in it names the board, a ticket or a story id.
