#!/usr/bin/env python3
"""Drive both install.sh candidates through every install scenario and regenerate
results/report.md.

Stdlib-only. Usage: python3 run.py
Exits non-zero if the *fixed* candidate fails any scenario check, so it doubles as
a regression guard (STANDARDS.md).

Design (see ADR-0002):
  Each scenario builds a throwaway sandbox with
    - server/     : the "RAW_BASE" fetched via curl file:// (honest or tampered)
    - repo/       : a clone dir holding the candidate script + a legit statusline.py
    - cwd/        : the directory the installer runs *from* (may hold a planted file)
    - dest/       : where statusline.py is installed
  Pipe mode  = `bash < candidate` run from cwd/  (BASH_SOURCE unset, $0=bash).
  Clone mode = `bash repo/candidate` run from repo/ (BASH_SOURCE = script path).
  We then inspect which bytes landed in dest/ (or that the install aborted).
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CANDIDATES = {
    "vulnerable": os.path.join(HERE, "candidates", "vulnerable.sh"),
    "fixed": os.path.join(HERE, "candidates", "fixed.sh"),
}
RESULTS = os.path.join(HERE, "results", "report.md")

LEGIT = b"#!/usr/bin/env python3\n# LEGIT statusline (server/repo copy)\nprint('ok')\n"
MALICIOUS = b"#!/usr/bin/env python3\n# MALICIOUS statusline (attacker-planted)\nprint('pwned')\n"
LEGIT_SHA = hashlib.sha256(LEGIT).hexdigest()


def _preflight():
    for tool in ("bash", "curl"):
        if shutil.which(tool) is None:
            print(f"SKIP: '{tool}' not available; cannot run experiment.")
            sys.exit(0)


def _run(candidate, mode, server_bytes, cwd_plant):
    """Set up a sandbox, run the candidate, return (exit_code, installed_bytes|None)."""
    box = tempfile.mkdtemp(prefix="install-it-")
    try:
        server = os.path.join(box, "server")
        repo = os.path.join(box, "repo")
        cwd = os.path.join(box, "cwd")
        dest = os.path.join(box, "dest")
        for d in (server, repo, cwd, dest):
            os.makedirs(d)

        # RAW_BASE contents (what curl downloads).
        with open(os.path.join(server, "statusline.py"), "wb") as f:
            f.write(server_bytes)

        # Optional attacker-planted file in the working directory.
        if cwd_plant is not None:
            with open(os.path.join(cwd, "statusline.py"), "wb") as f:
                f.write(cwd_plant)

        env = dict(os.environ)
        env["RAW_BASE"] = "file://" + server
        env["DEST_DIR"] = dest
        env["EXPECTED_SHA256"] = LEGIT_SHA  # the pin the release would inject

        if mode == "pipe":
            with open(candidate, "rb") as script:
                proc = subprocess.run(
                    ["bash"], stdin=script, cwd=cwd, env=env,
                    capture_output=True,
                )
        elif mode == "clone":
            # Clone dir holds both the script and the legit statusline.py next to it.
            local_script = os.path.join(repo, "install.sh")
            shutil.copy(candidate, local_script)
            with open(os.path.join(repo, "statusline.py"), "wb") as f:
                f.write(LEGIT)
            proc = subprocess.run(
                ["bash", local_script], cwd=repo, env=env, capture_output=True,
            )
        else:
            raise ValueError(mode)

        installed = None
        dest_file = os.path.join(dest, "statusline.py")
        if os.path.exists(dest_file):
            with open(dest_file, "rb") as f:
                installed = f.read()
        return proc.returncode, installed
    finally:
        shutil.rmtree(box, ignore_errors=True)


# (name, mode, server_bytes, cwd_plant, expectation)
# expectation is a callable (rc, installed) -> (ok: bool, note: str)
def _expect_legit(rc, installed):
    if rc == 0 and installed == LEGIT:
        return True, "installed the legit copy"
    if installed == MALICIOUS:
        return False, "installed the ATTACKER file"
    return False, f"rc={rc}, installed={'<none>' if installed is None else 'other'}"


def _expect_abort(rc, installed):
    if rc != 0 and installed != MALICIOUS:
        return True, f"aborted (rc={rc}), no bad file installed"
    if installed == MALICIOUS:
        return False, "installed the TAMPERED download"
    return False, f"did not abort (rc={rc})"


SCENARIOS = [
    ("cwd-hijack (pipe, malicious file in cwd, honest server)",
     "pipe", LEGIT, MALICIOUS, _expect_legit),
    ("honest download (pipe, empty cwd, honest server)",
     "pipe", LEGIT, None, _expect_legit),
    ("tampered download (pipe, empty cwd, server bytes != pin)",
     "pipe", MALICIOUS, None, _expect_abort),
    ("clone install (clone mode, legit file beside script)",
     "clone", LEGIT, None, _expect_legit),
]


def run():
    _preflight()
    rows = []          # (scenario, candidate, ok, note)
    fixed_failures = 0
    for scen_name, mode, server_bytes, cwd_plant, expect in SCENARIOS:
        for cand_name, cand_path in CANDIDATES.items():
            rc, installed = _run(cand_path, mode, server_bytes, cwd_plant)
            ok, note = expect(rc, installed)
            rows.append((scen_name, cand_name, ok, note))
            if cand_name == "fixed" and not ok:
                fixed_failures += 1

    _write_report(rows, fixed_failures)
    print(f"Wrote {RESULTS}")
    if fixed_failures:
        print(f"FAIL: fixed candidate failed {fixed_failures} check(s).")
        sys.exit(1)
    print("PASS: fixed candidate safe on every scenario.")


def _write_report(rows, fixed_failures):
    os.makedirs(os.path.dirname(RESULTS), exist_ok=True)
    lines = [
        "# Install-integrity experiment — results",
        "",
        "Generated by `run.py`. Validates CS-006 (install-source guard) and CS-007",
        "(download verification) from ADR-0002. `vulnerable` = current install.sh",
        "logic; `fixed` = proposed logic in `candidates/fixed.sh`.",
        "",
        f"- Legit statusline SHA-256 (the release pin): `{LEGIT_SHA}`",
        f"- Fixed-candidate failures: **{fixed_failures}**",
        "",
        "| Scenario | Candidate | Safe | Detail |",
        "| --- | --- | :---: | --- |",
    ]
    for scen, cand, ok, note in rows:
        lines.append(f"| {scen} | `{cand}` | {'✅' if ok else '❌'} | {note} |")
    lines += [
        "",
        "## Reading",
        "",
        "- **cwd-hijack**: the current logic installs a `statusline.py` planted in the",
        "  working directory (`❌ vulnerable`); the fix ignores cwd and downloads the",
        "  verified copy.",
        "- **tampered download**: the fix aborts non-zero when downloaded bytes don't",
        "  match the pinned digest; the current logic installs whatever it fetched.",
        "- **clone install**: both install the legit local copy — the fix does not",
        "  regress the clone-and-run path.",
        "",
        "Note: `fixed.sh` fails **closed** (exit 3) when no `shasum`/`sha256sum` is",
        "present rather than skipping verification — see ADR-0002 D2.",
    ]
    with open(RESULTS, "w") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    run()
