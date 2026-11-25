# Running outside code after a pass

Read this only when the `outside-code-reviewer` came back with `pass`. On `hold` nothing of it runs: the review says which part and why, and the ticket waits for the person with the reviewer's question.

A pass means the code may run in a throwaway container with no network, no credentials and a copy of the code, removed afterwards. Never on the host, never in the person's checkout, never with their environment. The same goes for every later check of that code: a review's, a worker's, and land's verify of a branch that carries it.

A change by the person, or by a colleague with earlier commits in the repository, goes to the reviewer only for the part that touches dependencies, a lockfile, build, install or test-runner machinery, CI, or a file a tool runs by itself. That part is its own `outside-code` ticket, or one reviewer call with no ticket; the change's own ticket keeps its category and its normal review. When the part passed, the change goes on as usual, its install included.

## Steps

These ran on Docker 29.6.2 from Git Bash on Windows on 2026-11-19, on a made-up scratch repository: about 1.7 s without the dependency step and 4.3 s with it. Run them in a POSIX shell and read every real exit code. When each command runs in a fresh shell, write the container id from step 5 where `$id` stands.

1. **Is there a runtime?** `docker version --format '{{.Server.Version}}'`. When it fails, say `not run: no container runtime here` with its error, record that on the ticket, and run nothing on the host.
2. **Git Bash only:** put `MSYS_NO_PATHCONV=1` before every `docker` command (or export it once in a shell that lives on), or it rewrites `/work` into a Windows path.
3. **A ref for the code.** For a pull request, `git fetch origin "pull/<number>/head:refs/outside-code/<ticket>"` (GitHub's name for it; other trackers name it their own way). For land's verify, the landing branch is the ref. For a pasted or fetched script, write it into a new folder under the system temp folder, outside the project.
4. **An image already here.** Pick one with the toolchain the check needs from `docker image ls`, and always pass `--pull never`. When none has it, say `not run: no local image with <toolchain>` and name the image; pulling it is the person's call.
5. **Create the container.** With no dependencies to install:

   ```
   id=$(docker create --pull never --network none --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --pids-limit 256 --memory 2g --cpus 2 -v /work -w /work <image> sh -c '<check>')
   ```

   When the check needs installed dependencies, nothing can be fetched without a network, so they come first, from the base branch's own manifest and lockfile, before any outside code is in the container:

   ```
   id=$(docker create --pull never --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp --pids-limit 256 --memory 2g --cpus 2 -e HOME=/tmp -v /work -w /work <image> sleep 3600)
   docker start "$id"
   git archive <base branch> <manifest> <lockfile> | docker cp - "$id:/work"
   docker exec "$id" <install command>
   docker network disconnect bridge "$id"
   ```

6. **Copy the code in.** `git archive refs/outside-code/<ticket> | docker cp - "$id:/work"` copies only tracked files: no `.git`, no `.env`, nothing untracked from the person's checkout. A script folder: `tar -c -C <folder> . | docker cp - "$id:/work"`.
7. **Run the check.** `docker start -a "$id"`, or after the dependency step `docker exec "$id" sh -c '<check>'`. Both hand back the check's own exit code.
8. **Clean up**, every time, also after a failure: `docker rm -f -v "$id"`, `git update-ref -d refs/outside-code/<ticket>`, and remove the temp folder. Confirm with `docker ps -aq --filter "id=$id"` (no line) and `git for-each-ref refs/outside-code` (no line). Name anything you could not remove.

Remove only containers you created, by their own id: the others on the machine are the person's.

Record on the ticket the image, the check, its exit code and what was cleaned up. A missing image, a missing runtime or a check that needs the network is `not run` with why, never a pass.

Not tried yet: a real project's toolchain, a native module built on the host (it will not load in a Linux container; install inside instead), and a tracker other than GitHub.
