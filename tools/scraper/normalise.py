"""Map a raw scraped Mod (still a Pydantic model) to the on-disk shape and
do a content-aware diff so unchanged mods don't write to disk."""

from __future__ import annotations

from typing import Any

from schema import Mod


def normalise_mod(mod: Mod) -> Mod:
    """Hook for cross-source clean-up - strip whitespace, fix codes, etc.

    Today this is a near no-op. Add fixes here when SUTD data has known quirks
    (extra whitespace, "&amp;" sneaking in, inconsistent spacing in codes).
    """
    return Mod(
        code=mod.code.replace(" ", "").strip(),
        name=mod.name.strip(),
        description=mod.description.strip(),
        credits=mod.credits,
        department=mod.department.strip(),
        pillar=mod.pillar,
        term=mod.term,
        prerequisites=[p.strip() for p in mod.prerequisites],
        corequisites=[p.strip() for p in mod.corequisites],
        schedules=mod.schedules,
        grading=mod.grading,
        workload=mod.workload,
    )


def diff(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """True iff `a` and `b` differ on any field we care about. We dump both
    via JSON so dict-order shenanigans don't cause false positives."""
    import json
    return json.dumps(a, sort_keys=True) != json.dumps(b, sort_keys=True)
