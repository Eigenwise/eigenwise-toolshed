---
name: report
description: Draft a sanitized upstream issue when friction traces to a shipped plugin. The human sends it.
argument-hint: "<plugin name or proposal id>"
disable-model-invocation: true
---

# Report

Draft one upstream issue for friction that a shipped plugin caused, show it, and let the human send it. Never post on your own.

## 1. Pin down the plugin and version

From the argument (a plugin name, or an `upstream` proposal id read with `mcp__quartermaster__proposal`, `operation: list` and its `id`), find the plugin. Get its exact version and marketplace from `claude plugin list --json`, and the Claude Code version from `claude --version`. Find the repository from the plugin's `.claude-plugin/plugin.json` (`repository` or `homepage`) or its marketplace entry. If no repository is named, say so and stop.

## 2. Make sure it is theirs

Reproduce it or find it in evidence: the refusal text, the error, the hook that timed out. Check it is not caused by local config (a setting, a local rule, another plugin). If it is local, say so. That is a normal proposal, not an upstream issue.

## 3. Search before drafting

```sh
gh issue list --repo <owner/repo> --state all --search "<two or three generic words from the error>" --limit 20
```

Search with generic words from the error text only. If an existing issue matches, show it and offer a comment with the new version and repro on that issue instead of a new one.

## 4. Draft

```markdown
**Version:** <plugin>@<version> (<marketplace>), Claude Code <version>, <OS>

**What happened**
<one or two lines>

**Repro**
1. ...
2. ...

**Refusal or error text**
<exact text, sanitized>

**Expected**
<one line>

**Workaround**
<what works today, or "none found">
```

Sanitize everything before showing it. Replace usernames, home directories, project and company names, repository names, emails, hostnames, tokens and keys with placeholders such as `<home>`, `<project>`, `<token>`. Keep the error wording itself. Never include prompt text, transcript excerpts or file contents beyond the few lines the repro needs.

## 5. Hand it over

Show the title and body. Ask the human to read it for anything private. The human sends it. If they ask you to file it, run `gh issue create --repo <owner/repo> --title "<title>" --body-file <file>` with exactly the text they saw, then give them the link. If this came from an `upstream` proposal, add the issue link to its body with `operation: update`.
