"""Persistent, provenance-aware achievement planning state for the WoW MCP.

Blizzard is authoritative for earned state.  Curated guidance is explicit
agent-supplied research, never an inferred or scraped runtime value.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


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

    def initialise(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript("""
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS characters (
                id INTEGER PRIMARY KEY, region TEXT NOT NULL, realm TEXT NOT NULL,
                name TEXT NOT NULL, realm_slug TEXT, active INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE(region, realm, name)
              );
              CREATE TABLE IF NOT EXISTS achievements (
                achievement_id INTEGER PRIMARY KEY, name TEXT NOT NULL,
                points INTEGER, category TEXT, description TEXT,
                blizzard_fetched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
              );
              CREATE TABLE IF NOT EXISTS character_achievements (
                character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
                achievement_id INTEGER NOT NULL REFERENCES achievements(achievement_id) ON DELETE CASCADE,
                state TEXT NOT NULL DEFAULT 'unknown' CHECK(state IN ('unknown','unearned','in_progress','completion_ready','earned')),
                earned_at TEXT, progress_current INTEGER, progress_target INTEGER,
                priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100),
                note TEXT, source TEXT NOT NULL DEFAULT 'manual', updated_at TEXT NOT NULL,
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
              CREATE TABLE IF NOT EXISTS tracker_events (
                id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
                character_id INTEGER, achievement_id INTEGER, detail TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS ca_priority ON character_achievements(character_id, priority DESC);
              CREATE INDEX IF NOT EXISTS cm_deadline ON curated_metadata(deadline);
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
                    earned_at TEXT, progress_current INTEGER, progress_target INTEGER,
                    priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100),
                    note TEXT, source TEXT NOT NULL DEFAULT 'manual', updated_at TEXT NOT NULL,
                    PRIMARY KEY(character_id, achievement_id)
                  );
                  INSERT INTO character_achievements SELECT * FROM character_achievements_before_unearned;
                  DROP TABLE character_achievements_before_unearned;
                  CREATE INDEX IF NOT EXISTS ca_priority ON character_achievements(character_id, priority DESC);
                  PRAGMA user_version=1;
                """)
            columns = {row[1] for row in db.execute("PRAGMA table_info(characters)")}
            if "realm_key" not in columns:
                db.execute("ALTER TABLE characters ADD COLUMN realm_key TEXT")
            for row in db.execute("SELECT id, realm, realm_slug FROM characters WHERE realm_key IS NULL OR realm_key='' ").fetchall():
                db.execute("UPDATE characters SET realm_key=? WHERE id=?", (self._realm_key(row["realm"], row["realm_slug"]), row["id"]))

    @staticmethod
    def _realm_key(realm: str, realm_slug: str | None = None) -> str:
        """Stable realm identity: punctuation/display spelling must not fork a character."""
        return re.sub(r"[^a-z0-9]+", "", str(realm_slug or realm).lower())

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
                db.execute("UPDATE characters SET realm=?, realm_slug=COALESCE(?,realm_slug), realm_key=?, updated_at=? WHERE id=?", (value["realm"], value.get("realmSlug"), realm_key, stamp, row["id"]))
            else:
                db.execute("INSERT INTO characters(region,realm,name,realm_slug,realm_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?)", (value['region'],value['realm'],value['name'],value.get('realmSlug'),realm_key,stamp,stamp))
            row=db.execute("SELECT * FROM characters WHERE region=? AND lower(name)=lower(?) AND realm_key=?",(value['region'],value['name'],realm_key)).fetchone()
            self._event(db,actor,'character_upsert',row['id'],None,value)
            return dict(row)

    def list_characters(self) -> dict[str, Any]:
        with self._connect() as db:
            return {'characters':[dict(row) for row in db.execute("SELECT * FROM characters ORDER BY active DESC, name COLLATE NOCASE")]}

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
                db.execute("INSERT INTO character_achievements(character_id,achievement_id,state,earned_at,source,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(character_id,achievement_id) DO UPDATE SET state='earned',earned_at=COALESCE(excluded.earned_at,character_achievements.earned_at),source='blizzard',updated_at=excluded.updated_at", (character_id, achievement_id, "earned", item.get("completedAt"), "blizzard", stamp))
                recorded += 1
            self._event(db, actor, "achievement_refresh_blizzard_recent", character_id, None, {"recorded": recorded})
        return {"characterId": character_id, "recordedRecentEarned": recorded, "scope": "recent_events_only"}

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
        with self._connect() as db:
            self._character(db, character_id)
            db.execute("INSERT INTO achievements(achievement_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(achievement_id) DO NOTHING",(achievement_id,f'Achievement {achievement_id}',now(),now()))
            db.execute("INSERT INTO character_achievements(character_id,achievement_id,priority,updated_at) VALUES(?,?,?,?) ON CONFLICT(character_id,achievement_id) DO UPDATE SET priority=excluded.priority,updated_at=excluded.updated_at",(character_id,achievement_id,priority,now()))
            self._event(db,actor,'achievement_set_priority',character_id,achievement_id,{'priority':priority})
            return {'characterId':character_id,'achievementId':achievement_id,'priority':priority}

    def update_state(self, value: dict[str, Any], actor: str | None) -> dict[str, Any]:
        cid, aid=value['characterId'],value['achievementId']
        state=value['state']; source=value.get('source','manual')
        if state == 'earned' and source not in ('manual_confirmation','blizzard'):
            raise ValueError("earned requires source manual_confirmation or blizzard")
        with self._connect() as db:
            self._character(db,cid)
            db.execute("INSERT INTO achievements(achievement_id,name,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(achievement_id) DO NOTHING",(aid,f'Achievement {aid}',now(),now()))
            db.execute("INSERT INTO character_achievements(character_id,achievement_id,state,earned_at,progress_current,progress_target,note,source,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(character_id,achievement_id) DO UPDATE SET state=excluded.state,earned_at=excluded.earned_at,progress_current=excluded.progress_current,progress_target=excluded.progress_target,note=COALESCE(excluded.note,character_achievements.note),source=excluded.source,updated_at=excluded.updated_at",(cid,aid,state,value.get('earnedAt') if state=='earned' else None,value.get('progressCurrent'),value.get('progressTarget'),value.get('note'),source,now()))
            self._event(db,actor,'achievement_update_state',cid,aid,value)
            return {'characterId':cid,'achievementId':aid,'state':state,'source':source}

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

    def list_achievements(self, value: dict[str, Any]) -> dict[str, Any]:
        order={'priority':'ca.priority DESC, a.name COLLATE NOCASE','new':'a.created_at DESC','expiring':'cm.deadline ASC','updated':'ca.updated_at DESC'}[value.get('order','priority')]
        clauses=['ca.character_id=?']; params: list[Any]=[value['characterId']]
        if value.get('state'): clauses.append('ca.state=?'); params.append(value['state'])
        if value.get('onlyUnexpired'): clauses.append("(cm.expires_at IS NULL OR cm.expires_at >= ?)"); params.append(now())
        if value.get('order')=='expiring': clauses.append("cm.deadline IS NOT NULL AND cm.deadline >= ?"); params.append(now())
        limit=value.get('limit',50); params.append(limit)
        sql=f"SELECT a.achievement_id achievementId,a.name,a.points,a.category,ca.state,ca.priority,ca.progress_current progressCurrent,ca.progress_target progressTarget,ca.note,ca.source,ca.updated_at updatedAt,cm.* FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id LEFT JOIN curated_metadata cm ON cm.achievement_id=a.achievement_id WHERE {' AND '.join(clauses)} ORDER BY {order} LIMIT ?"
        with self._connect() as db:
            self._character(db,value['characterId'])
            return {'characterId':value['characterId'],'order':value.get('order','priority'),'achievements':[dict(r) for r in db.execute(sql,params)]}

    def dashboard(self, character_ids: list[int]) -> dict[str, Any]:
        with self._connect() as db:
            marks=','.join('?' for _ in character_ids)
            rows=db.execute(f"SELECT character_id,state,COUNT(*) count FROM character_achievements WHERE character_id IN ({marks}) GROUP BY character_id,state",character_ids).fetchall()
            return {'characterIds':character_ids,'counts':[dict(r) for r in rows], 'generatedAt':now()}

    def plan(self, character_ids: list[int], limit: int) -> dict[str, Any]:
        with self._connect() as db:
            marks=','.join('?' for _ in character_ids)
            rows=db.execute(f"SELECT a.achievement_id achievementId,a.name,MAX(ca.priority) priority,MAX(cm.deadline) deadline,MAX(cm.fastest_path_tip) tip,MAX(cm.estimated_minutes) estimatedMinutes,COUNT(*) needingCharacters FROM character_achievements ca JOIN achievements a ON a.achievement_id=ca.achievement_id LEFT JOIN curated_metadata cm ON cm.achievement_id=a.achievement_id WHERE ca.character_id IN ({marks}) AND ca.state != 'earned' AND (cm.expires_at IS NULL OR cm.expires_at >= ?) GROUP BY a.achievement_id HAVING COUNT(*)>0 ORDER BY (MAX(ca.priority)*100 + CASE WHEN MAX(cm.deadline) IS NOT NULL THEN 25 ELSE 0 END + COUNT(*)*10) DESC,a.name LIMIT ?",[*character_ids,now(),limit]).fetchall()
            items=[]
            for row in rows:
                item=dict(row); reasons=[]
                if item['priority']: reasons.append(f"manual priority {item['priority']}")
                if item['deadline']: reasons.append('has a recorded deadline')
                if item['needingCharacters']>1: reasons.append(f"helps {item['needingCharacters']} selected characters")
                item['reasons']=reasons or ['no curated urgency; ordered deterministically']; items.append(item)
            return {'characterIds':character_ids,'items':items,'generatedAt':now()}
