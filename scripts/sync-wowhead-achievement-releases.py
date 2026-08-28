#!/usr/bin/env python3
"""Cache achievement release patches from structured Wago DB2 snapshots.

The public archive starts at retail 7.3.5, so achievements already present in
that baseline remain deliberately unclassified. Achievements first appearing
in later snapshots get an exact patch and expansion without per-page scraping.
"""
from __future__ import annotations

import argparse
import csv
import html
import io
import json
import re
import sys
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from achievement_tracker import AchievementTracker  # noqa: E402


EXPANSIONS = {
    7: "Legion", 8: "Battle for Azeroth", 9: "Shadowlands",
    10: "Dragonflight", 11: "The War Within", 12: "Midnight",
}
USER_AGENT = "ConsecratedHammerAchievementTracker/1.0"


def download(url: str, timeout: int = 90) -> bytes:
    return urlopen(Request(url, headers={"User-Agent": USER_AGENT}), timeout=timeout).read()


def release_builds() -> list[tuple[tuple[int, int, int], str]]:
    page = download("https://wago.tools/db2", 30).decode("utf-8", "ignore")
    match = re.search(r'data-page="([^"]+)"', page)
    if not match:
        raise RuntimeError("Wago DB2 version catalogue was not found")
    payload = json.loads(html.unescape(match.group(1)))
    grouped: dict[tuple[int, int, int], list[str]] = {}
    for value in payload.get("props", {}).get("versions", []):
        parts = value.split(".")
        if len(parts) != 4 or not all(part.isdigit() for part in parts):
            continue
        patch = tuple(map(int, parts[:3]))
        if patch[0] >= 7:
            grouped.setdefault(patch, []).append(value)
    return [
        (patch, max(builds, key=lambda value: int(value.rsplit(".", 1)[1])))
        for patch, builds in sorted(grouped.items())
    ]


def achievement_ids(build: str) -> set[int]:
    payload = download(f"https://wago.tools/db2/Achievement/csv?build={build}&locale=enUS").decode("utf-8-sig", "ignore")
    return {int(row["ID"]) for row in csv.DictReader(io.StringIO(payload)) if row.get("ID", "").isdigit()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, default=Path("/mnt/docker/state/app-data/wow-site-mcp/achievement_tracker.sqlite3"))
    args = parser.parse_args()
    tracker = AchievementTracker(args.db)
    tracker.initialise()
    with tracker._connect() as db:
        targets = {row[0] for row in db.execute(
            "SELECT achievement_id FROM achievements WHERE wowhead_release_fetched_at IS NULL AND blizzard_metadata_error_at IS NULL"
        )}
    if not targets:
        print("Release metadata is already complete.")
        return 0

    first_seen: dict[int, tuple[int, int, int] | None] = {}
    builds = release_builds()
    for index, (patch, build) in enumerate(builds, 1):
        present = achievement_ids(build) & targets
        if index == 1:
            # 7.3.5 is the archive baseline, not proof these were added then.
            for achievement_id in present:
                first_seen[achievement_id] = None
        else:
            for achievement_id in present:
                first_seen.setdefault(achievement_id, patch)
        print(f"Compared {index}/{len(builds)}: {'.'.join(map(str, patch))}", flush=True)

    records = []
    for achievement_id in targets:
        patch = first_seen.get(achievement_id)
        records.append({
            "achievementId": achievement_id,
            "addedPatch": ".".join(map(str, patch)) if patch else None,
            "addedExpansion": EXPANSIONS.get(patch[0]) if patch else None,
        })
    result = tracker.upsert_wowhead_release_metadata(records)
    classified = sum(record["addedPatch"] is not None for record in records)
    print(f"Complete: checked {result['updated']}; classified {classified}; legacy or unavailable {len(records) - classified}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
