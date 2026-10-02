# Standards — claudeAwareMod

## Rules

<!-- Reference shared rule files with @ syntax, e.g.:           -->
<!-- @/Users/louisbonnaire/.claude/CLAUDE.md                    -->

## Code style
- The mod is TypeScript against the generated `claude-code` types: no runtime dependencies.
- Logic stays pure in `aware-mod/hooks/core.ts`; only `register.tsx` calls `$`.
- No network calls. The one process run is the allow-listed `rm` of 30-day-old ledgers.

## Testing
- Every hardening fix ships with a regression test covering the adversarial input.
- `claude plugin validate aware-mod` and `claude plugin test aware-mod` pass before a PR.
- Tests mock `fs.*` beneath the plugin: never touch a real `~/.cache/claude-statusline`.

## Git
- Feature branches only; never commit to main/master/development. Work in an isolated worktree.
- Stage files explicitly by path — never `git add .`/`-A`/`--all`.
- Echo the current branch before every commit; no AI attribution in commit messages.
- Run `/code-review` before opening a PR.
