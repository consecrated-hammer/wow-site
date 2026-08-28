import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Literal
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from achievement_tracker import AchievementTracker

STATIC_DIR = Path(os.environ.get("WOW_WEB_STATIC_DIR", "/app/static"))
TRACKER = AchievementTracker(Path(os.environ.get("WOW_MCP_TRACKER_DB_PATH", "/data/achievement_tracker.sqlite3")))
BLIZZARD_UPSTREAM_URL = os.environ.get("WOW_BLIZZARD_UPSTREAM_URL", "http://wow-site").rstrip("/")
app = FastAPI(title="Consecrated Hammer", docs_url=None, redoc_url=None)
HAMMERLINK_MAX_EXPORT_CHARS = 262_144
HAMMERLINK_MAX_ADAPTER_RESPONSE_BYTES = 6 * 1024 * 1024


def actor(subject: str | None) -> str | None:
    return hashlib.sha256(subject.encode()).hexdigest()[:24] if subject else None


def request_actor(x_auth_request_sub: str | None, remote_user: str | None) -> str | None:
    """Accept identity from the OAuth gateway or the browser's Authelia proxy."""
    # Authelia's browser middleware supplies the username as Remote-User. Keep
    # that stable principal when both headers exist; the MCP side also prefers
    # preferred_username over its opaque OAuth subject for the same reason.
    return actor(remote_user or x_auth_request_sub)


class StateChange(BaseModel):
    characterId: int = Field(gt=0)
    achievementId: int = Field(gt=0)
    state: Literal["unknown", "unearned", "in_progress", "completion_ready", "earned"]
    note: str | None = Field(default=None, max_length=2000)


class PriorityChange(BaseModel):
    characterId: int = Field(gt=0)
    achievementId: int = Field(gt=0)
    priority: int = Field(ge=-100, le=100)


class RefreshRequest(BaseModel):
    characterId: int = Field(gt=0)


class MetadataSyncRequest(BaseModel):
    limit: int = Field(default=250, ge=1, le=1000)

class PriorityLabelsChange(BaseModel):
    labels: list[dict] = Field(min_length=1, max_length=12)


class CharacterLookup(BaseModel):
    region: Literal["us", "eu", "kr", "tw"]
    realm: str = Field(min_length=1, max_length=80)
    name: str = Field(min_length=1, max_length=24)


class CharacterSelection(BaseModel):
    characterId: int = Field(gt=0)


class HammerLinkImportRequest(BaseModel):
    export: str = Field(min_length=5, max_length=HAMMERLINK_MAX_EXPORT_CHARS)


def upstream_json(path: str, query: dict[str, str], timeout: int = 20) -> dict:
    try:
        with urlopen(f"{BLIZZARD_UPSTREAM_URL}{path}?{urlencode(query)}", timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception as error:  # public app must not expose internal network details
        raise HTTPException(status_code=502, detail="Blizzard data is temporarily unavailable.") from error


def upstream_post_json(path: str, payload: dict, timeout: int = 20) -> dict:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(
        f"{BLIZZARD_UPSTREAM_URL}{path}", data=body, method="POST",
        headers={"content-type": "application/json", "accept": "application/json"},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read(HAMMERLINK_MAX_ADAPTER_RESPONSE_BYTES + 1)
            if len(raw) > HAMMERLINK_MAX_ADAPTER_RESPONSE_BYTES:
                raise HTTPException(status_code=502, detail="HammerLink parser returned too much data.")
            return json.loads(raw.decode("utf-8"))
    except HTTPError as error:
        try:
            failure = json.loads(error.read().decode("utf-8"))
            detail = failure.get("message") or failure.get("error")
        except Exception:
            detail = None
        raise HTTPException(status_code=error.code if 400 <= error.code < 500 else 502, detail=detail or "Could not read that HammerLink export.") from error
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=502, detail="HammerLink parsing is temporarily unavailable.") from error


@app.on_event("startup")
def startup() -> None:
    TRACKER.initialise()
    threading.Thread(target=drain_blizzard_metadata_queue, name="blizzard-achievement-metadata", daemon=True).start()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/tracker/characters")
def characters(x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    return TRACKER.list_characters(request_actor(x_auth_request_sub, remote_user))


@app.post("/api/tracker/characters/select")
def select_character(selection: CharacterSelection, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    return {"character": TRACKER.select_character(selection.characterId, request_actor(x_auth_request_sub, remote_user))}


@app.delete("/api/tracker/characters/{character_id}")
def forget_character(character_id: int, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    user = request_actor(x_auth_request_sub, remote_user)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to remove a recent character.")
    try:
        return TRACKER.forget_character(character_id, user)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/tracker/categories")
def tracker_categories(characterId: int = Query(gt=0)) -> dict:
    return TRACKER.categories(characterId)

@app.get("/api/tracker/summary")
def tracker_summary(characterId: int = Query(gt=0), x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    return TRACKER.character_summary(characterId, request_actor(x_auth_request_sub, remote_user))

@app.get("/api/tracker/facets")
def tracker_facets(characterId: int = Query(gt=0), x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    return TRACKER.facets(characterId, request_actor(x_auth_request_sub, remote_user))

@app.get("/api/tracker/priority-labels")
def tracker_priority_labels(characterId: int | None = Query(default=None, gt=0), x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    return TRACKER.priority_labels_for_user_or_character(request_actor(x_auth_request_sub, remote_user), characterId)

@app.post("/api/tracker/priority-labels")
def set_tracker_priority_labels(change: PriorityLabelsChange, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    user = request_actor(x_auth_request_sub, remote_user)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to save your priority labels.")
    try:
        return TRACKER.set_user_priority_labels(user, change.labels)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/realms")
def realms(region: Literal["us", "eu", "kr", "tw"]) -> dict:
    return upstream_json("/api/realms", {"region": region})


@app.get("/api/tracks/character")
def tracks_character(
    region: Literal["us", "eu", "kr", "tw"],
    realm: str = Query(min_length=1, max_length=80),
    name: str = Query(min_length=1, max_length=24),
) -> dict:
    """Return only the Blizzard profile fields needed by the track baseline."""
    payload = upstream_json("/api/profile", {"region": region, "realm": realm, "name": name})
    return {
        "character": payload.get("character"),
        "equippedItemLevel": payload.get("equippedItemLevel"),
        "averageItemLevel": payload.get("averageItemLevel"),
        "fetchedAt": payload.get("fetchedAt"),
    }


@app.post("/api/tracker/characters")
def add_character(lookup: CharacterLookup, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    payload = upstream_json("/api/achievements", lookup.model_dump())
    character = payload.get("character") or {}
    if not character.get("name") or not character.get("realm"):
        raise HTTPException(status_code=502, detail="Blizzard did not return this character's identity.")
    saved = TRACKER.add_character({
        "region": lookup.region,
        "realm": character["realm"],
        "realmSlug": character.get("realmSlug"),
        "name": character["name"],
        "race": character.get("race"),
        "characterClass": character.get("characterClass"),
        "faction": character.get("faction"),
        "avatarUrl": character.get("avatarUrl"),
    }, request_actor(x_auth_request_sub, remote_user))
    recent = payload.get("recentAchievements") or []
    TRACKER.record_blizzard_recent(saved["id"], recent, request_actor(x_auth_request_sub, remote_user))
    TRACKER.record_blizzard_progress(saved["id"], payload.get("achievementProgress") or [], request_actor(x_auth_request_sub, remote_user))
    return {"character": saved, "recordedRecentEarned": len(recent)}


@app.get("/api/tracker/achievements")
def achievements(
    characterId: int,
    compareCharacterId: int | None = Query(default=None, gt=0),
    neededByBoth: bool = False,
    includeUnavailable: bool = False,
    order: Literal["priority", "new", "updated", "expiring"] = "priority",
    state: str | None = None,
    limit: int = Query(default=100, ge=1, le=250),
    offset: int = Query(default=0, ge=0),
    sortBy: Literal["done", "priority", "name", "points", "category", "description", "whatToDo", "state", "comparisonState", "earnedAt", "note", "updated"] | None = None,
    sortDir: Literal["asc", "desc"] = "asc",
    q: str | None = Query(default=None, max_length=200),
    filters: str | None = Query(default=None, max_length=2000),
    priorityMin: int | None = Query(default=None, ge=-100, le=100),
    priorityMax: int | None = Query(default=None, ge=-100, le=100),
    x_auth_request_sub: str | None = Header(default=None),
    remote_user: str | None = Header(default=None, alias="Remote-User"),
) -> dict:
    try:
        parsed_filters = json.loads(filters) if filters else {}
    except json.JSONDecodeError as error:
        raise HTTPException(status_code=422, detail="Filters must be valid JSON.") from error
    if not isinstance(parsed_filters, dict):
        raise HTTPException(status_code=422, detail="Filters must be an object.")
    user = request_actor(x_auth_request_sub, remote_user)
    if compareCharacterId and user and not TRACKER.user_has_character(user, compareCharacterId):
        raise HTTPException(status_code=403, detail="Open the comparison character before comparing it.")
    try:
        return TRACKER.list_achievements({"actor": user, "characterId": characterId, "compareCharacterId": compareCharacterId, "neededByBoth": neededByBoth, "includeUnavailable": includeUnavailable, "order": order, "state": state, "limit": limit, "offset": offset, "sortBy": sortBy, "sortDir": sortDir, "query": q, "filters": parsed_filters, "priorityMin": priorityMin, "priorityMax": priorityMax})
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/api/tracker/achievements/{achievement_id}/requirements")
def achievement_requirements(achievement_id: int, characterId: int = Query(gt=0), x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    if not TRACKER.achievement_has_tooltip_metadata(achievement_id):
        fetch_blizzard_metadata([achievement_id], include_media=True)
    return TRACKER.achievement_requirements(characterId, achievement_id, request_actor(x_auth_request_sub, remote_user))


@app.get("/api/tracker/release-options")
def release_options(characterId: int = Query(gt=0)) -> dict:
    return TRACKER.release_options(characterId)


@app.post("/api/tracker/state")
def set_state(change: StateChange, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    source = "manual_confirmation" if change.state == "earned" else "manual"
    return TRACKER.update_state({**change.model_dump(), "source": source}, request_actor(x_auth_request_sub, remote_user))


@app.post("/api/tracker/priority")
def set_priority(change: PriorityChange, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    return TRACKER.set_priority(change.characterId, change.achievementId, change.priority, request_actor(x_auth_request_sub, remote_user))


@app.post("/api/tracker/refresh")
def refresh_tracker(change: RefreshRequest, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    user = request_actor(x_auth_request_sub, remote_user)
    identity = TRACKER.character_identity(change.characterId)
    payload = upstream_json("/api/achievements", {**identity, "refresh": "1"})
    character = payload.get("character") or {}
    if character.get("name") and character.get("realm"):
        TRACKER.add_character({"region": identity["region"], "realm": character["realm"], "realmSlug": character.get("realmSlug"), "name": character["name"], "race": character.get("race"), "characterClass": character.get("characterClass"), "faction": character.get("faction"), "avatarUrl": character.get("avatarUrl")}, user)
    result = TRACKER.record_blizzard_recent(change.characterId, payload.get("recentAchievements") or [], user)
    result["recordedProgress"] = TRACKER.record_blizzard_progress(change.characterId, payload.get("achievementProgress") or [], user)
    return result


def fetch_blizzard_metadata(ids: list[int], subject: str | None = None, include_media: bool = False) -> dict:
    records: list[dict] = []
    unavailable: list[dict] = []
    failures = 0
    # Use the adapter's bounded batch so the background catalogue does not
    # consume the same internal request budget needed by interactive tooltips.
    for start in range(0, len(ids), 25):
        query = {"ids": ",".join(str(value) for value in ids[start:start + 25])}
        if include_media: query["includeMedia"] = "1"
        payload = upstream_json("/api/achievement-metadata", query, timeout=120)
        for item in payload.get("records") or []:
            if item.get("error"):
                failures += 1
                if item.get("error") == "upstream_not_found":
                    unavailable.append(item)
            else:
                records.append(item)
    result = TRACKER.upsert_blizzard_metadata(records, actor(subject))
    unavailable_count = TRACKER.record_unavailable_blizzard_metadata(unavailable, actor(subject))
    return {**result, "requested": len(ids), "failed": failures, "unavailable": unavailable_count, "retryableFailures": failures - unavailable_count, "remaining": len(TRACKER.achievement_ids_without_blizzard_metadata(1_000_000))}


def sync_blizzard_metadata_batch(limit: int, subject: str | None = None) -> dict:
    return fetch_blizzard_metadata(TRACKER.achievement_ids_without_blizzard_metadata(limit), subject)


def drain_blizzard_metadata_queue() -> None:
    """Populate global static achievement data without tying it to a character view."""
    retry_count = 0
    while True:
        try:
            result = sync_blizzard_metadata_batch(250)
        except Exception:
            return
        if not result["requested"]:
            return
        if result["retryableFailures"]:
            retry_count += 1
            if retry_count >= 5:
                return
            time.sleep(min(30, 2 ** retry_count))
        else:
            retry_count = 0
            # Reserve adapter capacity for realm lookups and hover cards while
            # the low-priority global catalogue drains in the background.
            time.sleep(12)


@app.post("/api/tracker/metadata/sync")
def sync_blizzard_metadata(request: MetadataSyncRequest, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    return sync_blizzard_metadata_batch(request.limit, x_auth_request_sub or remote_user)


@app.get("/api/hammerlink/imports")
def hammerlink_imports(x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    user = request_actor(x_auth_request_sub, remote_user)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to view your HammerLink imports.")
    return TRACKER.list_hammerlink_import_history(user)


@app.get("/api/hammerlink/imports/history/{import_id}")
def hammerlink_import_history_detail(import_id: int, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    user = request_actor(x_auth_request_sub, remote_user)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to view a HammerLink import.")
    try:
        return TRACKER.hammerlink_import_version(user, import_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.get("/api/hammerlink/imports/{character_id}")
def hammerlink_import_detail(character_id: int, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    user = request_actor(x_auth_request_sub, remote_user)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to view a HammerLink import.")
    try:
        return TRACKER.hammerlink_import(user, character_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/hammerlink/imports")
def save_hammerlink_import(change: HammerLinkImportRequest, x_auth_request_sub: str | None = Header(default=None), remote_user: str | None = Header(default=None, alias="Remote-User")) -> dict:
    user = request_actor(x_auth_request_sub, remote_user)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in to save a HammerLink import.")
    parsed = upstream_post_json("/api/hammerlink-import", {"export": change.export})
    snapshot = parsed.get("snapshot")
    lookup = parsed.get("lookup") or {}
    character = parsed.get("character") or {}
    if not isinstance(snapshot, dict) or not lookup.get("region") or not character.get("name") or not character.get("realm"):
        raise HTTPException(status_code=502, detail="HammerLink parser returned an incomplete snapshot.")
    saved_character = TRACKER.add_character({
        "region": lookup["region"], "realm": character["realm"], "realmSlug": lookup.get("realm"),
        # An HL1 export identifies the user's storage key, but it is not an
        # authoritative Blizzard profile response. Do not let it overwrite
        # shared character metadata such as class or faction.
        "name": character["name"],
    }, user)
    try:
        return TRACKER.save_hammerlink_import(user, saved_character["id"], snapshot)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
    app.mount("/factions", StaticFiles(directory=STATIC_DIR / "factions"), name="factions")


@app.get("/favicon.png")
def favicon() -> FileResponse:
    icon = STATIC_DIR / "favicon.png"
    if not icon.exists():
        raise HTTPException(status_code=404, detail="Favicon is unavailable.")
    return FileResponse(icon, media_type="image/png", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/{path:path}")
def frontend(path: str) -> FileResponse:
    index = STATIC_DIR / "index.html"
    if not index.exists():
        raise HTTPException(status_code=503, detail="Frontend build is unavailable.")
    return FileResponse(index, headers={"Cache-Control": "no-store"})
