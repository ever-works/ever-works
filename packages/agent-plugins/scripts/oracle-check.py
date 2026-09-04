#!/usr/bin/env python3
"""Cross-check our skill validator against the reference implementation.

An oracle, not a gate. `skills-ref` is the reference library for Agent Skills;
running it over the same fixtures our own validator uses answers a question no
amount of our own testing can: *does our reading of the specification agree
with somebody else's?*

Disagreement is reported, never failed on, for two reasons:

1. The two tools do not have the same job. Ours validates a PACKAGE (spec 7.1)
   and reports per-skill findings without rejecting the package; theirs
   validates a single skill directory against the Agent Skills spec. A skill we
   deliberately skip while keeping its siblings is a skill they call invalid,
   and both are correct.
2. `skills-ref` is at 0.1.1. Pinning CI to a young external tool's opinion
   would hand it a veto over merges.

So this prints a table and exits 0. A human reads the disagreements; the build
does not stop for them.

Usage:
    python oracle-check.py <fixtures-dir>
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def skill_dirs(fixtures: Path) -> list[Path]:
    """Every `skills/<name>/` directory under the fixture corpus."""
    found: list[Path] = []
    for skills_dir in sorted(fixtures.glob("*/skills")):
        if not skills_dir.is_dir():
            continue
        for child in sorted(skills_dir.iterdir()):
            if child.is_dir() and (child / "SKILL.md").is_file():
                found.append(child)
    return found


# The wheel installs a console script, but it is not always on PATH — a
# pip --user install on Windows and some CI images both leave it off. The
# module form is equivalent and always resolvable once the package is
# importable, so it is tried second rather than not at all.
INVOCATIONS = (
    ["agentskills", "validate"],
    [sys.executable, "-m", "skills_ref.cli", "validate"],
)


def reference_verdict(skill: Path) -> tuple[bool, str]:
    """Ask the reference library. Returns (valid, detail)."""
    for argv in INVOCATIONS:
        try:
            result = subprocess.run(
                [*argv, str(skill)],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except FileNotFoundError:
            continue
        except subprocess.TimeoutExpired:
            return (False, "timed out")

        detail = (result.stderr or result.stdout or "").strip().replace("\n", "; ")
        # A missing module surfaces as a non-zero exit with an import error
        # rather than FileNotFoundError, and must not be read as "invalid
        # skill" — that would report every fixture as a disagreement.
        if "No module named" in detail:
            continue
        return (result.returncode == 0, detail[:160])

    return (False, "reference library unavailable")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: oracle-check.py <fixtures-dir>", file=sys.stderr)
        return 0  # Never fail the build; see the module docstring.

    fixtures = Path(sys.argv[1])
    if not fixtures.is_dir():
        print(f"::warning::Fixture directory {fixtures} not found; oracle skipped.")
        return 0

    skills = skill_dirs(fixtures)
    if not skills:
        print(f"::warning::No skill directories under {fixtures}; oracle skipped.")
        return 0

    rows = []
    for skill in skills:
        valid, detail = reference_verdict(skill)
        rows.append((skill.parent.parent.name, skill.name, valid, detail))

    accepted = [r for r in rows if r[2]]
    rejected = [r for r in rows if not r[2]]

    print(f"skills checked by the reference library: {len(rows)}")
    print(f"  it accepts: {len(accepted)}")
    print(f"  it rejects: {len(rejected)}")

    if rejected:
        print("\nRejected by the reference library:")
        for package, name, _valid, detail in rejected:
            print(f"  {package}/{name}")
            if detail:
                print(f"    {detail}")

    print(
        "\n::notice::This is ONE HALF of a comparison, printed for a human to read "
        "against our own findings. It is not an assertion that we agree or disagree, "
        "because the two tools do not answer the same question: the reference "
        "validates a single skill against the Agent Skills spec, while ours validates "
        "a PACKAGE and reports per-skill findings without rejecting the package. Most "
        "of the corpus is deliberately invalid, so a long rejection list is the "
        "expected shape — what is worth investigating is a skill listed here that our "
        "own findings do NOT mention, or the reverse."
    )

    print(json.dumps({"checked": len(rows), "accepted": len(accepted), "rejected": len(rejected)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
