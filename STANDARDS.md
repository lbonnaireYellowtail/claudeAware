# Standards — claude-statusline

## Rules

<!-- Reference shared rule files with @ syntax, e.g.:           -->
<!-- @/Users/louisbonnaire/.claude/CLAUDE.md                    -->

## Code style
- Python 3, stdlib-only — no third-party runtime dependencies.
- Keep the primary path (stdin payload → render) free of subprocess/network calls.

## Testing
- Every hardening fix ships with a regression test covering the adversarial input.
- Re-run the 2-session cross-session sync simulation after any change to the sync/cache logic.

## Git
- Feature branches only; never commit to main/master/development. Work in an isolated worktree.
- Stage files explicitly by path — never `git add .`/`-A`/`--all`.
- Echo the current branch before every commit; no AI attribution in commit messages.
- Run `/code-review` before opening a PR.
