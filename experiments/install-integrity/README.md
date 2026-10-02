# install-integrity experiment

Validates the two install-path fixes from **ADR-0002**:

- **CS-006** — never treat the current working directory as the install source.
- **CS-007** — verify the downloaded `statusline.py` against a pinned SHA-256.

## Run

```sh
python3 run.py
```

Stdlib-only. Writes `results/report.md` and exits non-zero if the `fixed`
candidate fails any scenario (so it doubles as a regression guard).

## What it does

`run.py` builds a throwaway sandbox per scenario (a `file://` "download server", a
clone dir, a working dir, and an install dir), runs each candidate installer, and
inspects which bytes actually landed — or that the install correctly aborted.

- `candidates/vulnerable.sh` — the **current** `install.sh` source logic (`before`).
- `candidates/fixed.sh` — the **proposed** logic: BASH_SOURCE-gated source
  selection + verify-before-`chmod` against `EXPECTED_SHA256` (fails closed if no
  sha tool is present).

Modes: **pipe** (`bash < script`, cwd-relative, BASH_SOURCE unset — mirrors
`curl … | bash`) and **clone** (`bash repo/install.sh` with a legit copy beside it).

## Scenarios & expected

| Scenario | vulnerable | fixed |
| --- | --- | --- |
| Malicious `statusline.py` planted in cwd, honest server | installs attacker file ❌ | ignores cwd, installs verified download ✅ |
| Honest download, empty cwd | installs legit ✅ | installs legit ✅ |
| Download bytes ≠ pinned digest | installs tampered file ❌ | aborts non-zero, nothing installed ✅ |
| Clone-and-run, legit file beside script | installs legit ✅ | installs legit ✅ (no regression) |

Reference behaviour only — the candidates are not shipped. The real `install.sh` is
implemented against `fixed.sh` when CS-006/CS-007 move to build (Phase 5).
