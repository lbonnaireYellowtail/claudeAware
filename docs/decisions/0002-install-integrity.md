# ADR-0002 — Install path integrity (install-source guard + download verification)

- **Status:** Accepted (investigation complete; implementation tracked as CS-006, CS-007)
- **Date:** 2026-07-16
- **Method:** ping-pong (research ↔ experiment). Findings originate in the
  2026-07-16 pre-release security review; each is reproduced and its fix validated
  in `experiments/install-integrity/` (see `results/report.md`).
- **Supersedes:** the "Not addressed (accepted risk)" note on the unverified
  `curl | bash` install in ADR-0001's Consequences. That risk is now addressed here.

## Context

`install.sh` is the front door to the package. It runs two documented ways:

```
./install.sh                              # from a cloned repo
curl -fsSL <raw>/install.sh | bash        # standalone; fetches statusline.py
```

Whatever it installs to `~/.claude/scripts/statusline.py` is then auto-executed by
Claude Code on every render (`refreshInterval: 2`). So the installer is a
persistent-code-execution decision point: a wrong file installed once runs
unattended forever. The pre-release review found two gaps on this path. Neither is
a runtime bug in `statusline.py` (that surface was hardened in v1.1.1 / ADR-0001) —
both live in how the package is *delivered*.

The threat model here is deliberately modest and user-facing: **make the published
package as safe as reasonably possible for the people who install it**, defending
against the realistic failure modes — a stale/tampered download, silent drift from
the reviewed version, and the installer picking up the wrong local file — *without*
adding disproportionate friction (see D2's rejected signing option).

## Decision drivers

- Keep the installer POSIX-bash, dependency-free, and both-modes-working.
- Fail safe: when the installer is unsure what its source is, it must download the
  vetted artifact, never guess from ambient state (cwd).
- Any integrity check must actually defend the *automated* pipe flow, which is the
  path most users take — not just the download-then-inspect path a careful user
  might take.
- Verification maintenance must not rot: a pinned digest that a human forgets to
  update is worse than none (it breaks every install after the next change).

---

## D1 — CS-006: never treat the current working directory as the install source

**Root cause.** `install.sh:11-15` selects its source with

```sh
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
...
if [ -f "$SRC_DIR/statusline.py" ]; then cp "$SRC_DIR/statusline.py" "$DEST"
else curl ... ; fi
```

This conflates two different questions. It asks *"is there a file named
`statusline.py` next to where I think I am?"* when it means to ask *"am I running
from a real checkout on disk?"*. In `curl | bash` mode `BASH_SOURCE[0]` is unset,
the `$0` fallback is the literal string `bash`, `dirname bash` → `.`, and `cd . &&
pwd` → the **current working directory**. The local-copy branch then installs
whatever `statusline.py` happens to sit in the user's cwd, silently skipping the
vetted download. Confirmed empirically in the review.

The reliable signal for "running from a checkout" is that the script *itself*
exists as a file on disk. In pipe mode it does not, so there is no legitimate local
source and the only correct action is to download.

**Options.**

| Option | Verdict |
| --- | --- |
| Keep `$0` fallback, add a warning when cwd is used | **Rejected** — still installs an attacker-plantable cwd file; a warning on a `curl \| bash` flow scrolls past unseen. |
| Resolve source only from a real on-disk script path; download otherwise | **Accepted** — `[ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]` gates the local branch. Covers `./install.sh` (BASH_SOURCE is the script's real path); pipe mode falls through to download. Never reads cwd. |

**Do not use this guard unchanged if** a future supported invocation runs the
installer through a shell that leaves `BASH_SOURCE` unset but still has a real
`$0` path (e.g. `sh install.sh` on a system without bash) — that case would fall
through to download, which is safe but not local. The shebang is `bash` and both
documented modes set `BASH_SOURCE`, so this is acceptable today; widen the guard to
also accept a `$0` that resolves to an existing file *only if* such a mode is added.

**Switch trigger:** a clone-and-run install starts downloading instead of using the
local file → `BASH_SOURCE[0]` is not resolving to the script; check the invocation.

---

## D2 — CS-007: verify the downloaded statusline.py against a pinned digest

**Root cause.** `curl -fsSL "$RAW_BASE/statusline.py" -o "$DEST"` (line 19) trusts
TLS for transport but never checks *content*. The reviewed-and-released
`statusline.py` and the bytes a user actually receives are never tied together.

**The decision axis is where the digest comes from** — that determines what it
defends against, not merely whether a check exists:

| Option | Defends against | Does **not** defend against | Cost |
| --- | --- | --- | --- |
| **A. Digest pinned as a constant inside `install.sh`, verified after download, before `chmod +x`** | tampering/corruption of the statusline.py fetch (a *separate* network hop from the install.sh fetch); silent drift of `statusline.py` on `main` away from the version this installer was cut for | a fully compromised repo (attacker rewrites both the pin in install.sh and statusline.py together) | pin must be refreshed each release |
| B. `statusline.py.sha256` fetched from the same `RAW_BASE` and compared | accidental corruption / truncated download | anyone who can tamper the file can tamper its sibling digest — **same origin, security theatre** | trivial |
| C. Digest published in release notes; user verifies `install.sh` manually | a compromised `main`, *if* release notes are trusted separately | the pipe flow — you've already executed `install.sh` before you could hash it | manual, paranoid-only |
| D. GPG / cosign / minisign signature | a compromised repo | — | key management + a verify tool users must install |

**Accepted: A, plus C as a secondary note. Rejected: B and D.**

- **B is rejected** as same-origin theatre — it only catches accidental corruption
  and gives a false sense of integrity.
- **D (signing) is rejected as disproportionate** for a single-file statusline: it
  only helps against repo compromise *if* the signing key lives off-repo *and*
  users actually run a verify step, which they will not for a status line. It adds
  real friction (key custody, a verify tool dependency) against a threat this
  project's users are not realistically targeted by.
- **A is accepted** because it is the only option that hardens the *automated pipe
  flow* the majority take: the pin travels inside the install.sh the user is
  already trusting, and it independently protects the second network hop and pins
  the exact reviewed bytes. Its honest limit — it does not defend against a repo
  where the attacker edits both files at once — is stated plainly and is the
  boundary of this ADR's threat model.
- **C is kept** as a documented manual route for the security-conscious; the
  README's existing note is repointed from `install.sh`'s own digest (chicken-and-egg
  in the pipe flow — you run it before you can check it) to **statusline.py**'s
  digest, which is the artifact that actually executes repeatedly.

**Maintenance is the real risk, so CS-007 includes release automation.** A pin a
human forgets to update breaks every install after the next `statusline.py` change.
CS-007 therefore folds in a release step that computes `statusline.py`'s SHA-256 and
injects it into `install.sh` (and the README/release notes) before tagging — the pin
is generated, never hand-edited.

**Do not use a hand-maintained pin.** If the release automation is skipped, do not
ship a manually-typed digest — an out-of-date pin fails safe (aborts the install)
but breaks every user until fixed, which is worse than the documented manual route
alone. Ship the automation with the pin or ship neither.

**Switch trigger:** revisit and add signing (Option D) if the project grows real
dependencies, a large user base, or starts handling anything sensitive — at that
point repo-compromise becomes a threat worth the key-management cost.

## Experiment validation

`experiments/install-integrity/` drives both candidates through four scenarios in a
sandbox (`file://` download server, planted cwd file, clone dir, tampered download).
Results (`results/report.md`, 2026-07-16):

- **cwd-hijack** (pipe mode, malicious `statusline.py` in cwd, honest server): the
  current logic installs the **attacker file**; `fixed` ignores cwd and installs the
  verified download. Confirms D1.
- **tampered download** (download bytes ≠ pin): the current logic installs the
  tampered file; `fixed` aborts non-zero with nothing installed. Confirms D2.
- **clone install** and **honest download**: both candidates install the legit copy
  — the fix does not regress either good path.

Fixed-candidate failures: 0/4. The experiment doubles as a regression guard (exits
non-zero if `fixed` ever fails a scenario).

## Consequences

- Two installer changes: a source guard (D1) and a verify-before-`chmod` step (D2),
  both POSIX-bash and dependency-free (`shasum`/`sha256sum` with a graceful
  "tool unavailable → document, don't silently skip" fallback).
- A release step now owns the digest: compute `statusline.py`'s SHA-256, inject into
  `install.sh` + README + release notes. Without it the pin rots — this is the
  primary ongoing cost.
- `experiments/install-integrity/` holds the reference behaviour and doubles as a
  regression guard: it drives `install.sh` in pipe mode (with a planted cwd file),
  clone mode, and with a corrupted/mismatched download, asserting the right source
  wins and mismatches abort non-zero.
- Boundary of this ADR (accepted, documented): a fully compromised repository /
  release channel is out of scope; defending it needs signing (Option D), gated on
  the switch trigger above.
