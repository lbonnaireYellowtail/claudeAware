# Standards — claudeAware

## Rules

<!-- Reference shared rule files with @ syntax, e.g.:           -->
<!-- @/Users/louisbonnaire/.claude/CLAUDE.md                    -->

## Code style
- statusline: Python 3, stdlib-only — no third-party runtime dependencies. Keep the
  primary path (stdin payload → render) free of subprocess/network calls.
- aware-mod: TypeScript against the generated `claude-code` types, no runtime
  dependencies. Logic stays pure in `hooks/core.ts`; only `register.tsx` calls `$`. No
  network calls; the one process run is the allow-listed `rm` of 30-day-old ledgers.
- A change to the shared rules (the line, the cache, the ledger) lands in both tools in
  the same PR.

## Testing
- Every hardening fix ships with a regression test covering the adversarial input.
- Re-run the 2-session cross-session sync simulation after any change to the sync/cache logic.
- `python3 -m unittest discover -s statusline/tests`, `claude plugin test aware-mod` and
  `node --experimental-strip-types tools/parity.mts` all pass before a PR.
- Tests use a throwaway `HOME` or an in-memory fs: never touch a real `~/.cache/claude-statusline`.

## Git
- Feature branches only; never commit to main/master/development. Work in an isolated worktree.
- Stage files explicitly by path — never `git add .`/`-A`/`--all`.
- Echo the current branch before every commit; no AI attribution in commit messages.
- Run `/code-review` before opening a PR.
