---
name: git-commit-message
description: Use when the user asks to write, review, or improve a git commit message, or before creating a commit so the message names the real change instead of a generic summary.
---

# Git Commit Message

Write the message from the diff, not from the request. Inspect `git diff --cached`
(or `git diff` for an unstaged change) and `git status` before drafting. If the
diff is unavailable, say what is missing instead of guessing.

## Shape

```
<type>(<scope>): <imperative summary>

<body: why, not what>

<footer: refs, breaking change>
```

- Type: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`.
- Scope: the subsystem the change touches, for example `engine`, `settings`,
  `skill-market`. Omit it when the change is genuinely repo-wide.
- Summary: imperative mood, no trailing period, at most 72 characters.
  Say `add retry budget` rather than `added retry budget` or `adds retry budget`.
- Body: explain the failure mode and why this change is the smallest correct
  fix. Keep implementation narration out; the diff already shows the how.
- Footer: reference the issue (`Refs: #123`), call out a breaking change
  (`BREAKING CHANGE: ...`), and keep co-author lines only when the user asked
  for them.

## Rules

1. One logical change per commit. If the diff contains unrelated work, propose
   splitting it before writing the message.
2. Never claim behavior the diff does not contain. If tests were not run, do not
   write "tested".
3. Do not use vague summaries such as `update code`, `fix bug`, `misc changes`,
   or `WIP`.
4. Keep the first line self-contained: many tools show only the subject.
5. Preserve the repository's existing convention when it differs from this
   template; read the last twenty subjects before imposing a new style.

## Review mode

When asked to review a message, report the problem, the corrected line, and the
reason in one paragraph. Do not rewrite the whole commit history unless asked.
