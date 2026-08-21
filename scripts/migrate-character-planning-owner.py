#!/usr/bin/env python3
"""Move legacy character-scoped planning fields to one authenticated owner."""
import argparse
import hashlib
import sqlite3
from datetime import UTC, datetime
from pathlib import Path


def actor(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('database', type=Path)
    parser.add_argument('--character-id', type=int, required=True)
    parser.add_argument('--exclude-username', action='append', default=[])
    args = parser.parse_args()
    excluded = {actor(value) for value in args.exclude_username for value in (value, value.casefold(), value.title())}
    stamp = datetime.now(UTC).isoformat()
    with sqlite3.connect(args.database) as db:
        db.row_factory = sqlite3.Row
        owners = db.execute(
            'SELECT user_id FROM user_characters WHERE character_id=? ORDER BY created_at',
            (args.character_id,),
        ).fetchall()
        owner = next((row['user_id'] for row in owners if row['user_id'] not in excluded), None)
        if not owner:
            parser.error('no eligible linked owner found')
        rows = db.execute(
            "SELECT * FROM character_achievements WHERE character_id=? AND "
            "(priority<>0 OR note IS NOT NULL OR marked_done_at IS NOT NULL OR imported_tip IS NOT NULL)",
            (args.character_id,),
        ).fetchall()
        migrated = 0
        for row in rows:
            manual = row['source'] in ('manual', 'manual_confirmation') or row['marked_done_at'] is not None
            db.execute(
                "INSERT INTO user_achievement_overlays(user_id,character_id,achievement_id,state,earned_at,marked_done_at,progress_current,progress_target,priority,note,imported_tip,imported_tip_source,imported_tip_imported_at,source,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,character_id,achievement_id) DO UPDATE SET "
                "state=COALESCE(excluded.state,user_achievement_overlays.state),earned_at=COALESCE(excluded.earned_at,user_achievement_overlays.earned_at),"
                "marked_done_at=COALESCE(excluded.marked_done_at,user_achievement_overlays.marked_done_at),priority=COALESCE(excluded.priority,user_achievement_overlays.priority),"
                "note=COALESCE(excluded.note,user_achievement_overlays.note),imported_tip=COALESCE(excluded.imported_tip,user_achievement_overlays.imported_tip),"
                "imported_tip_source=COALESCE(excluded.imported_tip_source,user_achievement_overlays.imported_tip_source),"
                "imported_tip_imported_at=COALESCE(excluded.imported_tip_imported_at,user_achievement_overlays.imported_tip_imported_at),"
                "source=COALESCE(excluded.source,user_achievement_overlays.source),updated_at=excluded.updated_at",
                (
                    owner, args.character_id, row['achievement_id'], row['state'] if manual else None,
                    row['earned_at'] if manual else None, row['marked_done_at'],
                    row['progress_current'] if manual else None, row['progress_target'] if manual else None,
                    row['priority'] if row['priority'] else None, row['note'], row['imported_tip'],
                    row['imported_tip_source'], row['imported_tip_imported_at'], row['source'] if manual else None, stamp,
                ),
            )
            migrated += 1
        db.execute(
            "UPDATE character_achievements SET priority=0,note=NULL,marked_done_at=NULL,"
            "imported_tip=NULL,imported_tip_source=NULL,imported_tip_imported_at=NULL,"
            "state=CASE WHEN blizzard_confirmed_at IS NOT NULL THEN 'earned' WHEN source IN ('manual','manual_confirmation') THEN 'unearned' ELSE state END,"
            "earned_at=CASE WHEN blizzard_confirmed_at IS NOT NULL THEN earned_at ELSE NULL END,"
            "source=CASE WHEN blizzard_confirmed_at IS NOT NULL THEN 'blizzard' WHEN source IN ('manual','manual_confirmation') THEN 'catalogue' ELSE source END,updated_at=? "
            "WHERE character_id=?",
            (stamp, args.character_id),
        )
        print(f'migrated_rows={migrated} owner=earliest_eligible_link legacy_fields_cleared=1')


if __name__ == '__main__':
    main()
