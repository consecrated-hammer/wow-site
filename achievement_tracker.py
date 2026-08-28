"""Persistent, provenance-aware achievement planning state for the WoW MCP.

Blizzard is authoritative for earned state.  Curated guidance is explicit
agent-supplied research, never an inferred or scraped runtime value.
"""
from __future__ import annotations

import json
import hashlib
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

BLIZZARD_METADATA_VERSION = 4
HAMMERLINK_MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
HAMMERLINK_HISTORY_PER_CHARACTER = 10
HAMMERLINK_VAULT_ACTIVITY_TYPES = {
    1: 'Dungeons',
    3: 'Raids',
    5: 'Special reward',
    6: 'World activities',
}
HAMMERLINK_CURRENCY_TIERS = ('adventurer', 'veteran', 'champion', 'hero', 'myth')
HAMMERLINK_CURRENCY_MATERIALS = ('voidcore', 'dust')


def now() -> str:
    return datetime.now(UTC).isoformat()


class AchievementTracker:
    def __init__(self, path: Path):
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    @staticmethod
    def _meta_progress_state(static_value: str | dict[str, Any] | None, progress_value: str | dict[str, Any] | None) -> str | None:
        """Derive state only for metas whose direct criteria are achievements."""
        def decoded(value: str | dict[str, Any] | None) -> dict[str, Any]:
            if isinstance(value, dict):
                return value
            try:
                parsed = json.loads(value) if value else {}
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}

        static_children = decoded(static_value).get('child_criteria') or []
        meta_nodes = [
            node for node in static_children
            if isinstance(node, dict) and isinstance(node.get('achievement'), dict) and isinstance(node['achievement'].get('id'), int)
        ]
        if not meta_nodes:
            return None
        progress_by_id: dict[int, dict[str, Any]] = {}
        def index(node: Any) -> None:
            if not isinstance(node, dict): return
            if isinstance(node.get('id'), int): progress_by_id[node['id']] = node
            for child in node.get('child_criteria') or []: index(child)
        index(decoded(progress_value))
        completed = sum(bool(progress_by_id.get(node.get('id'), {}).get('is_completed')) for node in meta_nodes)
        if completed == len(meta_nodes): return 'completion_ready'
        if completed: return 'in_progress'
        return 'unearned'

    def initialise(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript("""
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS characters (
                id INTEGER PRIMARY KEY, region TEXT NOT NULL, realm TEXT NOT NULL,
                name TEXT NOT NULL, realm_slug TEXT, active INTEGER NOT NULL DEFAULT 0,
                race TEXT, character_class TEXT, faction TEXT, avatar_url TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(region, realm, name)
              );
              CREATE TABLE IF NOT EXISTS achievements (
                achievement_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
                points INTEGER, category TEXT, description TEXT,
                criteria_json TEXT, required_faction TEXT, is_account_wide INTEGER NOT NULL DEFAULT 0,
                reward_description TEXT, reward_type TEXT, reward_url TEXT,
                reward_item_id INTEGER, reward_item_name TEXT, reward_item_icon_url TEXT, icon_url TEXT,
                added_expansion TEXT, added_patch TEXT, wowhead_release_fetched_at TEXT,
                blizzard_fetched_at TEXT, blizzard_metadata_error_at TEXT, blizzard_metadata_error TEXT,
                blizzard_metadata_version INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
              );
              CREATE TABLE IF NOT EXISTS character_achievements (
                character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                achievement_id INTEGER NOT NULL REFERENCES achievements(achievement_id) ON DELETE CASCADE,
                state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','unearned','in_progress','completion_ready','earned')),
                earned_at TEXT, marked_done_at TEXT, blizzard_confirmed_at TEXT, criteria_progress_json TEXT, progress_current INTEGER, progress_target INTEGER,
                priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100),
                note TEXT, imported_tip TEXT, imported_tip_source TEXT, imported_tip_imported_at TEXT,
                source TEXT NOT NULL DEFAULT 'manual', updated_at TEXT NOT NULL,
                PRIMARY KEY(character_id, achievement_id)
              );
              CREATE TABLE IF NOT EXISTS curated_metadata (
                achievement_id INTEGER PRIMARY KEY REFERENCES achievements(achievement_id) ON DELETE CASCADE,
                what_to_do TEXT, fastest_path_tip TEXT, estimated_minutes INTEGER,
                difficulty TEXT, group_requirement TEXT, availability TEXT,
                availability_reason TEXT, next_available_at TEXT, deadline TEXT, deadline_reason TEXT,
                zone TEXT, expansion TEXT, season TEXT, event TEXT, reward TEXT,
                source_name TEXT NOT NULL, source_url TEXT NOT NULL, verified_at TEXT NOT NULL,
                expires_at TEXT, updated_at TEXT NOT NULL
              );
              CREATE TABLE IF NOT EXISTS achievement_dependencies (
                achievement_id INTEGER NOT NULL REFERENCES achievements(achievement_id) ON DELETE CASCADE,
                depends_on_id INTEGER NOT NULL REFERENCES achievements(achievement_id) ON DELETE CASCADE,
                PRIMARY KEY(achievement_id, depends_on_id), CHECK(achievement_id != depends_on_id)
              );
              CREATE TABLE IF NOT EXISTS character_priority_labels (
                character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                priority INTEGER NOT NULL CHECK(priority BETWEEN -100 AND 100),
                label TEXT NOT NULL, PRIMARY KEY(character_id, priority)
              );
              CREATE TABLE IF NOT EXISTS user_priority_labels (
                user_id TEXT NOT NULL, priority INTEGER NOT NULL CHECK(priority BETWEEN -100 AND 100),
                label TEXT NOT NULL, PRIMARY KEY(user_id, priority)
              );
              CREATE TABLE IF NOT EXISTS user_achievement_overlays (
                user_id TEXT NOT NULL,
                character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                achievement_id INTEGER NOT NULL REFERENCES achievements(achievement_id) ON DELETE CASCADE,
                state TEXT CHECK(state IS NULL OR state IN ('unknown','unearned','in_progress','completion_ready','earned')),
                earned_at TEXT, marked_done_at TEXT, progress_current INTEGER, progress_target INTEGER,
                priority INTEGER CHECK(priority IS NULL OR priority BETWEEN -100 AND 100),
                note TEXT, imported_tip TEXT, imported_tip_source TEXT, imported_tip_imported_at TEXT,
                source TEXT, updated_at TEXT NOT NULL,
                PRIMARY KEY(user_id, character_id, achievement_id)
              );
              CREATE TABLE IF NOT EXISTS user_characters (
                user_id TEXT NOT NULL,
                character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL, last_used_at TEXT NOT NULL,
                PRIMARY KEY(user_id, character_id)
              );
              CREATE TABLE IF NOT EXISTS hammerlink_imports (
                id INTEGER PRIMARY KEY,
                user_id TEXT NOT NULL,
                character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                format INTEGER NOT NULL, captured_at INTEGER NOT NULL, imported_at TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL, equipment_count INTEGER NOT NULL,
                bag_equipment_count INTEGER NOT NULL, vault_activity_count INTEGER NOT NULL,
                has_talent_import INTEGER NOT NULL, equipped_item_level REAL, overall_item_level REAL,
                snapshot_json TEXT NOT NULL,
                UNIQUE(user_id, character_id, payload_sha256)
              );
              CREATE TABLE IF NOT EXISTS tracker_events (
                id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
                character_id INTEGER, achievement_id INTEGER, detail TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS ca_priority ON character_achievements(character_id, priority DESC);
              CREATE INDEX IF NOT EXISTS cm_deadline ON curated_metadata(deadline);
              CREATE INDEX IF NOT EXISTS uc_recent ON user_characters(user_id, last_used_at DESC);
              CREATE INDEX IF NOT EXISTS uao_character ON user_achievement_overlays(user_id, character_id);
              CREATE INDEX IF NOT EXISTS hi_user_recent ON hammerlink_imports(user_id, imported_at DESC);
            """)
            # SQLite cannot alter a CHECK constraint. Rebuild this one table
            # once so an old tracker can distinguish confirmed-unearned from
            # unavailable/unknown without losing any existing state.
            if db.execute("PRAGMA user_version").fetchone()[0] < 1:
                db.executescript("""
                  ALTER TABLE character_achievements RENAME TO character_achievements_before_unearned;
                  CREATE TABLE character_achievements (
                    character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                    achievement_id INTEGER NOT NULL REFERENCES achievements(achievement_id) ON DELETE CASCADE,
                    state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','unearned','in_progress','completion_ready','earned')),
                    earned_at TEXT, marked_done_at TEXT, blizzard_confirmed_at TEXT, criteria_progress_json TEXT, progress_current INTEGER, progress_target INTEGER,
                    priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100),
                    note TEXT, source TEXT NOT NULL DEFAULT 'manual', updated_at TEXT NOT NULL,
                    PRIMARY KEY(character_id, achievement_id)
                  );
                  INSERT INTO character_achievements(character_id,achievement_id,state,earned_at,progress_current,progress_target,priority,note,source,updated_at)
                    SELECT character_id,achievement_id,state,earned_at,progress_current,progress_target,priority,note,source,updated_at
                    FROM character_achievements_before_unearned;
                  DROP TABLE character_achievements_before_unearned;
                  CREATE INDEX IF NOT EXISTS ca_priority ON character_achievements(character_id, priority DESC);
                  PRAGMA user_version=1;
                """)
            if db.execute("PRAGMA user_version").fetchone()[0] < 2:
                # Priority values and imported legends are user-authored data.
                # Preserve the full scale while advancing the schema marker.
                db.execute("PRAGMA user_version=2")
            if db.execute("PRAGMA user_version").fetchone()[0] < 3:
                import_columns = {row[1] for row in db.execute("PRAGMA table_info(hammerlink_imports)")}
                if "id" not in import_columns:
                    db.executescript("""
                      ALTER TABLE hammerlink_imports RENAME TO hammerlink_imports_before_history;
                      CREATE TABLE hammerlink_imports (
                        id INTEGER PRIMARY KEY,
                        user_id TEXT NOT NULL,
                        character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                        format INTEGER NOT NULL, captured_at INTEGER NOT NULL, imported_at TEXT NOT NULL,
                        payload_sha256 TEXT NOT NULL, equipment_count INTEGER NOT NULL,
                        bag_equipment_count INTEGER NOT NULL, vault_activity_count INTEGER NOT NULL,
                        has_talent_import INTEGER NOT NULL, equipped_item_level REAL, overall_item_level REAL,
                        snapshot_json TEXT NOT NULL,
                        UNIQUE(user_id, character_id, payload_sha256)
                      );
                      INSERT INTO hammerlink_imports(
                        user_id,character_id,format,captured_at,imported_at,payload_sha256,
                        equipment_count,bag_equipment_count,vault_activity_count,has_talent_import,
                        equipped_item_level,overall_item_level,snapshot_json
                      ) SELECT
                        user_id,character_id,format,captured_at,imported_at,payload_sha256,
                        equipment_count,bag_equipment_count,vault_activity_count,has_talent_import,
                        equipped_item_level,overall_item_level,snapshot_json
                      FROM hammerlink_imports_before_history;
                      DROP TABLE hammerlink_imports_before_history;
                      CREATE INDEX hi_user_recent ON hammerlink_imports(user_id, imported_at DESC);
                      CREATE INDEX hi_character_recent ON hammerlink_imports(user_id, character_id, imported_at DESC, id DESC);
                    """)
                else:
                    db.execute("CREATE INDEX IF NOT EXISTS hi_character_recent ON hammerlink_imports(user_id, character_id, imported_at DESC, id DESC)")
                db.execute("PRAGMA user_version=3")
            overlay_columns = {row[1] for row in db.execute("PRAGMA table_info(user_achievement_overlays)")}
            for column in ("progress_current", "progress_target"):
                if column not in overlay_columns:
                    db.execute(f"ALTER TABLE user_achievement_overlays ADD COLUMN {column} INTEGER")
            columns = {row[1] for row in db.execute("PRAGMA table_info(characters)")}
            if "realm_key" not in columns:
                db.execute("ALTER TABLE characters ADD COLUMN realm_key TEXT")
            if "last_blizzard_refresh_at" not in columns:
                db.execute("ALTER TABLE characters ADD COLUMN last_blizzard_refresh_at TEXT")
            if "race" not in columns:
                db.execute("ALTER TABLE characters ADD COLUMN race TEXT")
            if "character_class" not in columns:
                db.execute("ALTER TABLE characters ADD COLUMN character_class TEXT")
            if "faction" not in columns:
                db.execute("ALTER TABLE characters ADD COLUMN faction TEXT")
            if "avatar_url" not in columns:
                db.execute("ALTER TABLE characters ADD COLUMN avatar_url TEXT")
            metadata_columns = {row[1] for row in db.execute("PRAGMA table_info(achievements)")}
            if "blizzard_metadata_error_at" not in metadata_columns:
                db.execute("ALTER TABLE achievements ADD COLUMN blizzard_metadata_error_at TEXT")
            if "blizzard_metadata_error" not in metadata_columns:
                db.execute("ALTER TABLE achievements ADD COLUMN blizzard_metadata_error TEXT")
            if "blizzard_metadata_version" not in metadata_columns:
                db.execute("ALTER TABLE achievements ADD COLUMN blizzard_metadata_version INTEGER NOT NULL DEFAULT 0")
            for column, definition in (
                ("criteria_json", "TEXT"), ("is_account_wide", "INTEGER NOT NULL DEFAULT 0"),
                ("required_faction", "TEXT"),
                ("reward_description", "TEXT"), ("reward_item_id", "INTEGER"),
                ("reward_type", "TEXT"), ("reward_url", "TEXT"),
                ("reward_item_name", "TEXT"), ("reward_item_icon_url", "TEXT"), ("icon_url", "TEXT"),
                ("added_expansion", "TEXT"), ("added_patch", "TEXT"), ("wowhead_release_fetched_at", "TEXT"),
            ):
                if column not in metadata_columns:
                    db.execute(f"ALTER TABLE achievements ADD COLUMN {column} {definition}")
            achievement_columns = {row[1] for row in db.execute("PRAGMA table_info(character_achievements)")}
            if "marked_done_at" not in achievement_columns:
                db.execute("ALTER TABLE character_achievements ADD COLUMN marked_done_at TEXT")
                db.execute("UPDATE character_achievements SET marked_done_at=earned_at WHERE state='earned' AND source='manual_confirmation'")
            if "blizzard_confirmed_at" not in achievement_columns:
                db.execute("ALTER TABLE character_achievements ADD COLUMN blizzard_confirmed_at TEXT")
                db.execute("UPDATE character_achievements SET blizzard_confirmed_at=earned_at WHERE state='earned' AND source='blizzard'")
            if "criteria_progress_json" not in achievement_columns:
                db.execute("ALTER TABLE character_achievements ADD COLUMN criteria_progress_json TEXT")
            for column in ("imported_tip", "imported_tip_source", "imported_tip_imported_at"):
                if column not in achievement_columns:
                    db.execute(f"ALTER TABLE character_achievements ADD COLUMN {column} TEXT")
            for row in db.execute("SELECT id, realm, realm_slug FROM characters WHERE realm_key IS NULL OR realm_key='' ").fetchall():
                db.execute("UPDATE characters SET realm_key=? WHERE id=?", (self._realm_key(row["realm"], row["realm_slug"]), row["id"]))
            # A character definition can be shared, but chooser history belongs
            # to the authenticated user who explicitly opened it. Recover that
            # ownership from existing audited character lookups.
            db.execute("""
              INSERT OR IGNORE INTO user_characters(user_id,character_id,created_at,last_used_at)
              SELECT actor,character_id,MIN(timestamp),MAX(timestamp)
              FROM tracker_events
              WHERE action='character_upsert' AND actor IS NOT NULL AND actor NOT LIKE 'system:%' AND character_id IS NOT NULL
              GROUP BY actor,character_id
            """)
            # The achievement definition is global; only completion and
            # planning state belong to a character. Attach every available
            # global definition to every character without disturbing any
            # existing per-character state.
            stamp = now()
            db.execute(
                "INSERT OR IGNORE INTO character_achievements(character_id,achievement_id,state,source,updated_at) "
                "SELECT c.id,a.achievement_id,'unearned','catalogue',? FROM characters c CROSS JOIN achievements a "
                "WHERE a.blizzard_metadata_error_at IS NULL",
                (stamp,),
            )
            # Reconcile already-cached Blizzard criteria so the status facet
            # reflects partial meta completion immediately after an upgrade.
            for row in db.execute("""
              SELECT ca.character_id,ca.achievement_id,ca.state,ca.criteria_progress_json,a.criteria_json
              FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id
              WHERE ca.state!='earned' AND ca.criteria_progress_json IS NOT NULL
            """).fetchall():
                derived = self._meta_progress_state(row['criteria_json'], row['criteria_progress_json'])
                if derived and derived != row['state']:
                    db.execute(
                        "UPDATE character_achievements SET state=?,source='blizzard',updated_at=? WHERE character_id=? AND achievement_id=?",
                        (derived, stamp, row['character_id'], row['achievement_id']),
                    )

    @staticmethod
    def _realm_key(realm: str, realm_slug: str | None = None) -> str:
        """Stable realm identity: punctuation/display spelling must not fork a character."""
        return re.sub(r"[^a-z0-9]+", "", str(realm_slug or realm).lower())

    @staticmethod
    def _overlay_user(actor: str | None) -> str:
        # Production requests are authenticated. The empty identity keeps
        # internal calls/tests isolated from every real account.
        return actor or ""

    @staticmethod
    def _character(db: sqlite3.Connection, character_id: int) -> sqlite3.Row:
        row = db.execute("SELECT * FROM characters WHERE id=?", (character_id,)).fetchone()
        if not row: raise ValueError("character_id does not exist")
        return row

    def _event(self, db: sqlite3.Connection, actor: str | None, action: str, character_id: int | None, achievement_id: int | None, detail: dict[str, Any]) -> None:
        db.execute("INSERT INTO tracker_events(timestamp,actor,action,character_id,achievement_id,detail) VALUES(?,?,?,?,?,?)", (now(), actor, action, character_id, achievement_id, json.dumps(detail, sort_keys=True)))

    def add_character(self, value: dict[str, Any], actor: str | None) -> dict[str, Any]:
        stamp = now()
        realm_key = self._realm_key(value["realm"], value.get("realmSlug"))
        with self._connect() as db:
            row = db.execute("SELECT * FROM characters WHERE region=? AND lower(name)=lower(?) AND realm_key=?", (value["region"], value["name"], realm_key)).fetchone()
            if row:
                db.execute("UPDATE characters SET realm=?, realm_slug=COALESCE(?,realm_slug), realm_key=?, race=COALESCE(?,race), character_class=COALESCE(?,character_class), faction=COALESCE(?,faction), avatar_url=COALESCE(?,avatar_url), updated_at=? WHERE id=?", (value["realm"], value.get("realmSlug"), realm_key, value.get("race"), value.get("characterClass"), value.get("faction"), value.get("avatarUrl"), stamp, row["id"]))
            else:
                db.execute("INSERT INTO characters(region,realm,name,realm_slug,realm_key,race,character_class,faction,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", (value['region'],value['realm'],value['name'],value.get('realmSlug'),realm_key,value.get('race'),value.get('characterClass'),value.get('faction'),value.get('avatarUrl'),stamp,stamp))
            row=db.execute("SELECT * FROM characters WHERE region=? AND lower(name)=lower(?) AND realm_key=?",(value['region'],value['name'],realm_key)).fetchone()
            if actor:
                db.execute(
                    "INSERT INTO user_characters(user_id,character_id,created_at,last_used_at) VALUES(?,?,?,?) "
                    "ON CONFLICT(user_id,character_id) DO UPDATE SET last_used_at=excluded.last_used_at",
                    (actor, row['id'], stamp, stamp),
                )
            self._event(db,actor,'character_upsert',row['id'],None,value)
            return dict(row)

    def select_character(self, character_id: int, actor: str | None) -> dict[str, Any]:
        with self._connect() as db:
            row = self._character(db, character_id)
            if actor:
                stamp = now()
                db.execute(
                    "INSERT INTO user_characters(user_id,character_id,created_at,last_used_at) VALUES(?,?,?,?) "
                    "ON CONFLICT(user_id,character_id) DO UPDATE SET last_used_at=excluded.last_used_at",
                    (actor, character_id, stamp, stamp),
                )
                self._event(db, actor, 'character_selected', character_id, None, {})
            return dict(row)

    def forget_character(self, character_id: int, actor: str | None) -> dict[str, Any]:
        """Remove only one user's recent-character association."""
        if not actor:
            raise ValueError("sign in to remove a recent character")
        with self._connect() as db:
            row = self._character(db, character_id)
            removed = db.execute(
                "DELETE FROM user_characters WHERE user_id=? AND character_id=?",
                (actor, character_id),
            ).rowcount > 0
            if removed:
                self._event(db, actor, 'character_forgotten', character_id, None, {})
            return {'characterId': character_id, 'name': row['name'], 'removed': removed}

    def list_characters(self, actor: str | None = None) -> dict[str, Any]:
        with self._connect() as db:
            ownership_join = "JOIN user_characters uc ON uc.character_id=c.id AND uc.user_id=?" if actor else "LEFT JOIN user_characters uc ON 0"
            params = (actor, self._overlay_user(actor)) if actor else (self._overlay_user(actor),)
            rows = db.execute("""
                SELECT c.*,
                  COUNT(CASE WHEN a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction) THEN 1 END) achievementTotal,
                  SUM(CASE WHEN (ca.blizzard_confirmed_at IS NOT NULL OR ua.state='earned') AND (a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction)) THEN 1 ELSE 0 END) achievementEarned
                FROM characters c {ownership_join}
                LEFT JOIN character_achievements ca ON ca.character_id=c.id
                LEFT JOIN achievements a ON a.achievement_id=ca.achievement_id
                LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id
                GROUP BY c.id ORDER BY MAX(uc.last_used_at) DESC,c.active DESC,c.name COLLATE NOCASE
            """.format(ownership_join=ownership_join), params)
            characters=[]
            for row in rows:
                item=dict(row)
                item['completionPct']=round(100*item['achievementEarned']/item['achievementTotal']) if item['achievementTotal'] else 0
                characters.append(item)
            return {'characters':characters}

    def user_has_character(self, user_id: str | None, character_id: int) -> bool:
        """Anonymous development can inspect the catalogue; signed-in callers use their own chooser."""
        with self._connect() as db:
            self._character(db, character_id)
            if not user_id:
                return True
            return db.execute(
                "SELECT 1 FROM user_characters WHERE user_id=? AND character_id=?",
                (user_id, character_id),
            ).fetchone() is not None

    @staticmethod
    def _hammerlink_summary(row: sqlite3.Row) -> dict[str, Any]:
        snapshot = json.loads(row['snapshot_json'])
        currency_caps = snapshot.get('currencyCaps') if isinstance(snapshot, dict) else []
        currencies = snapshot.get('currencies') if isinstance(snapshot, dict) else {}
        currency_entries = currencies.get('entries') if isinstance(currencies, dict) else []
        reputations = snapshot.get('reputations') if isinstance(snapshot, dict) else {}
        reputation_entries = reputations.get('entries') if isinstance(reputations, dict) else []
        decor_inventory = snapshot.get('decorInventory') if isinstance(snapshot, dict) else {}
        decor_items = decor_inventory.get('items') if isinstance(decor_inventory, dict) else []
        quest_log = snapshot.get('questLog') if isinstance(snapshot, dict) else {}
        quest_entries = quest_log.get('entries') if isinstance(quest_log, dict) else []
        current_spellbook = snapshot.get('currentSpellbook') if isinstance(snapshot, dict) else {}
        current_spells = current_spellbook.get('spells') if isinstance(current_spellbook, dict) else []
        profession_recipes = snapshot.get('professionRecipes') if isinstance(snapshot, dict) else {}
        profession_lines = profession_recipes.get('professions') if isinstance(profession_recipes, dict) else []
        profession_recipe_count = sum(len(line.get('recipes', [])) for line in profession_lines if isinstance(line, dict)) if isinstance(profession_lines, list) else 0
        return {
            'importId': row['id'],
            'characterId': row['character_id'],
            'character': {
                'name': row['name'], 'realm': row['realm'], 'realmSlug': row['realm_slug'],
                'region': row['region'], 'characterClass': row['character_class'],
                'avatarUrl': row['avatar_url'],
            },
            'format': row['format'],
            'capturedAt': datetime.fromtimestamp(row['captured_at'], UTC).isoformat(),
            'importedAt': row['imported_at'],
            'payloadSha256': row['payload_sha256'],
            'equipmentCount': row['equipment_count'],
            # Database column retained for migration compatibility; the export
            # now holds every occupied bag slot, not only equippable gear.
            'bagItemCount': row['bag_equipment_count'],
            'vaultActivityCount': row['vault_activity_count'],
            'hasTalentImport': bool(row['has_talent_import']),
            'currencyCapCount': len(currency_caps) if isinstance(currency_caps, list) else 0,
            'currencyCount': len(currency_entries) if isinstance(currency_entries, list) else 0,
            'reputationCount': len(reputation_entries) if isinstance(reputation_entries, list) else 0,
            'decorItemCount': len(decor_items) if isinstance(decor_items, list) else 0,
            'questLogCount': len(quest_entries) if isinstance(quest_entries, list) else 0,
            'currentSpellCount': len(current_spells) if isinstance(current_spells, list) else 0,
            'professionRecipeCount': profession_recipe_count,
            'professionSkillLineCount': len(profession_lines) if isinstance(profession_lines, list) else 0,
            'equippedItemLevel': row['equipped_item_level'],
            'overallItemLevel': row['overall_item_level'],
            'provenance': 'in_game_export',
        }

    @staticmethod
    def _hammerlink_snapshot(serialised: str) -> dict[str, Any]:
        """Add player-facing ordering and Vault fields without altering stored client data."""
        snapshot = json.loads(serialised)
        currencies = snapshot.get('currencyCaps') if isinstance(snapshot, dict) else None
        if isinstance(currencies, list):
            def currency_order(item: Any) -> tuple[int, int, str, int]:
                if not isinstance(item, dict):
                    return (3, 0, '', 0)
                name = str(item.get('name') or '')
                words = name.casefold().split()
                for rank, tier in enumerate(HAMMERLINK_CURRENCY_TIERS):
                    if tier in words:
                        return (0, rank, name.casefold(), int(item.get('currencyID') or 0))
                folded = name.casefold()
                for rank, material in enumerate(HAMMERLINK_CURRENCY_MATERIALS):
                    if material in folded:
                        return (1, rank, folded, int(item.get('currencyID') or 0))
                return (2, 0, folded, int(item.get('currencyID') or 0))
            currencies.sort(key=currency_order)
        vault = snapshot.get('vault') if isinstance(snapshot, dict) else None
        activities = vault.get('activities') if isinstance(vault, dict) else None
        if not isinstance(activities, list):
            return snapshot
        for activity in activities:
            if not isinstance(activity, dict):
                continue
            activity_type = activity.get('type')
            activity['activityTypeName'] = HAMMERLINK_VAULT_ACTIVITY_TYPES.get(
                activity_type, f'Activity type {activity_type}'
            )
            progress = activity.get('progress')
            threshold = activity.get('threshold')
            if isinstance(progress, (int, float)) and not isinstance(progress, bool):
                activity['displayProgress'] = (
                    min(progress, threshold)
                    if isinstance(threshold, (int, float)) and not isinstance(threshold, bool) and threshold >= 0
                    else progress
                )
                activity['isComplete'] = bool(
                    isinstance(threshold, (int, float))
                    and not isinstance(threshold, bool)
                    and threshold > 0
                    and progress >= threshold
                )
        return snapshot

    def save_hammerlink_import(self, user_id: str, character_id: int, snapshot: dict[str, Any]) -> dict[str, Any]:
        if not user_id:
            raise ValueError('authentication is required to save a HammerLink import')
        character = snapshot.get('character') if isinstance(snapshot, dict) else None
        equipment = snapshot.get('equipment', []) if isinstance(snapshot, dict) else None
        bag_equipment = snapshot.get('bagEquipment', []) if isinstance(snapshot, dict) else None
        vault = snapshot.get('vault', {}) if isinstance(snapshot, dict) else None
        talents = snapshot.get('talents', {}) if isinstance(snapshot, dict) else None
        if not isinstance(character, dict) or not isinstance(equipment, list) or not isinstance(bag_equipment, list) or not isinstance(vault, dict) or not isinstance(talents, dict):
            raise ValueError('HammerLink snapshot is incomplete')
        captured_at = snapshot.get('capturedAt')
        if not isinstance(captured_at, int) or captured_at < 1:
            raise ValueError('HammerLink capture time is invalid')
        serialised = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        if len(serialised.encode('utf-8')) > HAMMERLINK_MAX_SNAPSHOT_BYTES:
            raise ValueError('HammerLink snapshot is too large')
        stamp = now()
        payload_sha256 = hashlib.sha256(serialised.encode('utf-8')).hexdigest()
        with self._connect() as db:
            self._character(db, character_id)
            if not db.execute('SELECT 1 FROM user_characters WHERE user_id=? AND character_id=?', (user_id, character_id)).fetchone():
                raise ValueError('character is not attached to this account')
            db.execute(
                """INSERT INTO hammerlink_imports(
                     user_id,character_id,format,captured_at,imported_at,payload_sha256,
                     equipment_count,bag_equipment_count,vault_activity_count,has_talent_import,
                     equipped_item_level,overall_item_level,snapshot_json
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(user_id,character_id,payload_sha256) DO UPDATE SET
                     imported_at=excluded.imported_at""",
                (
                    user_id, character_id, int(snapshot.get('format') or 0), captured_at, stamp,
                    payload_sha256, len(equipment), len(bag_equipment),
                    len(vault.get('activities') or []), bool(talents.get('importString')),
                    character.get('equippedItemLevel'), character.get('overallItemLevel'), serialised,
                ),
            )
            import_id = db.execute(
                "SELECT id FROM hammerlink_imports WHERE user_id=? AND character_id=? AND payload_sha256=?",
                (user_id, character_id, payload_sha256),
            ).fetchone()['id']
            db.execute(
                """DELETE FROM hammerlink_imports
                   WHERE user_id=? AND character_id=? AND id NOT IN (
                     SELECT id FROM hammerlink_imports
                     WHERE user_id=? AND character_id=?
                     ORDER BY imported_at DESC,id DESC LIMIT ?
                   )""",
                (user_id, character_id, user_id, character_id, HAMMERLINK_HISTORY_PER_CHARACTER),
            )
            self._event(db, user_id, 'hammerlink_import_saved', character_id, None, {
                'capturedAt': captured_at, 'equipmentCount': len(equipment),
                'bagItemCount': len(bag_equipment), 'vaultActivityCount': len(vault.get('activities') or []),
            })
        return self.hammerlink_import_version(user_id, import_id)

    def list_hammerlink_imports(self, user_id: str) -> dict[str, Any]:
        if not user_id:
            raise ValueError('authentication is required to read HammerLink imports')
        with self._connect() as db:
            rows = db.execute("""
              SELECT hi.*,c.name,c.realm,c.realm_slug,c.region,c.character_class,c.avatar_url
              FROM hammerlink_imports hi JOIN characters c ON c.id=hi.character_id
              WHERE hi.user_id=? AND hi.id=(
                SELECT latest.id FROM hammerlink_imports latest
                WHERE latest.user_id=hi.user_id AND latest.character_id=hi.character_id
                ORDER BY latest.imported_at DESC,latest.id DESC LIMIT 1
              )
              ORDER BY hi.imported_at DESC,c.name COLLATE NOCASE
            """, (user_id,)).fetchall()
            return {'imports': [self._hammerlink_summary(row) for row in rows]}

    def list_hammerlink_import_history(self, user_id: str) -> dict[str, Any]:
        if not user_id:
            raise ValueError('authentication is required to read HammerLink imports')
        with self._connect() as db:
            rows = db.execute("""
              SELECT hi.*,c.name,c.realm,c.realm_slug,c.region,c.character_class,c.avatar_url
              FROM hammerlink_imports hi JOIN characters c ON c.id=hi.character_id
              WHERE hi.user_id=? ORDER BY hi.imported_at DESC,hi.id DESC
            """, (user_id,)).fetchall()
            return {'imports': [self._hammerlink_summary(row) for row in rows]}

    def hammerlink_import(self, user_id: str, character_id: int) -> dict[str, Any]:
        if not user_id:
            raise ValueError('authentication is required to read a HammerLink import')
        with self._connect() as db:
            row = db.execute("""
              SELECT hi.*,c.name,c.realm,c.realm_slug,c.region,c.character_class,c.avatar_url
              FROM hammerlink_imports hi JOIN characters c ON c.id=hi.character_id
              WHERE hi.user_id=? AND hi.character_id=?
              ORDER BY hi.imported_at DESC,hi.id DESC LIMIT 1
            """, (user_id, character_id)).fetchone()
            if not row:
                raise ValueError('HammerLink import was not found for this account and character')
            return {**self._hammerlink_summary(row), 'snapshot': self._hammerlink_snapshot(row['snapshot_json'])}

    def hammerlink_import_version(self, user_id: str, import_id: int) -> dict[str, Any]:
        if not user_id:
            raise ValueError('authentication is required to read a HammerLink import')
        with self._connect() as db:
            row = db.execute("""
              SELECT hi.*,c.name,c.realm,c.realm_slug,c.region,c.character_class,c.avatar_url
              FROM hammerlink_imports hi JOIN characters c ON c.id=hi.character_id
              WHERE hi.user_id=? AND hi.id=?
            """, (user_id, import_id)).fetchone()
            if not row:
                raise ValueError('HammerLink import was not found for this account')
            return {**self._hammerlink_summary(row), 'snapshot': self._hammerlink_snapshot(row['snapshot_json'])}

    @staticmethod
    def _recent_achievements(db: sqlite3.Connection, character_id: int, limit: int = 5) -> list[dict[str, Any]]:
        return [dict(row) for row in db.execute("""
          SELECT a.achievement_id achievementId,a.name,a.points,a.icon_url iconUrl,ca.earned_at earnedAt
          FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id
          WHERE ca.character_id=? AND ca.state='earned' AND ca.earned_at IS NOT NULL
            AND ca.blizzard_confirmed_at IS NOT NULL
          ORDER BY ca.earned_at DESC,a.achievement_id DESC LIMIT ?
        """, (character_id, limit))]

    def character_summary(self, character_id: int, actor: str | None = None) -> dict[str, Any]:
        user_id = self._overlay_user(actor)
        with self._connect() as db:
            self._character(db, character_id)
            row=db.execute("""
              SELECT COUNT(*) achievementTotal,
                SUM(CASE WHEN ca.blizzard_confirmed_at IS NOT NULL OR ua.state='earned' THEN 1 ELSE 0 END) achievementEarned,
                COALESCE(SUM(CASE WHEN ca.blizzard_confirmed_at IS NOT NULL OR ua.state='earned' THEN COALESCE(a.points,0) ELSE 0 END),0) pointsEarned,
                COALESCE(SUM(COALESCE(a.points,0)),0) pointsTotal
              FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id
              JOIN characters c ON c.id=ca.character_id
              LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id
              WHERE ca.character_id=? AND (a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction))
            """,(user_id,character_id)).fetchone()
            result=dict(row)
            result['factionUnavailable']=db.execute("""
              SELECT COUNT(*) FROM character_achievements ca
              JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id
              WHERE ca.character_id=? AND a.required_faction IS NOT NULL AND c.faction IS NOT NULL
                AND UPPER(a.required_faction)<>UPPER(c.faction)
            """,(character_id,)).fetchone()[0]
            result['completionPct']=round(100*result['achievementEarned']/result['achievementTotal']) if result['achievementTotal'] else 0
            result['recentAchievements']=self._recent_achievements(db, character_id)
            return result

    def facets(self, character_id: int, actor: str | None = None) -> dict[str, Any]:
        user_id = self._overlay_user(actor)
        with self._connect() as db:
            self._character(db, character_id)
            available = "(a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction))"
            joins = "FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id"
            effective_state = "CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(ua.state,ca.state) END"
            def values(expression: str, where: str="1=1") -> list[dict[str, Any]]:
                return [dict(row) for row in db.execute(f"SELECT {expression} value,COUNT(*) count {joins} WHERE ca.character_id=? AND {available} AND {where} GROUP BY {expression} ORDER BY {expression} COLLATE NOCASE",(user_id,character_id))]
            return {
              'status':values(effective_state),
              'expansion':values('a.added_expansion',"a.added_expansion IS NOT NULL"),
              'patch':values('a.added_patch',"a.added_patch IS NOT NULL"),
              'category':values('a.category',"a.category IS NOT NULL AND a.category<>''"),
              'reward':values("CASE WHEN a.reward_type IS NULL AND (a.reward_description IS NULL OR a.reward_description='') THEN 'none' ELSE COALESCE(a.reward_type,'other') END"),
              'priority':values('COALESCE(ua.priority,0)'),
              'source':[
                {'value':'manual_confirmation','count':db.execute(f"SELECT COUNT(*) {joins} WHERE ca.character_id=? AND {available} AND {effective_state}='earned' AND ua.marked_done_at IS NOT NULL",(user_id,character_id)).fetchone()[0]},
                {'value':'blizzard','count':db.execute(f"SELECT COUNT(*) {joins} WHERE ca.character_id=? AND {available} AND {effective_state}='earned' AND ca.blizzard_confirmed_at IS NOT NULL",(user_id,character_id)).fetchone()[0]},
              ],
            }

    def character_identity(self, character_id: int) -> dict[str, Any]:
        with self._connect() as db:
            row = self._character(db, character_id)
            return {"region": row["region"], "realm": row["realm_slug"] or self._realm_key(row["realm"]), "name": row["name"]}

    def record_blizzard_recent(self, character_id: int, achievements: list[dict[str, Any]], actor: str | None) -> dict[str, Any]:
        """Record only achievement events explicitly returned by Blizzard."""
        stamp = now(); recorded = 0
        with self._connect() as db:
            self._character(db, character_id)
            for item in achievements:
                achievement_id = item.get("id")
                if not isinstance(achievement_id, int):
                    continue
                db.execute("INSERT INTO achievements(achievement_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(achievement_id) DO UPDATE SET name=COALESCE(NULLIF(excluded.name,''),achievements.name),updated_at=excluded.updated_at", (achievement_id, str(item.get("name") or ""), stamp, stamp))
                db.execute("INSERT INTO character_achievements(character_id,achievement_id,state,earned_at,source,blizzard_confirmed_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(character_id,achievement_id) DO UPDATE SET state='earned',earned_at=COALESCE(excluded.earned_at,character_achievements.earned_at),source='blizzard',blizzard_confirmed_at=excluded.blizzard_confirmed_at,updated_at=excluded.updated_at", (character_id, achievement_id, "earned", item.get("completedAt"), "blizzard", stamp, stamp))
                recorded += 1
            db.execute("UPDATE characters SET last_blizzard_refresh_at=?, updated_at=? WHERE id=?", (stamp, stamp, character_id))
            self._event(db, actor, "achievement_refresh_blizzard_recent", character_id, None, {"recorded": recorded})
        return {"characterId": character_id, "recordedRecentEarned": recorded, "scope": "recent_events_only"}

    def record_blizzard_progress(self, character_id: int, achievements: list[dict[str, Any]], actor: str | None) -> int:
        """Overlay Blizzard completion and criterion progress on the global catalogue."""
        stamp = now(); recorded = 0
        with self._connect() as db:
            self._character(db, character_id)
            db.execute(
                "INSERT OR IGNORE INTO character_achievements(character_id,achievement_id,state,source,updated_at) "
                "SELECT ?,achievement_id,'unearned','catalogue',? FROM achievements WHERE blizzard_metadata_error_at IS NULL",
                (character_id, stamp),
            )
            for item in achievements:
                aid = item.get('id')
                if not isinstance(aid, int):
                    continue
                completed_at = item.get('completedAt')
                static = db.execute("SELECT criteria_json FROM achievements WHERE achievement_id=?", (aid,)).fetchone()
                derived_state = self._meta_progress_state(static['criteria_json'] if static else None, item.get('criteria'))
                result = db.execute(
                    "UPDATE character_achievements SET criteria_progress_json=?,"
                    "state=CASE WHEN ? IS NOT NULL THEN 'earned' WHEN state='earned' THEN state WHEN ? IS NOT NULL THEN ? ELSE state END,"
                    "earned_at=COALESCE(?,earned_at),"
                    "source=CASE WHEN (? IS NOT NULL OR ? IS NOT NULL) THEN 'blizzard' ELSE source END,"
                    "blizzard_confirmed_at=CASE WHEN ? IS NOT NULL THEN ? ELSE blizzard_confirmed_at END,updated_at=? "
                    "WHERE character_id=? AND achievement_id=?",
                    (json.dumps(item.get('criteria')) if item.get('criteria') else None,
                     completed_at, derived_state, derived_state, completed_at, completed_at, derived_state,
                     completed_at, stamp, stamp, character_id, aid),
                )
                recorded += result.rowcount
            self._event(db, actor, 'achievement_progress_blizzard', character_id, None, {'recorded': recorded})
        return recorded

    def record_blizzard_unearned(self, character_id: int, achievement_ids: list[int], actor: str | None) -> dict[str, Any]:
        """Mark only returned, no-timestamp achievements as unearned.

        IDs absent from the profile are intentionally not touched: the public
        inspection response does not make absence authoritative.
        """
        stamp = now(); recorded = 0
        with self._connect() as db:
            self._character(db, character_id)
            for achievement_id in set(achievement_ids):
                row = db.execute("SELECT state FROM character_achievements WHERE character_id=? AND achievement_id=?", (character_id, achievement_id)).fetchone()
                if not row or row["state"] == "earned":
                    continue
                db.execute("UPDATE character_achievements SET state='unearned', source='blizzard', updated_at=? WHERE character_id=? AND achievement_id=?", (stamp, character_id, achievement_id))
                recorded += 1
            self._event(db, actor, "achievement_reconcile_blizzard_unearned", character_id, None, {"recorded": recorded})
        return {"characterId": character_id, "recordedUnearned": recorded, "scope": "returned_without_completion_timestamp"}

    def set_priority(self, character_id: int, achievement_id: int, priority: int, actor: str | None) -> dict[str, Any]:
        stamp = now(); user_id = self._overlay_user(actor)
        with self._connect() as db:
            self._character(db, character_id)
            db.execute("INSERT INTO achievements(achievement_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(achievement_id) DO NOTHING",(achievement_id,f'Achievement {achievement_id}',stamp,stamp))
            db.execute("INSERT INTO character_achievements(character_id,achievement_id,updated_at) VALUES(?,?,?) ON CONFLICT(character_id,achievement_id) DO NOTHING",(character_id,achievement_id,stamp))
            db.execute("INSERT INTO user_achievement_overlays(user_id,character_id,achievement_id,priority,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id,character_id,achievement_id) DO UPDATE SET priority=excluded.priority,updated_at=excluded.updated_at",(user_id,character_id,achievement_id,priority,stamp))
            self._event(db,actor,'achievement_set_priority',character_id,achievement_id,{'priority':priority})
            return {'characterId':character_id,'achievementId':achievement_id,'priority':priority}

    def update_state(self, value: dict[str, Any], actor: str | None) -> dict[str, Any]:
        cid, aid=value['characterId'],value['achievementId']
        state=value['state']; source=value.get('source','manual')
        earned_at = (value.get('earnedAt') or now()) if state == 'earned' else None
        if state == 'earned' and source not in ('manual_confirmation','blizzard'):
            raise ValueError("earned requires source manual_confirmation or blizzard")
        stamp = now(); user_id = self._overlay_user(actor)
        with self._connect() as db:
            self._character(db,cid)
            db.execute("INSERT INTO achievements(achievement_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(achievement_id) DO NOTHING",(aid,f'Achievement {aid}',stamp,stamp))
            marked_done_at = earned_at if state == 'earned' and source == 'manual_confirmation' else None
            db.execute("INSERT INTO character_achievements(character_id,achievement_id,updated_at) VALUES(?,?,?) ON CONFLICT(character_id,achievement_id) DO NOTHING",(cid,aid,stamp))
            if source == 'blizzard':
                db.execute("UPDATE character_achievements SET state=?,earned_at=?,progress_current=?,progress_target=?,source='blizzard',blizzard_confirmed_at=CASE WHEN ?='earned' THEN ? ELSE blizzard_confirmed_at END,updated_at=? WHERE character_id=? AND achievement_id=?",(state,earned_at,value.get('progressCurrent'),value.get('progressTarget'),state,stamp,stamp,cid,aid))
            else:
                db.execute("INSERT INTO user_achievement_overlays(user_id,character_id,achievement_id,state,earned_at,marked_done_at,progress_current,progress_target,note,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,character_id,achievement_id) DO UPDATE SET state=excluded.state,earned_at=excluded.earned_at,marked_done_at=excluded.marked_done_at,progress_current=excluded.progress_current,progress_target=excluded.progress_target,note=COALESCE(excluded.note,user_achievement_overlays.note),source=excluded.source,updated_at=excluded.updated_at",(user_id,cid,aid,state,earned_at,marked_done_at,value.get('progressCurrent'),value.get('progressTarget'),value.get('note'),source,stamp))
            self._event(db,actor,'achievement_update_state',cid,aid,value)
            return {'characterId':cid,'achievementId':aid,'state':state,'source':source,'earnedAt':earned_at}

    def curate(self, value: dict[str, Any], actor: str | None) -> dict[str, Any]:
        aid=value['achievementId']; stamp=now()
        allowed=('whatToDo','fastestPathTip','estimatedMinutes','difficulty','groupRequirement','availability','availabilityReason','nextAvailableAt','deadline','deadlineReason','zone','expansion','season','event','reward','sourceName','sourceUrl','verifiedAt','expiresAt')
        columns={'whatToDo':'what_to_do','fastestPathTip':'fastest_path_tip','estimatedMinutes':'estimated_minutes','difficulty':'difficulty','groupRequirement':'group_requirement','availability':'availability','availabilityReason':'availability_reason','nextAvailableAt':'next_available_at','deadline':'deadline','deadlineReason':'deadline_reason','zone':'zone','expansion':'expansion','season':'season','event':'event','reward':'reward','sourceName':'source_name','sourceUrl':'source_url','verifiedAt':'verified_at','expiresAt':'expires_at'}
        with self._connect() as db:
            db.execute("INSERT INTO achievements(achievement_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(achievement_id) DO NOTHING",(aid,value.get('name',f'Achievement {aid}'),stamp,stamp))
            keys=[key for key in allowed if key in value]; vals=[value[k] for k in keys]
            db.execute(f"INSERT INTO curated_metadata(achievement_id,{','.join(columns[k] for k in keys)},updated_at) VALUES({','.join('?' for _ in range(len(keys)+2))}) ON CONFLICT(achievement_id) DO UPDATE SET {','.join(columns[k]+'=excluded.'+columns[k] for k in keys)},updated_at=excluded.updated_at", [aid,*vals,stamp])
            self._event(db,actor,'achievement_curate',None,aid,{k:value[k] for k in keys})
            return {'achievementId':aid,'curated':True,'updatedAt':stamp}

    def upsert_blizzard_metadata(self, records: list[dict[str, Any]], actor: str | None) -> dict[str, int]:
        """Store only fields returned by Blizzard for achievements we already track."""
        stamp = now(); updated = 0
        with self._connect() as db:
            for record in records:
                aid = record.get('achievementId')
                if not isinstance(aid, int) or not isinstance(record.get('name'), str):
                    continue
                result = db.execute(
                    "UPDATE achievements SET name=?, points=?, category=?, description=?, criteria_json=?, required_faction=?, is_account_wide=?, reward_description=?, reward_type=?, reward_url=?, reward_item_id=?, reward_item_name=?, reward_item_icon_url=COALESCE(?,reward_item_icon_url), icon_url=COALESCE(?,icon_url), blizzard_fetched_at=?, blizzard_metadata_error_at=NULL, blizzard_metadata_error=NULL, blizzard_metadata_version=?, updated_at=? WHERE achievement_id=?",
                    (record['name'], record.get('points'), record.get('category'), record.get('description'), json.dumps(record.get('criteria')) if record.get('criteria') else None, record.get('requiredFaction'), int(bool(record.get('isAccountWide'))), record.get('rewardDescription'), record.get('rewardType'), record.get('rewardUrl'), record.get('rewardItemId'), record.get('rewardItemName'), record.get('rewardItemIconUrl'), record.get('iconUrl'), stamp, BLIZZARD_METADATA_VERSION, stamp, aid),
                )
                updated += result.rowcount
                # A meta achievement's criteria can contain direct achievement
                # references and nested criterion groups. Store every referenced
                # achievement as a dependency; its own static record will supply
                # any deeper branch when the global metadata queue reaches it.
                dependencies: dict[int, str] = {}
                def visit(criteria: Any) -> None:
                    if not isinstance(criteria, dict):
                        return
                    achievement = criteria.get('achievement')
                    if isinstance(achievement, dict) and isinstance(achievement.get('id'), int):
                        dependencies[achievement['id']] = str(achievement.get('name') or criteria.get('description') or f"Achievement {achievement['id']}")
                    for child in criteria.get('child_criteria') or []:
                        visit(child)
                visit(record.get('criteria'))
                db.execute("DELETE FROM achievement_dependencies WHERE achievement_id=?", (aid,))
                for dependency_id, dependency_name in dependencies.items():
                    if dependency_id == aid:
                        continue
                    db.execute("INSERT INTO achievements(achievement_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(achievement_id) DO UPDATE SET name=COALESCE(NULLIF(achievements.name,''),excluded.name),updated_at=excluded.updated_at", (dependency_id, dependency_name, stamp, stamp))
                    db.execute("INSERT OR IGNORE INTO achievement_dependencies(achievement_id,depends_on_id) VALUES(?,?)", (aid, dependency_id))
            self._event(db, actor, 'achievement_metadata_blizzard', None, None, {'updated': updated})
        return {'updated': updated}

    def achievement_ids_without_blizzard_metadata(self, limit: int) -> list[int]:
        with self._connect() as db:
            return [row[0] for row in db.execute("SELECT achievement_id FROM achievements WHERE blizzard_metadata_version<? AND blizzard_metadata_error_at IS NULL ORDER BY achievement_id LIMIT ?", (BLIZZARD_METADATA_VERSION, limit))]

    def record_unavailable_blizzard_metadata(self, records: list[dict[str, Any]], actor: str | None) -> int:
        """Stop retrying achievement IDs Blizzard explicitly says do not exist."""
        stamp = now()
        unavailable = [record for record in records if isinstance(record.get('achievementId'), int) and record.get('error') == 'upstream_not_found']
        if not unavailable:
            return 0
        with self._connect() as db:
            db.executemany(
                "UPDATE achievements SET blizzard_metadata_error_at=?, blizzard_metadata_error=?, updated_at=? WHERE achievement_id=? AND blizzard_fetched_at IS NULL",
                [(stamp, record['error'], stamp, record['achievementId']) for record in unavailable],
            )
            self._event(db, actor, 'achievement_metadata_blizzard_unavailable', None, None, {'count': len(unavailable)})
        return len(unavailable)

    def categories(self, character_id: int) -> dict[str, list[str]]:
        with self._connect() as db:
            self._character(db, character_id)
            rows = db.execute("SELECT DISTINCT a.category FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id WHERE ca.character_id=? AND (a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction)) AND a.category IS NOT NULL AND a.category<>'' ORDER BY a.category COLLATE NOCASE", (character_id,))
            return {'categories': [row[0] for row in rows]}

    def release_options(self, character_id: int) -> dict[str, list[str]]:
        with self._connect() as db:
            self._character(db, character_id)
            available = "(a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction))"
            expansions = db.execute(f"SELECT DISTINCT a.added_expansion FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id WHERE ca.character_id=? AND {available} AND a.added_expansion IS NOT NULL ORDER BY a.added_expansion COLLATE NOCASE", (character_id,))
            patches = db.execute(f"SELECT DISTINCT a.added_patch FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id WHERE ca.character_id=? AND {available} AND a.added_patch IS NOT NULL", (character_id,))
            patch_values = [row[0] for row in patches]
            patch_values.sort(key=lambda value: tuple(int(part) for part in value.split('.')), reverse=True)
            return {'expansions': [row[0] for row in expansions], 'patches': patch_values}

    def upsert_wowhead_release_metadata(self, records: list[dict[str, Any]]) -> dict[str, int]:
        stamp = now(); updated = 0
        with self._connect() as db:
            for record in records:
                achievement_id = record.get('achievementId')
                if not isinstance(achievement_id, int):
                    continue
                result = db.execute(
                    "UPDATE achievements SET added_expansion=?,added_patch=?,wowhead_release_fetched_at=?,updated_at=? WHERE achievement_id=?",
                    (record.get('addedExpansion'), record.get('addedPatch'), stamp, stamp, achievement_id),
                )
                updated += result.rowcount
        return {'updated': updated}

    def achievement_requirements(self, character_id: int, achievement_id: int, actor: str | None = None) -> dict[str, Any]:
        """Return a character-aware meta-achievement tree from Blizzard criteria."""
        user_id = self._overlay_user(actor)
        with self._connect() as db:
            self._character(db, character_id)
            root = db.execute(
                "SELECT a.*,CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(ua.state,ca.state) END state,CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN ca.earned_at ELSE ua.earned_at END earnedAt,ca.criteria_progress_json FROM achievements a LEFT JOIN character_achievements ca ON ca.achievement_id=a.achievement_id AND ca.character_id=? LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id WHERE a.achievement_id=?",
                (character_id, user_id, achievement_id),
            ).fetchone()
            if not root:
                return {'achievementId': achievement_id, 'children': []}

            def decoded(value: str | None) -> dict[str, Any]:
                try:
                    result = json.loads(value) if value else {}
                    return result if isinstance(result, dict) else {}
                except json.JSONDecodeError:
                    return {}

            def progress_index(criteria: dict[str, Any]) -> dict[int, dict[str, Any]]:
                result: dict[int, dict[str, Any]] = {}
                def visit(node: Any) -> None:
                    if not isinstance(node, dict): return
                    if isinstance(node.get('id'), int): result[node['id']] = node
                    for child in node.get('child_criteria') or []: visit(child)
                visit(criteria)
                return result

            root_progress = progress_index(decoded(root['criteria_progress_json']))
            def render(nodes: list[Any], progress: dict[int, dict[str, Any]], ancestors: set[int], depth: int) -> list[dict[str, Any]]:
                if depth >= 6: return []
                items=[]
                for node in nodes:
                    if not isinstance(node, dict): continue
                    criterion_id=node.get('id')
                    current=progress.get(criterion_id, {})
                    achievement=node.get('achievement') if isinstance(node.get('achievement'), dict) else {}
                    child_id=achievement.get('id') if isinstance(achievement.get('id'), int) else None
                    tracked_state = None
                    if child_id:
                        tracked = db.execute("SELECT CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(ua.state,ca.state) END state FROM character_achievements ca LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id WHERE ca.character_id=? AND ca.achievement_id=?", (user_id, character_id, child_id)).fetchone()
                        tracked_state = tracked['state'] if tracked else None
                    item={
                        'criterionId': criterion_id,
                        'achievementId': child_id,
                        'name': achievement.get('name') or node.get('description') or 'Requirement',
                        'completed': bool(current.get('is_completed')) or tracked_state == 'earned',
                        'progressCurrent': current.get('amount'),
                        'progressTarget': node.get('amount'),
                        'children': render(node.get('child_criteria') or [], progress, ancestors, depth + 1),
                    }
                    if child_id and child_id not in ancestors and not item['children']:
                        child=db.execute("SELECT a.criteria_json,ca.criteria_progress_json FROM achievements a LEFT JOIN character_achievements ca ON ca.achievement_id=a.achievement_id AND ca.character_id=? WHERE a.achievement_id=?", (character_id, child_id)).fetchone()
                        if child:
                            child_static=decoded(child['criteria_json'])
                            child_progress=progress_index(decoded(child['criteria_progress_json']))
                            item['children']=render(child_static.get('child_criteria') or [], child_progress, ancestors | {child_id}, depth + 1)
                    items.append(item)
                return items

            static=decoded(root['criteria_json'])
            return {
                'achievementId': achievement_id, 'name': root['name'], 'points': root['points'],
                'description': root['description'], 'isAccountWide': bool(root['is_account_wide']),
                'requiredFaction': root['required_faction'],
                'rewardDescription': root['reward_description'], 'rewardType': root['reward_type'],
                'rewardUrl': root['reward_url'], 'rewardItemId': root['reward_item_id'],
                'rewardItemName': root['reward_item_name'], 'rewardItemIconUrl': root['reward_item_icon_url'], 'iconUrl': root['icon_url'],
                'state': root['state'] or 'unknown', 'earnedAt': root['earnedAt'],
                'children': render(static.get('child_criteria') or [], root_progress, {achievement_id}, 0),
            }

    def achievement_has_blizzard_metadata(self, achievement_id: int) -> bool:
        with self._connect() as db:
            row = db.execute("SELECT blizzard_metadata_version>=? FROM achievements WHERE achievement_id=?", (BLIZZARD_METADATA_VERSION, achievement_id)).fetchone()
            return bool(row and row[0])

    def achievement_has_tooltip_metadata(self, achievement_id: int) -> bool:
        with self._connect() as db:
            row = db.execute("SELECT blizzard_metadata_version>=? AND icon_url IS NOT NULL AND (reward_item_id IS NULL OR reward_item_icon_url IS NOT NULL) FROM achievements WHERE achievement_id=?", (BLIZZARD_METADATA_VERSION, achievement_id)).fetchone()
            return bool(row and row[0])

    def priority_labels(self, character_id: int) -> dict[str, list[dict[str, Any]]]:
        with self._connect() as db:
            self._character(db, character_id)
            return {'labels': [dict(row) for row in db.execute('SELECT priority,label FROM character_priority_labels WHERE character_id=? ORDER BY priority DESC', (character_id,))]}

    def user_priority_labels(self, user_id: str | None) -> dict[str, list[dict[str, Any]]]:
        defaults = [(100, 'Do now'), (50, 'This week'), (0, 'Soon'), (-50, 'Someday')]
        with self._connect() as db:
            rows = [dict(row) for row in db.execute('SELECT priority,label FROM user_priority_labels WHERE user_id=? ORDER BY priority DESC', (user_id,))] if user_id else []
        return {'labels': rows or [{'priority': priority, 'label': label} for priority, label in defaults]}

    def priority_labels_for_user_or_character(self, user_id: str | None, character_id: int | None) -> dict[str, list[dict[str, Any]]]:
        """Use a saved user legend first, with a local legacy-character fallback.

        The fallback preserves imported spreadsheet labels while a signed-in
        user's personal legend has not yet been seeded. It never overrides a
        saved user legend.
        """
        with self._connect() as db:
            user_labels = [dict(row) for row in db.execute('SELECT priority,label FROM user_priority_labels WHERE user_id=? ORDER BY priority DESC', (user_id,))] if user_id else []
        if user_labels:
            return {'labels': user_labels}
        if character_id:
            legacy = self.priority_labels(character_id)
            if legacy['labels']:
                return legacy
        return self.user_priority_labels(None)

    def set_user_priority_labels(self, user_id: str, labels: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        if not user_id:
            raise ValueError('authenticated user required')
        if not isinstance(labels, list) or not 1 <= len(labels) <= 12:
            raise ValueError('provide between 1 and 12 priority labels')
        clean: list[tuple[int, str]] = []
        for item in labels:
            if not isinstance(item, dict) or isinstance(item.get('priority'), bool):
                raise ValueError('each priority label must have an integer priority and text label')
            priority = item.get('priority')
            label = item.get('label')
            if not isinstance(priority, int) or not -100 <= priority <= 100:
                raise ValueError('priority labels must be between -100 and 100')
            if not isinstance(label, str) or not (label := label.strip()) or len(label) > 80:
                raise ValueError('priority labels must be 1 to 80 characters')
            clean.append((priority, label))
        if len({priority for priority, _ in clean}) != len(clean):
            raise ValueError('priority label values must be unique')
        with self._connect() as db:
            db.execute('DELETE FROM user_priority_labels WHERE user_id=?', (user_id,))
            db.executemany('INSERT INTO user_priority_labels(user_id,priority,label) VALUES(?,?,?)', [(user_id, priority, label) for priority, label in clean])
            self._event(db, user_id, 'achievement_priority_labels_set', None, None, {'count': len(clean)})
        return self.user_priority_labels(user_id)

    def list_achievements(self, value: dict[str, Any]) -> dict[str, Any]:
        user_id = self._overlay_user(value.get('actor'))
        comparison_id = value.get('compareCharacterId')
        needed_by_both = bool(value.get('neededByBoth'))
        if needed_by_both and not comparison_id:
            raise ValueError('neededByBoth requires compareCharacterId')
        if comparison_id == value['characterId']:
            raise ValueError('comparison character must differ from the primary character')
        comparison_join = ''
        comparison_select = "NULL comparisonState,NULL comparisonEarnedAt,NULL comparisonProgressCurrent,NULL comparisonProgressTarget"
        comparison_params: list[Any] = [user_id]
        if comparison_id:
            comparison_join = "LEFT JOIN character_achievements cca ON cca.achievement_id=a.achievement_id AND cca.character_id=? LEFT JOIN characters cc ON cc.id=? LEFT JOIN user_achievement_overlays uca ON uca.character_id=cca.character_id AND uca.achievement_id=cca.achievement_id AND uca.user_id=?"
            comparison_select = "CASE WHEN cca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(uca.state,cca.state,'unknown') END comparisonState,CASE WHEN cca.blizzard_confirmed_at IS NOT NULL THEN cca.earned_at ELSE uca.earned_at END comparisonEarnedAt,COALESCE(uca.progress_current,cca.progress_current) comparisonProgressCurrent,COALESCE(uca.progress_target,cca.progress_target) comparisonProgressTarget"
            comparison_params.extend((comparison_id, comparison_id, user_id))
        effective_state = "CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(ua.state,ca.state) END"
        effective_priority = "COALESCE(ua.priority,0)"
        legacy_order={'priority':f'{effective_priority} DESC, a.name COLLATE NOCASE','new':'a.created_at DESC','expiring':'cm.deadline ASC','updated':'COALESCE(ua.updated_at,ca.updated_at) DESC'}[value.get('order','priority')]
        sort_columns={
            'done': f"CASE WHEN {effective_state}='earned' THEN 1 ELSE 0 END", 'priority':effective_priority, 'name':'a.name COLLATE NOCASE',
            'points':'a.points', 'category':'a.category COLLATE NOCASE', 'description':"COALESCE(a.description,'') COLLATE NOCASE", 'whatToDo':"COALESCE(cm.what_to_do,cm.fastest_path_tip,'') COLLATE NOCASE",
            'state':effective_state, 'earnedAt':"CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN ca.earned_at ELSE ua.earned_at END", 'note':"COALESCE(ua.note,'') COLLATE NOCASE", 'updated':'COALESCE(ua.updated_at,ca.updated_at)'
        }
        if comparison_id: sort_columns['comparisonState'] = 'cca.state'
        sort_by=value.get('sortBy')
        sort_direction='DESC' if value.get('sortDir')=='desc' else 'ASC'
        order=f"{sort_columns[sort_by]} {sort_direction}, a.achievement_id" if sort_by in sort_columns else legacy_order
        clauses=['ca.character_id=?']; params: list[Any]=[value['characterId']]
        include_unavailable = bool(value.get('includeUnavailable') or (value.get('filters') or {}).get('includeUnavailable'))
        if not include_unavailable:
            clauses.append("(a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction))")
            if comparison_id:
                clauses.append("(a.required_faction IS NULL OR cc.faction IS NULL OR UPPER(a.required_faction)=UPPER(cc.faction))")
        if needed_by_both:
            actionable = "('unearned','in_progress','completion_ready')"
            comparison_state = "CASE WHEN cca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(uca.state,cca.state,'unknown') END"
            clauses.extend((f"{effective_state} IN {actionable}", f"{comparison_state} IN {actionable}"))
        if value.get('state'): clauses.append(f'{effective_state}=?'); params.append(value['state'])
        if value.get('onlyUnexpired'): clauses.append("(cm.expires_at IS NULL OR cm.expires_at >= ?)"); params.append(now())
        if value.get('order')=='expiring': clauses.append("cm.deadline IS NOT NULL AND cm.deadline >= ?"); params.append(now())
        filters=value.get('filters') or {}
        exclude_pvp = bool(filters.get('excludePvp') or value.get('excludePvp'))
        if exclude_pvp:
            clauses.append("(' > ' || COALESCE(a.category,'') || ' > ') NOT LIKE '% > Player vs. Player > %'")
        expressions={'priority':f'CAST({effective_priority} AS TEXT)','name':'a.name','points':'CAST(a.points AS TEXT)','category':"COALESCE(a.category,'')",'whatToDo':"COALESCE(cm.what_to_do,cm.fastest_path_tip,'')",'note':"COALESCE(ua.note,'')"}
        for key, raw in filters.items():
            if key in ('done','state') or key not in expressions: continue
            if key == 'category' and isinstance(raw, list):
                values=[str(item).strip().lower() for item in raw if str(item).strip()]
                if values:
                    clauses.append('(' + ' OR '.join(f"(LOWER({expressions[key]})=? OR LOWER({expressions[key]}) LIKE ?)" for _ in values) + ')')
                    for item in values: params.extend([item, f'{item} > %'])
                continue
            text=str(raw).strip().lower()
            if text: clauses.append(f"LOWER({expressions[key]}) LIKE ?"); params.append(f"%{text}%")
        completion_source = filters.get('completionSource')
        completion_sources = completion_source if isinstance(completion_source, list) else [completion_source]
        completion_sources = [item for item in completion_sources if item in ('manual_confirmation','blizzard')]
        if completion_sources:
            source_clauses=[]
            if 'manual_confirmation' in completion_sources: source_clauses.append('ua.marked_done_at IS NOT NULL')
            if 'blizzard' in completion_sources: source_clauses.append('ca.blizzard_confirmed_at IS NOT NULL')
            clauses.append(f"{effective_state}='earned' AND (" + ' OR '.join(source_clauses) + ')')
        elif filters.get('manualDone'):
            # Backwards-compatible with saved links from the first version of
            # the personal-completion filter.
            clauses.append(f"{effective_state}='earned' AND ua.source='manual_confirmation'")
        reward_values = filters.get('rewardType') if isinstance(filters.get('rewardType'), list) else [filters.get('rewardType')]
        reward_values = [str(value).strip().lower() for value in reward_values if value]
        if reward_values:
            reward_clauses=[]
            if 'none' in reward_values:
                reward_clauses.append("(a.reward_type IS NULL AND (a.reward_description IS NULL OR a.reward_description=''))")
            typed=[value for value in reward_values if value in ('decor','mount','pet','title','toy','appearance','gear','cache','unlock','other')]
            if typed:
                reward_clauses.append(f"a.reward_type IN ({','.join('?' for _ in typed)})")
                params.extend(typed)
            if reward_clauses: clauses.append('('+' OR '.join(reward_clauses)+')')
        for filter_key,column in (('addedExpansion','a.added_expansion'),('addedPatch','a.added_patch')):
            raw=filters.get(filter_key)
            values=[str(value).strip() for value in (raw if isinstance(raw,list) else [raw]) if value]
            if values:
                clauses.append(f"{column} IN ({','.join('?' for _ in values)})")
                params.extend(values)
        priority_values=filters.get('priorityValues')
        if isinstance(priority_values,list):
            clean=[int(value) for value in priority_values if isinstance(value,(int,str)) and str(value).lstrip('-').isdigit() and -100<=int(value)<=100]
            if clean:
                clauses.append(f"{effective_priority} IN ({','.join('?' for _ in clean)})")
                params.extend(clean)
        states=[str(item) for item in filters.get('state',[]) if str(item) in ('earned','unearned','unknown','in_progress','completion_ready')]
        if states and not completion_sources and not filters.get('manualDone'):
            clauses.append(f"{effective_state} IN ({','.join('?' for _ in states)})"); params.extend(states)
        done=[str(item) for item in filters.get('done',[]) if str(item) in ('yes','no')]
        if done==['yes']: clauses.append(f"{effective_state}='earned'")
        elif done==['no']: clauses.append(f"{effective_state}!='earned'")
        priority_min=value.get('priorityMin'); priority_max=value.get('priorityMax')
        if priority_min is not None: clauses.append(f'{effective_priority}>=?'); params.append(priority_min)
        if priority_max is not None: clauses.append(f'{effective_priority}<=?'); params.append(priority_max)
        query=str(value.get('query') or '').strip().lower()
        if query:
            clauses.append("(LOWER(a.name) LIKE ? OR LOWER(COALESCE(a.category,'')) LIKE ? OR LOWER(COALESCE(cm.what_to_do,cm.fastest_path_tip,'')) LIKE ? OR LOWER(COALESCE(ua.note,'')) LIKE ?)")
            params.extend([f"%{query}%"]*4)
        limit=value.get('limit',50); offset=value.get('offset',0)
        from_sql=f"FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id LEFT JOIN user_achievement_overlays ua ON ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id AND ua.user_id=? {comparison_join} LEFT JOIN curated_metadata cm ON cm.achievement_id=a.achievement_id"
        availability_select="CASE WHEN a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction) THEN 1 ELSE 0 END availableForCharacter"
        comparison_availability_select="CASE WHEN a.required_faction IS NULL OR cc.faction IS NULL OR UPPER(a.required_faction)=UPPER(cc.faction) THEN 1 ELSE 0 END comparisonAvailableForCharacter" if comparison_id else "NULL comparisonAvailableForCharacter"
        sql=f"SELECT a.achievement_id achievementId,a.name,a.points,a.category,a.description,a.required_faction requiredFaction,{availability_select},{comparison_availability_select},a.reward_type rewardType,a.reward_url rewardUrl,a.added_expansion addedExpansion,a.added_patch addedPatch,a.criteria_json criteriaJson,ca.criteria_progress_json criteriaProgressJson,EXISTS(SELECT 1 FROM achievement_dependencies ad WHERE ad.achievement_id=a.achievement_id) hasDependencies,{effective_state} state,CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN ca.earned_at ELSE ua.earned_at END earnedAt,ua.marked_done_at markedDoneAt,ca.blizzard_confirmed_at blizzardConfirmedAt,{effective_priority} priority,COALESCE(ua.progress_current,ca.progress_current) progressCurrent,COALESCE(ua.progress_target,ca.progress_target) progressTarget,ua.note,ua.imported_tip importedTip,ua.imported_tip_source importedTipSource,ua.imported_tip_imported_at importedTipImportedAt,CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'blizzard' ELSE COALESCE(ua.source,ca.source) END source,COALESCE(ua.updated_at,ca.updated_at) updatedAt,{comparison_select},cm.* {from_sql} WHERE {' AND '.join(clauses)} ORDER BY {order} LIMIT ?"
        with self._connect() as db:
            self._character(db,value['characterId'])
            if comparison_id: self._character(db, comparison_id)
            query_params=[*comparison_params,*params]
            faction_unavailable=db.execute("""
              SELECT COUNT(*) FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id
              JOIN characters c ON c.id=ca.character_id
              WHERE ca.character_id=? AND a.required_faction IS NOT NULL AND c.faction IS NOT NULL
                AND UPPER(a.required_faction)<>UPPER(c.faction)
            """,(value['characterId'],)).fetchone()[0]
            total=db.execute(f"SELECT COUNT(*) {from_sql} WHERE {' AND '.join(clauses)}",query_params).fetchone()[0]
            rows=[dict(r) for r in db.execute(f"{sql} OFFSET ?",[*query_params,limit,offset])]
            for item in rows:
                try:
                    static = json.loads(item.pop('criteriaJson') or '{}')
                    progress = json.loads(item.pop('criteriaProgressJson') or '{}')
                except json.JSONDecodeError:
                    static, progress = {}, {}
                progress_by_id: dict[int, dict[str, Any]] = {}
                def index_progress(node: Any) -> None:
                    if not isinstance(node, dict): return
                    if isinstance(node.get('id'), int): progress_by_id[node['id']] = node
                    for child in node.get('child_criteria') or []: index_progress(child)
                index_progress(progress)
                criteria = [node for node in static.get('child_criteria') or [] if isinstance(node, dict)] if isinstance(static, dict) else []
                item['metaProgressTarget'] = len(criteria) or None
                item['metaProgressCurrent'] = (len(criteria) if item['state'] == 'earned' else sum(bool(progress_by_id.get(node.get('id'), {}).get('is_completed')) for node in criteria)) if criteria else None
            return {'characterId':value['characterId'],'characterFaction':self._character(db,value['characterId'])['faction'],'compareCharacterId':comparison_id,'neededByBoth':needed_by_both,'includeUnavailable':include_unavailable,'factionUnavailable':faction_unavailable,'order':value.get('order','priority'),'achievements':rows,'total':total,'offset':offset,'limit':limit,'hasMore':offset+len(rows)<total}

    def dashboard(self, character_ids: list[int], actor: str | None = None) -> dict[str, Any]:
        with self._connect() as db:
            marks=','.join('?' for _ in character_ids)
            effective_state="CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(ua.state,ca.state) END"
            rows=db.execute(f"SELECT ca.character_id,{effective_state} state,COUNT(*) count FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id WHERE ca.character_id IN ({marks}) AND (a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction)) GROUP BY ca.character_id,{effective_state}",[self._overlay_user(actor),*character_ids]).fetchall()
            return {
                'characterIds':character_ids,
                'counts':[dict(r) for r in rows],
                'recentAchievements':[
                    {'characterId': character_id, 'achievements': self._recent_achievements(db, character_id)}
                    for character_id in character_ids
                ],
                'generatedAt':now(),
            }

    def plan(self, character_ids: list[int], limit: int, actor: str | None = None) -> dict[str, Any]:
        with self._connect() as db:
            marks=','.join('?' for _ in character_ids)
            effective_state="CASE WHEN ca.blizzard_confirmed_at IS NOT NULL THEN 'earned' ELSE COALESCE(ua.state,ca.state) END"
            rows=db.execute(f"SELECT a.achievement_id achievementId,a.name,MAX(COALESCE(ua.priority,0)) priority,MAX(cm.deadline) deadline,MAX(COALESCE(ua.imported_tip,cm.fastest_path_tip)) tip,MAX(cm.estimated_minutes) estimatedMinutes,COUNT(*) needingCharacters FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id JOIN characters c ON c.id=ca.character_id LEFT JOIN user_achievement_overlays ua ON ua.user_id=? AND ua.character_id=ca.character_id AND ua.achievement_id=ca.achievement_id LEFT JOIN curated_metadata cm ON cm.achievement_id=a.achievement_id WHERE ca.character_id IN ({marks}) AND (a.required_faction IS NULL OR c.faction IS NULL OR UPPER(a.required_faction)=UPPER(c.faction)) AND {effective_state} != 'earned' AND (cm.expires_at IS NULL OR cm.expires_at >= ?) GROUP BY a.achievement_id HAVING COUNT(*)>0 ORDER BY (MAX(COALESCE(ua.priority,0))*100 + CASE WHEN MAX(cm.deadline) IS NOT NULL THEN 25 ELSE 0 END + COUNT(*)*10) DESC,a.name LIMIT ?",[self._overlay_user(actor),*character_ids,now(),limit]).fetchall()
            items=[]
            for row in rows:
                item=dict(row); reasons=[]
                if item['priority']: reasons.append(f"manual priority {item['priority']}")
                if item['deadline']: reasons.append('has a recorded deadline')
                if item['needingCharacters']>1: reasons.append(f"helps {item['needingCharacters']} selected characters")
                item['reasons']=reasons or ['no curated urgency; ordered deterministically']; items.append(item)
            return {'characterIds':character_ids,'items':items,'generatedAt':now()}
