# Repository scripts

The scripts here support repository maintenance and release work. The release engine lives in
`scripts/release/`; its README is the source for fragment, planning, cut, and guard commands.

Release publication uses the protected prepare/promote/finalize flow:

```text
node scripts/release/cut.mjs --prepare --dry-run
node scripts/release/cut.mjs --prepare --push
# Open and merge the printed promotion PR after its required checks pass.
node scripts/release/finalize.mjs --push
# Open and merge the printed main-to-develop sync PR.
```

Both push commands acquire the Sidequest publish lock and release it after success or failure. A held lock stops publication before anything changes. See [the release engine README](release/README.md) for checks, recovery, and lock ownership.

The release tests run with Node 22 and use throwaway local repositories for git behavior:

```bash
node --test scripts/release/test/*.test.mjs
```

## Support

Optional donations through [Ko-fi](https://ko-fi.com/eigenwise) or [GitHub Sponsors](https://github.com/sponsors/Eigenwise) support maintenance of these repository scripts. Donations are never required to use the files in this directory.
