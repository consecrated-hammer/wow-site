#!/usr/bin/env python3
"""Conservatively import the private checklist into an existing tracker DB.

Only a unique, normalised exact achievement-name match is accepted.  The
spreadsheet never replaces Blizzard fields already present in the database.
"""
import argparse
import re
import sqlite3
import unicodedata
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
TIP_SOURCE = 'Reilly WoW Achievement Checklist · Fastest path / tip'
STALE_TIP_PATTERNS = (
    r'earned since the original export',
    r'near-finished meta',
    r'listed component',
    r'\byour export\b',
)


def key(value):
    return ' '.join(unicodedata.normalize('NFKC', value).casefold().split())


def rows(path):
    with ZipFile(path) as archive:
        root = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    for row in root.findall(f'.//{NS}sheetData/{NS}row'):
        values = {}
        for cell in row.findall(f'{NS}c'):
            column = re.match(r'[A-Z]+', cell.attrib['r']).group(0)
            values[column] = cell.findtext(f'{NS}v') or ''
        if values.get('A') in ('☐', '☑') and values.get('C'):
            yield values


def is_useful_tip(tip, frequency):
    """Keep specific instructions; reject repeated filler and snapshot claims."""
    value = tip.strip()
    return bool(value) and frequency == 1 and not any(
        re.search(pattern, value, re.IGNORECASE) for pattern in STALE_TIP_PATTERNS
    )


def resolve_achievement(matches, character_faction):
    """Resolve an exact name only when identity is unique or faction makes it unique."""
    if len(matches) == 1:
        return matches[0][0]
    if not character_faction:
        return None
    compatible = [row for row in matches if not row[1] or row[1].upper() == character_faction.upper()]
    return compatible[0][0] if len(compatible) == 1 else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('database', type=Path)
    parser.add_argument('spreadsheet', type=Path)
    parser.add_argument('--character-id', type=int, required=True)
    parser.add_argument('--user-id', help='Hashed authenticated owner for character-scoped imported tips.')
    parser.add_argument(
        '--useful-tips-only', action='store_true',
        help='Import only specific, non-stale tips for this character\'s unearned achievements.',
    )
    args = parser.parse_args()
    stamp = datetime.now(UTC).isoformat()
    with sqlite3.connect(args.database) as db:
        if args.useful_tips_only:
            if not args.user_id:
                parser.error('--user-id is required with --useful-tips-only')
            columns = {row[1] for row in db.execute('PRAGMA table_info(user_achievement_overlays)')}
            required = {'imported_tip', 'imported_tip_source', 'imported_tip_imported_at'}
            if not required.issubset(columns):
                parser.error('tracker schema is missing imported-tip columns; deploy/initialise the current app first')
            character = db.execute('SELECT faction FROM characters WHERE id=?', (args.character_id,)).fetchone()
            if not character:
                parser.error(f'character {args.character_id} does not exist')
            workbook_rows = list(rows(args.spreadsheet))
            frequencies = Counter(row.get('G', '').strip() for row in workbook_rows)
            names = {}
            for aid, name, required_faction in db.execute('SELECT achievement_id,name,required_faction FROM achievements'):
                names.setdefault(key(name), []).append((aid, required_faction))
            imported = generic = stale = earned = unresolved = existing = 0
            for row in workbook_rows:
                tip = row.get('G', '').strip()
                if frequencies[tip] != 1:
                    generic += 1
                    continue
                if not is_useful_tip(tip, frequencies[tip]):
                    stale += 1
                    continue
                aid = resolve_achievement(names.get(key(row['C']), []), character[0])
                if aid is None:
                    unresolved += 1
                    continue
                state = db.execute(
                    "SELECT CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(ua.state,ca.state) END,ua.imported_tip "
                    "FROM character_achievements ca LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id "
                    "WHERE ca.character_id=? AND ca.achievement_id=?",
                    (args.user_id, args.character_id, aid),
                ).fetchone()
                if not state or state[0] == 'earned':
                    earned += 1
                    continue
                if state[1]:
                    existing += 1
                    continue
                db.execute(
                    'INSERT INTO user_achievement_overlays(user_id,character_id,achievement_id,imported_tip,imported_tip_source,imported_tip_imported_at,updated_at) '
                    'VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,character_id,achievement_id) DO UPDATE SET '
                    'imported_tip=excluded.imported_tip,imported_tip_source=excluded.imported_tip_source,'
                    'imported_tip_imported_at=excluded.imported_tip_imported_at,updated_at=excluded.updated_at',
                    (args.user_id, args.character_id, aid, tip, TIP_SOURCE, stamp, stamp),
                )
                imported += 1
            print(
                f'imported_tips={imported} skipped_generic={generic} skipped_stale={stale} '
                f'skipped_earned={earned} skipped_unresolved={unresolved} skipped_existing={existing}'
            )
            return
        labels = {100: 'Do now', 75: 'Near-finish rewards', 50: 'Current Midnight', 25: 'Quick wins', 0: 'Event / zone projects', -25: 'Group / harder', -50: 'Long grinds', -75: 'PvP / optional', -100: 'Completed'}
        db.executemany('INSERT INTO character_priority_labels(character_id,priority,label) VALUES(?,?,?) ON CONFLICT(character_id,priority) DO UPDATE SET label=excluded.label', [(args.character_id, priority, label) for priority, label in labels.items()])
        names = {}
        for aid, name in db.execute('SELECT achievement_id, name FROM achievements'):
            names.setdefault(key(name), []).append(aid)
        imported = skipped = 0
        for row in rows(args.spreadsheet):
            matches = names.get(key(row['C']), [])
            if len(matches) != 1:
                skipped += 1
                continue
            aid = matches[0]
            group = re.match(r'\s*(\d+)', row.get('B', ''))
            priority = {1: 100, 2: 75, 3: 50, 4: 25, 5: 0, 6: -25, 7: -50, 8: -75, 9: -100}.get(int(group.group(1)), 0) if group else 0
            points = int(row['D']) if row.get('D', '').isdigit() else None
            db.execute('UPDATE achievements SET points=COALESCE(points, ?), category=COALESCE(category, ?) WHERE achievement_id=?', (points, row.get('E') or None, aid))
            db.execute('INSERT INTO curated_metadata(achievement_id,what_to_do,fastest_path_tip,reward,source_name,source_url,verified_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(achievement_id) DO UPDATE SET what_to_do=excluded.what_to_do,fastest_path_tip=excluded.fastest_path_tip,reward=excluded.reward,updated_at=excluded.updated_at', (aid, row.get('F') or None, row.get('G') or None, row.get('H') or None, 'Reilly WoW Achievement Checklist', 'local://achievement-checklist/2026-08-18', '2026-08-18T00:00:00+00:00', stamp))
            db.execute('UPDATE character_achievements SET priority=? WHERE character_id=? AND achievement_id=?', (priority, args.character_id, aid))
            imported += 1
    print(f'imported={imported} skipped_ambiguous_or_missing={skipped}')


if __name__ == '__main__':
    main()
