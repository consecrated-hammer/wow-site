import json
import hashlib
import re
import logging
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import anyio
import uvicorn
from mcp import types
from mcp.server.lowlevel.server import Server, ServerRequestContext
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse, Response
from starlette.routing import Route
from achievement_tracker import AchievementTracker


LOGGER = logging.getLogger("uvicorn.error")
HOST = os.environ.get("WOW_MCP_HOST", "0.0.0.0")
PORT = int(os.environ.get("WOW_MCP_PORT", "8767"))
UPSTREAM_URL = os.environ.get("WOW_MCP_UPSTREAM_URL", "http://wow-site").rstrip("/")
AUDIT_LOG_PATH = Path(os.environ.get("WOW_MCP_AUDIT_LOG_PATH", "/data/queries.jsonl"))
TRACKER_DB_PATH = Path(os.environ.get("WOW_MCP_TRACKER_DB_PATH", "/data/achievement_tracker.sqlite3"))
TRACKER = AchievementTracker(TRACKER_DB_PATH)
UPSTREAM_TIMEOUT_SECONDS = max(float(os.environ.get("WOW_MCP_UPSTREAM_TIMEOUT_SECONDS", "15")), 1.0)
MAX_REQUEST_BYTES = max(int(os.environ.get("WOW_MCP_MAX_REQUEST_BYTES", "1048576")), 1)
AUDIT_LOCK = threading.Lock()
REGIONS = ("us", "eu", "kr", "tw")
SEASON_REWARD_CATEGORIES = (
    "all",
    "delves",
    "mythic_plus",
    "crests",
    "great_vault",
    "raid",
    "currencies",
    "recommended_activities",
)


CHARACTER_SUCCESS_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "source": {"type": "string"},
        "character": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "realm": {"type": "string"},
                "region": {"type": "string"},
            },
            "required": ["name", "realm", "region"],
            "additionalProperties": False,
        },
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "slot": {"type": ["string", "null"]},
                    "slotName": {"type": ["string", "null"]},
                    "itemId": {"type": ["integer", "null"]},
                    "name": {"type": "string"},
                    "itemLevel": {"type": ["integer", "null"]},
                    "quality": {"type": ["string", "null"]},
                    "sourceLabel": {"type": ["string", "null"]},
                    "icon": {"type": ["string", "null"]},
                    "enchantments": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                    "sockets": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
                    "upgrade": {"type": "object", "additionalProperties": True},
                    "seasonUpgrades": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "track": {"type": "string"},
                                "rank": {"type": "integer"},
                                "ranks": {"type": "integer"},
                                "itemLevel": {"type": "integer"},
                                "maximumItemLevel": {"type": "integer"},
                                "crestCostFromRankOne": {"type": "integer"},
                            },
                            "required": [
                                "track",
                                "rank",
                                "ranks",
                                "itemLevel",
                                "maximumItemLevel",
                                "crestCostFromRankOne",
                            ],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": [
                    "slot",
                    "slotName",
                    "itemId",
                    "name",
                    "itemLevel",
                    "quality",
                    "sourceLabel",
                    "icon",
                    "upgrade",
                    "seasonUpgrades",
                ],
                "additionalProperties": False,
            },
        },
        "fetchedAt": {"type": "string"},
        "cache": {
            "type": "object",
            "properties": {
                "status": {"type": "string"},
                "refreshAvailableAt": {"type": "string"},
            },
            "required": ["status", "refreshAvailableAt"],
            "additionalProperties": False,
        },
        "warning": {"type": "string"},
    },
    "required": ["source", "character", "items", "fetchedAt", "cache"],
    "additionalProperties": False,
}


REALMS_SUCCESS_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "source": {"type": "string"},
        "region": {"type": "string"},
        "fetchedAt": {"type": "string"},
        "realms": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "name": {"type": "string"},
                    "slug": {"type": "string"},
                },
                "required": ["id", "name", "slug"],
                "additionalProperties": False,
            },
        },
        "warning": {"type": "string"},
    },
    "required": ["source", "region", "fetchedAt", "realms"],
    "additionalProperties": False,
}

CHARACTER_IDENTITY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "name": {"type": "string"},
        "realm": {"type": "string"},
        "realmSlug": {"type": "string"},
        "realmId": {"type": ["integer", "null"]},
        "region": {"type": "string"},
        "faction": {"type": ["string", "null"]},
        "avatarUrl": {"type": ["string", "null"], "format": "uri"},
    },
    "required": ["name", "realm", "realmSlug", "realmId", "region"],
    "additionalProperties": False,
}

CACHE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "status": {"type": "string"},
        "refreshAvailableAt": {"type": "string"},
    },
    "required": ["status", "refreshAvailableAt"],
    "additionalProperties": False,
}

TALENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "nodeId": {"type": ["integer", "null"]},
        "rank": {"type": "integer"},
        "talentId": {"type": ["integer", "null"]},
        "name": {"type": ["string", "null"]},
        "spellId": {"type": ["integer", "null"]},
    },
    "required": ["nodeId", "rank", "talentId", "name", "spellId"],
    "additionalProperties": False,
}

TALENTS_SUCCESS_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "source": {"type": "string"},
        "character": CHARACTER_IDENTITY_SCHEMA,
        "activeSpecialization": {
            "type": ["object", "null"],
            "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            "required": ["id", "name"],
            "additionalProperties": False,
        },
        "activeHeroTalentTree": {
            "type": ["object", "null"],
            "properties": {"id": {"type": "integer"}, "name": {"type": "string"}},
            "required": ["id", "name"],
            "additionalProperties": False,
        },
        "loadout": {
            "type": ["object", "null"],
            "properties": {
                "importCode": {"type": ["string", "null"]},
                "classTalents": {"type": "array", "items": TALENT_SCHEMA},
                "specializationTalents": {"type": "array", "items": TALENT_SCHEMA},
                "heroTalents": {"type": "array", "items": TALENT_SCHEMA},
            },
            "required": ["importCode", "classTalents", "specializationTalents", "heroTalents"],
            "additionalProperties": False,
        },
        "fetchedAt": {"type": "string"},
        "cache": CACHE_SCHEMA,
        "warning": {"type": "string"},
    },
    "required": ["source", "character", "activeSpecialization", "activeHeroTalentTree", "loadout", "fetchedAt", "cache"],
    "additionalProperties": False,
}

PROFILE_SUCCESS_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "source": {"type": "string"},
        "character": CHARACTER_IDENTITY_SCHEMA,
        "level": {"type": ["integer", "null"]},
        "faction": {"type": ["string", "null"]},
        "race": {"type": ["object", "null"], "additionalProperties": True},
        "characterClass": {"type": ["object", "null"], "additionalProperties": True},
        "activeSpecialization": {"type": ["object", "null"], "additionalProperties": True},
        "guild": {"type": ["object", "null"], "additionalProperties": True},
        "averageItemLevel": {"type": ["integer", "null"]},
        "equippedItemLevel": {"type": ["integer", "null"]},
        "achievementPoints": {"type": ["integer", "null"]},
        "lastLoginAt": {"type": ["string", "null"]},
        "mythicPlus": {
            "type": ["object", "null"],
            "properties": {
                "seasonId": {"type": "integer"},
                "rating": {"type": ["number", "null"]},
                "bestRuns": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "dungeonId": {"type": ["integer", "null"]},
                            "dungeon": {"type": ["string", "null"]},
                            "keystoneLevel": {"type": ["integer", "null"]},
                            "completedWithinTime": {"type": ["boolean", "null"]},
                            "durationMs": {"type": ["integer", "null"]},
                            "rating": {"type": ["number", "null"]},
                            "completedAt": {"type": ["string", "null"]},
                        },
                        "required": ["dungeonId", "dungeon", "keystoneLevel", "completedWithinTime", "durationMs", "rating", "completedAt"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["seasonId", "rating", "bestRuns"],
            "additionalProperties": False,
        },
        "mythicPlusWarning": {"type": ["string", "null"]},
        "fetchedAt": {"type": "string"},
        "cache": CACHE_SCHEMA,
        "warning": {"type": "string"},
    },
    "required": ["source", "character", "level", "faction", "race", "characterClass", "activeSpecialization", "guild", "averageItemLevel", "equippedItemLevel", "achievementPoints", "lastLoginAt", "mythicPlus", "mythicPlusWarning", "fetchedAt", "cache"],
    "additionalProperties": False,
}

ACHIEVEMENTS_SUCCESS_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "source": {"type": "string"},
        "character": CHARACTER_IDENTITY_SCHEMA,
        "totalCompleted": {"type": ["integer", "null"]},
        "totalPoints": {"type": ["integer", "null"]},
        "recentAchievements": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": ["integer", "null"]},
                    "name": {"type": ["string", "null"]},
                    "completedAt": {"type": ["string", "null"]},
                },
                "required": ["id", "name", "completedAt"],
                "additionalProperties": False,
            },
        },
        "fetchedAt": {"type": "string"},
        "cache": CACHE_SCHEMA,
        "warning": {"type": "string"},
    },
    "required": ["source", "character", "totalCompleted", "totalPoints", "recentAchievements", "fetchedAt", "cache"],
    "additionalProperties": False,
}

ERROR_OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "error": {"type": "string", "description": "Stable machine-readable error code."},
        "message": {"type": "string", "description": "Agent-readable explanation of the failure."},
        "httpStatus": {"type": "integer"},
        "retryAfterSeconds": {"type": ["integer", "string"]},
    },
    "required": ["error", "message"],
    "additionalProperties": False,
}

# Curated seasonal rules, not Blizzard Profile API output. The envelope fields
# are typed strictly so an agent can always read provenance/verifiedAt; the
# static reward tables are typed as objects rather than leaf-by-leaf, because
# over-specifying hand-curated data costs maintenance without adding safety.
# Community guidance, never Blizzard output. `available` is part of the success
# contract: missing guidance is a normal answer, not an error, so an agent gets
# a schema-valid response instead of a tool failure.
RAID_PROGRESS_SUCCESS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "source": {"type": "string"},
        "character": {"type": ["object", "null"]},
        "provenance": {"const": "blizzard"},
        "expansions": {"type": "array"},
        "cache": CACHE_SCHEMA,
        "fetchedAt": {"type": "string"},
    },
    "required": ["provenance", "expansions"],
    "additionalProperties": True,
}

RAID_PROGRESS_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [RAID_PROGRESS_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

META_BUILDS_SUCCESS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "provenance": {"const": "community"},
        "source": {"const": "raiderio"},
        "attribution": {"type": "object", "description": "Required by Raider.IO's terms; surface it."},
        "season": {"type": "string"},
        "region": {"type": "string"},
        "runsAnalysed": {"type": "integer"},
        "fetchedAt": {"type": "string"},
        "comps": {"type": "array"},
        "specs": {"type": "array"},
        "builds": {"type": "array"},
        "decodeWarning": {"type": ["string", "null"]},
    },
    "required": ["provenance", "source", "attribution", "comps", "specs", "builds"],
    "additionalProperties": True,
}

META_BUILDS_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [META_BUILDS_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

GUIDANCE_SUCCESS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "provenance": {"const": "community"},
        "source": {"const": "classcodex"},
        "available": {"type": "boolean"},
        "reason": {"type": "string"},
        "addonVersion": {"type": ["string", "null"]},
        "lastScrape": {"type": ["string", "null"], "description": "Latest source generation timestamp. Treat advice as of this date."},
        "licence": {"type": ["string", "null"]},
        "class": {"type": "string"},
        "spec": {"type": "string"},
        "statPriorities": {"type": ["array", "null"]},
        "statTargets": {"type": ["array", "null"]},
        "talentBuilds": {"type": ["array", "null"]},
        "rankings": {"type": ["array", "null"], "description": "Observed U.GG rankings with count, popularity, activity and encounter context."},
        "rotation": {"type": ["array", "object", "null"]},
        "trinkets": {"type": ["array", "null"]},
        "enchants": {"type": ["array", "null"]},
        "gems": {"type": ["array", "null"]},
        "consumables": {"type": ["array", "null"]},
        "bisGear": {"type": ["object", "null"]},
        "crafting": {"type": ["array", "null"]},
        "omniumFolio": {"type": ["array", "null"]},
        "sourceMetadata": {"type": ["object", "null"]},
        "sourceUrls": {"type": ["object", "null"]},
        "knownSpecs": {"type": "array", "items": {"type": "string"}},
        "warnings": {"type": ["array", "null"], "items": {"type": "string"}},
        "contractViolation": {"type": ["object", "null"]},
    },
    "required": ["provenance", "source", "available"],
    "additionalProperties": False,
}

GUIDANCE_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [GUIDANCE_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

# Mixed provenance by design: `equipped` is Blizzard, `recommendation` is
# community. Each slot carries both so the two can never be conflated.
GEAR_AUDIT_SUCCESS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "character": {"type": ["object", "null"]},
        "spec": {"type": ["object", "null"]},
        "guidance": {"type": ["object", "null"]},
        "guidanceUnavailable": {"type": "string"},
        "summary": {"type": "object"},
        "slots": {"type": "array"},
        "trinketUpgrades": {"type": "array"},
    },
    "required": ["summary", "slots"],
    "additionalProperties": False,
}

GEAR_AUDIT_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [GEAR_AUDIT_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

SEASON_REWARDS_SUCCESS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "season": {"type": "string"},
        "patch": {"type": "string"},
        "verifiedAt": {"type": "string", "description": "Date the curated values were last checked against their sources."},
        "provenance": {"const": "curated", "description": "Always 'curated'. This is never Blizzard Profile API output."},
        "disclaimer": {"type": "string"},
        "sources": {"type": "array", "items": {"type": "string"}},
        "category": {"type": "string", "enum": list(SEASON_REWARD_CATEGORIES)},
        "delves": {"type": "object"},
        "mythicPlus": {"type": "object"},
        "crests": {"type": "object"},
        "greatVault": {"type": "object"},
        "raid": {"type": "object"},
        "aboveTrack": {"type": "object"},
        "currencies": {"type": "object"},
        "recommendedActivities": {
            "type": "object",
            "properties": {
                "itemLevel": {"type": "integer"},
                "goal": {"type": "string"},
                "provenance": {"const": "curated"},
                "advisory": {"const": True},
                "note": {"type": "string"},
                "suggestions": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "activity": {"type": "string"},
                            "source": {"type": "string"},
                            "rewardItemLevel": {"type": "integer"},
                            "reason": {"type": "string", "description": "The rule that selected this activity."},
                        },
                        "required": ["activity", "source", "rewardItemLevel", "reason"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["itemLevel", "goal", "provenance", "advisory", "note", "suggestions"],
            "additionalProperties": False,
        },
        # `seasonDataUnavailable` is a legitimate success: the season rolled
        # over and there is no curated data for it yet. It must validate
        # against this schema, or a normal degradation becomes invalid MCP
        # structured output and the tool looks broken to an agent.
        "seasonDataUnavailable": {"type": "boolean"},
        "seasonId": {"type": ["integer", "null"]},
        "knownSeasonIds": {"type": "array", "items": {"type": "integer"}},
        "message": {"type": "string"},
    },
    # Only provenance and category are guaranteed on every response; the season
    # descriptors are absent precisely when the season is unknown.
    "required": ["provenance", "category"],
    "additionalProperties": False,
}

SEASON_REWARDS_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [SEASON_REWARDS_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

CHARACTER_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [CHARACTER_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

REALMS_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [REALMS_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

TALENTS_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [TALENTS_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

PROFILE_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [PROFILE_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}

ACHIEVEMENTS_OUTPUT_SCHEMA: dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "oneOf": [ACHIEVEMENTS_SUCCESS_SCHEMA, ERROR_OUTPUT_SCHEMA],
}


CHARACTER_TOOL = types.Tool(
    name="get_character_equipment",
    title="Get Character Equipment",
    description=(
        "Get a World of Warcraft character's equipped items from Blizzard, including exact current "
        "Season 2 upgrade paths and the first rank in every Season 2 track that beats each item. "
        "Results use the site's shared five-minute server cache. Set refresh=true only when the user "
        "explicitly needs a fresh Armory check; forced refreshes have a one-minute per-character cooldown."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "region": {
                "type": "string",
                "enum": [*REGIONS, *(region.upper() for region in REGIONS)],
                "description": "Blizzard region: us, eu, kr, or tw.",
            },
            "realm": {"type": "string", "minLength": 1, "maxLength": 80},
            "character": {"type": "string", "minLength": 1, "maxLength": 24},
            "refresh": {
                "type": "boolean",
                "default": False,
                "description": "Request a Blizzard refresh, subject to the shared one-minute cooldown.",
            },
        },
        "required": ["region", "realm", "character"],
        "additionalProperties": False,
    },
    outputSchema=CHARACTER_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Character Equipment",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

CHARACTER_LOOKUP_INPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "region": {
            "type": "string",
            "enum": [*REGIONS, *(region.upper() for region in REGIONS)],
            "description": "Blizzard region: us, eu, kr, or tw.",
        },
        "realm": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "description": "Realm display name or slug; use list_realms when uncertain.",
        },
        "character": {"type": "string", "minLength": 1, "maxLength": 24},
        "refresh": {
            "type": "boolean",
            "default": False,
            "description": "Request a Blizzard refresh, subject to the shared one-minute cooldown.",
        },
    },
    "required": ["region", "realm", "character"],
    "additionalProperties": False,
}

TALENTS_TOOL = types.Tool(
    name="get_character_talents",
    title="Get Character Talent Build",
    description=(
        "Get a World of Warcraft character's currently active specialization and talent build from Blizzard. "
        "Returns the in-game import code plus structured class, specialization, and hero talent selections. "
        "Use this for the character's logged-out Armory build, not for recommended builds. Results share the "
        "site's five-minute cache and one-minute forced-refresh cooldown."
    ),
    inputSchema=CHARACTER_LOOKUP_INPUT_SCHEMA,
    outputSchema=TALENTS_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Character Talent Build",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

PROFILE_TOOL = types.Tool(
    name="get_character_profile",
    title="Get Character Profile and Mythic Plus",
    description=(
        "Get a compact World of Warcraft character profile from Blizzard, including class, race, faction, guild, "
        "active specialization, item levels, achievement points, last login time, current-season Mythic+ rating, "
        "and best dungeon runs. Use this for high-level character context rather than per-item gear or talent details. "
        "Results share the site's five-minute cache and one-minute forced-refresh cooldown."
    ),
    inputSchema=CHARACTER_LOOKUP_INPUT_SCHEMA,
    outputSchema=PROFILE_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Character Profile and Mythic Plus",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

ACHIEVEMENTS_TOOL = types.Tool(
    name="get_character_achievements",
    title="Get Character Achievement Summary",
    description=(
        "Get a compact World of Warcraft achievement summary from Blizzard: completed-achievement count, total "
        "points, and up to 25 recent completions with timestamps. This intentionally does not return the character's "
        "entire multi-thousand-entry achievement history. Results share the site's five-minute cache and one-minute "
        "forced-refresh cooldown."
    ),
    inputSchema=CHARACTER_LOOKUP_INPUT_SCHEMA,
    outputSchema=ACHIEVEMENTS_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Character Achievement Summary",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

REALMS_TOOL = types.Tool(
    name="list_realms",
    title="List World of Warcraft Realms",
    description=(
        "List Blizzard realms for a region as structured id, display name, and slug values. "
        "Use this to discover or validate the realm slug before querying a character. Results use "
        "the site's shared one-day Realm Index cache."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "region": {
                "type": "string",
                "enum": [*REGIONS, *(region.upper() for region in REGIONS)],
                "description": "Blizzard region: us, eu, kr, or tw.",
            },
        },
        "required": ["region"],
        "additionalProperties": False,
    },
    outputSchema=REALMS_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="List World of Warcraft Realms",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

SEASON_REWARDS_TOOL = types.Tool(
    name="get_season_rewards",
    title="Get Curated Season Reward Rules",
    description=(
        "Get curated Midnight Season 2 reward rules: Delve tiers, Mythic+ end-of-run and Great Vault "
        "item levels, crest types and sources, Great Vault unlock thresholds, raid reward bands, and "
        "seasonal currencies. Optionally derive deterministic activity suggestions for a supplied item "
        "level. This is hand-curated community data labelled provenance='curated', NOT Blizzard Profile "
        "API output, and it never reports a character's owned currency balances. Crest quantities per "
        "run are unconfirmed in public sources and are returned as null."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "enum": list(SEASON_REWARD_CATEGORIES),
                "description": "Which section to return. Defaults to 'all'.",
            },
            "itemLevel": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000,
                "description": "Character item level. Required for 'recommended_activities'; optional elsewhere.",
            },
        },
        "required": [],
        "additionalProperties": False,
    },
    outputSchema=SEASON_REWARDS_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Curated Season Reward Rules",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

GUIDANCE_TOOL = types.Tool(
    name="get_class_guidance",
    title="Get Class Guidance",
    description=(
        "Get source-labelled class guidance: Icy Veins editorial priorities/builds/gear and U.GG observed "
        "build, gear, trinket and ranking data. U.GG rows carry activity, optional encounter, popularity and "
        "observation count. This is community guidance imported from the user-supplied ClassCodex addon, never "
        "Blizzard data. Use activity, heroTalent, encounterId or source to keep results focused. Pass specId to "
        "have talent builds decoded into named talents."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "className": {"type": "string", "description": "Class name, e.g. 'paladin'."},
            "spec": {"type": "string", "description": "Specialization, e.g. 'holy'."},
            "specId": {"type": "integer", "minimum": 1, "description": "Blizzard spec id; supplying it decodes the talent builds."},
            "activity": {"type": "string", "description": "Optional activity: mplus, raid, pvp, delve, or general."},
            "heroTalent": {"type": "string", "description": "Optional ClassCodex hero talent key, e.g. lightsmith."},
            "encounterId": {"type": "integer", "minimum": 1, "description": "Optional U.GG dungeon or boss id."},
            "source": {"type": "string", "enum": ["icyveins", "ugg"], "description": "Optional community source filter."},
        },
        "required": ["className", "spec"],
        "additionalProperties": False,
    },
    outputSchema=GUIDANCE_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Class Guidance",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

GEAR_AUDIT_TOOL = types.Tool(
    name="get_gear_audit",
    title="Audit Equipped Gear Against Recommendations",
    description=(
        "Cross-reference a character's equipped items against recommended best-in-slot and trinket "
        "lists, reporting which slots are already best-in-slot, which are merely listed, and which "
        "high-tier trinkets are missing along with the boss that drops them. The character's class and "
        "specialization are read from Blizzard, not from the caller. Each finding states its side: what "
        "is equipped is provenance='blizzard' and authoritative, what is recommended is "
        "provenance='community' opinion carrying its own scrape date. Slots the guidance has no opinion "
        "on are reported without a recommendation rather than as a problem."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "region": {"type": "string", "enum": [*REGIONS, *(region.upper() for region in REGIONS)]},
            "realm": {"type": "string", "description": "Realm slug, e.g. 'dathremar'."},
            "character": {"type": "string", "description": "Character name."},
        },
        "required": ["region", "realm", "character"],
        "additionalProperties": False,
    },
    outputSchema=GEAR_AUDIT_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Audit Equipped Gear Against Recommendations",
        readOnlyHint=True,
        destructiveHint=False,
        idempotentHint=True,
        openWorldHint=True,
    ),
)

MYTHIC_PLANNER_TOOL = types.Tool(
    name="get_mythic_planner",
    title="Plan Mythic Plus Dungeon Targets",
    description=(
        "Plan a character's current-season Mythic+ dungeons. Returns Blizzard best-run snapshots, curated "
        "end-of-run and Vault rewards, and source-linked class-eligible upgrade targets, with dated community "
        "guide matches ranked first. It does not claim drops are guaranteed or measure a fixed group's capability."
    ),
    inputSchema=CHARACTER_LOOKUP_INPUT_SCHEMA,
    outputSchema={"type": "object", "additionalProperties": True},
    annotations=types.ToolAnnotations(
        title="Plan Mythic Plus Dungeon Targets", readOnlyHint=True, destructiveHint=False,
        idempotentHint=True, openWorldHint=True,
    ),
)

RAID_PROGRESS_TOOL = types.Tool(
    name="get_raid_progress",
    title="Get Raid Progress",
    description=(
        "Get a character's raid progress from Blizzard: which bosses have been defeated in each "
        "current-season raid at each difficulty, how many kills, and when each was last killed. "
        "Authoritative Blizzard character data. This is lifetime raid progress, not weekly Vault state. "
        "For exact captured weekly Vault state, use list_character_inventories followed by get_character_inventory."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "region": {"type": "string", "enum": [*REGIONS, *(region.upper() for region in REGIONS)]},
            "realm": {"type": "string", "description": "Realm slug, e.g. 'dathremar'."},
            "character": {"type": "string", "description": "Character name."},
        },
        "required": ["region", "realm", "character"],
        "additionalProperties": False,
    },
    outputSchema=RAID_PROGRESS_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Raid Progress",
        readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True,
    ),
)

META_BUILDS_TOOL = types.Tool(
    name="get_meta_builds",
    title="Get Observed Top Mythic+ Comps and Builds",
    description=(
        "Get the team compositions and talent builds that top Mythic+ groups actually ran, aggregated "
        "from Raider.IO's leaderboard. This is OBSERVED data ('what top teams ran'), which is a "
        "different claim from get_class_guidance ('what a guide recommends') - do not merge the two. "
        "Returns composition frequencies, spec popularity, and the most common talent import strings "
        "per spec, decoded into named talents when specId is supplied. Attribution to Raider.IO is "
        "included and must be surfaced. A season with no runs yet returns empty lists, not an error."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "season": {"type": "string", "description": "Raider.IO season slug, e.g. 'season-mn-2'."},
            "region": {"type": "string", "enum": ["world", "us", "eu", "kr", "tw", "WORLD", "US", "EU", "KR", "TW"], "description": "Defaults to world. Case-insensitive, like the other tools."},
            "pages": {"type": "integer", "minimum": 1, "maximum": 5, "description": "Pages of 20 runs to aggregate. Defaults to 3."},
            "spec": {"type": "string", "description": "Filter to a spec, e.g. 'holy paladin'."},
            "specId": {"type": "integer", "minimum": 1, "description": "Blizzard spec id; supplying it decodes the builds."},
        },
        "required": ["season"],
        "additionalProperties": False,
    },
    outputSchema=META_BUILDS_OUTPUT_SCHEMA,
    annotations=types.ToolAnnotations(
        title="Get Observed Top Mythic+ Comps and Builds",
        readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True,
    ),
)

TOOLS = {
    tool.name: tool
    for tool in (CHARACTER_TOOL, TALENTS_TOOL, PROFILE_TOOL, ACHIEVEMENTS_TOOL, REALMS_TOOL, SEASON_REWARDS_TOOL, GUIDANCE_TOOL, GEAR_AUDIT_TOOL, MYTHIC_PLANNER_TOOL, RAID_PROGRESS_TOOL, META_BUILDS_TOOL)
}

TRACKER_OUTPUT_SCHEMA: dict[str, Any] = {"$schema":"https://json-schema.org/draft/2020-12/schema", "type":"object", "additionalProperties": True}

def _tracker_tool(name: str, title: str, description: str, properties: dict[str, Any], required: list[str], *, read_only: bool, destructive: bool = False) -> types.Tool:
    return types.Tool(name=name, title=title, description=description, inputSchema={"type":"object", "properties":properties, "required":required, "additionalProperties":False}, outputSchema=TRACKER_OUTPUT_SCHEMA, annotations=types.ToolAnnotations(title=title, readOnlyHint=read_only, destructiveHint=destructive, idempotentHint=read_only or name == "achievement_character_forget", openWorldHint=False))

TRACKER_TOOLS = (
    _tracker_tool("achievement_character_upsert", "Add or Update a Tracked Character", "Creates or updates a character selected for the persistent achievement tracker. This changes local tracker state only; it does not claim Blizzard completion data.", {"region":{"type":"string","enum":["us","eu","kr","tw","US","EU","KR","TW"]},"realm":{"type":"string","minLength":1,"maxLength":80},"name":{"type":"string","minLength":1,"maxLength":24},"realmSlug":{"type":"string"}}, ["region","realm","name"], read_only=False),
    _tracker_tool("achievement_character_list", "List My Tracked Characters", "Lists characters explicitly opened by the authenticated user, including their stable tracker identifiers. The shared achievement catalogue is not duplicated between users.", {}, [], read_only=True),
    _tracker_tool("achievement_character_forget", "Remove a Recent Character", "Removes one character from the authenticated user's recent-character chooser only. It does not delete the shared character, achievement catalogue, priorities, notes, or completion data, and reopening the character restores it.", {"characterId":{"type":"integer","minimum":1}}, ["characterId"], read_only=False, destructive=True),
    _tracker_tool("achievement_refresh_character", "Refresh Recent Blizzard Achievement Completions", "Fetches the selected character's current Blizzard achievement summary and records only explicit recent completion events as earned. It does not infer older completion state, criteria progress, or availability from totals.", {"characterId":{"type":"integer","minimum":1},"refresh":{"type":"boolean","description":"Ask the upstream cache to revalidate when its refresh cooldown permits."}}, ["characterId"], read_only=False),
    _tracker_tool("achievement_set_priority", "Set Achievement Priority", "Sets a per-character manual priority from -100 through 100. Higher values sort first in the priority queue and are explicitly reflected in planner explanations.", {"characterId":{"type":"integer","minimum":1},"achievementId":{"type":"integer","minimum":1},"priority":{"type":"integer","minimum":-100,"maximum":100}}, ["characterId","achievementId","priority"], read_only=False),
    _tracker_tool("achievement_priority_labels_get", "Get My Priority Labels", "Returns the authenticated user's labels for the -100 to 100 achievement-priority scale. Generic starter labels are returned until that user saves a personal legend; labels never belong to a character or another user.", {}, [], read_only=True),
    _tracker_tool("achievement_priority_labels_set", "Set My Priority Labels", "Replaces the authenticated user's achievement-priority legend with one to twelve unique labelled values between -100 and 100. This changes only the caller's labels, not any character priorities or other users' settings.", {"labels":{"type":"array","minItems":1,"maxItems":12,"items":{"type":"object","properties":{"priority":{"type":"integer","minimum":-100,"maximum":100},"label":{"type":"string","minLength":1,"maxLength":80}},"required":["priority","label"],"additionalProperties":False}}}, ["labels"], read_only=False),
    _tracker_tool("achievement_update_state", "Update Achievement State", "Records a user correction or user-confirmed earned state. In progress and ready to claim are intentionally read-only derived states: they are calculated from Blizzard's completed meta-achievement criteria and cannot be asserted manually through this tool.", {"characterId":{"type":"integer","minimum":1},"achievementId":{"type":"integer","minimum":1},"state":{"type":"string","enum":["unknown","unearned","earned"]},"source":{"type":"string","enum":["manual","manual_confirmation","blizzard"]},"earnedAt":{"type":"string","format":"date-time"},"note":{"type":"string","maxLength":2000}}, ["characterId","achievementId","state"], read_only=False),
    _tracker_tool("achievement_set_curated_metadata", "Store Verified Curated Achievement Metadata", "Stores agent-researched, verified guidance with required source provenance and verification time. This does not browse, scrape, or invent claims at runtime; expired guidance is excluded from plans.", {"achievementId":{"type":"integer","minimum":1},"name":{"type":"string","minLength":1,"maxLength":200},"whatToDo":{"type":"string","maxLength":4000},"fastestPathTip":{"type":"string","maxLength":4000},"estimatedMinutes":{"type":"integer","minimum":0},"difficulty":{"type":"string","maxLength":80},"groupRequirement":{"type":"string","maxLength":120},"availability":{"type":"string","maxLength":120},"availabilityReason":{"type":"string","maxLength":1000},"nextAvailableAt":{"type":"string","format":"date-time"},"deadline":{"type":"string","format":"date-time"},"deadlineReason":{"type":"string","maxLength":1000},"zone":{"type":"string","maxLength":120},"expansion":{"type":"string","maxLength":120},"season":{"type":"string","maxLength":120},"event":{"type":"string","maxLength":120},"reward":{"type":"string","maxLength":1000},"sourceName":{"type":"string","minLength":1,"maxLength":200},"sourceUrl":{"type":"string","format":"uri","maxLength":2000},"verifiedAt":{"type":"string","format":"date-time"},"expiresAt":{"type":"string","format":"date-time"}}, ["achievementId","sourceName","sourceUrl","verifiedAt"], read_only=False),
    _tracker_tool("achievement_list", "List Achievement Work Queue", "Returns a character's persistent achievement work queue. Achievements explicitly restricted by Blizzard to the opposite faction are excluded as unavailable by default; includeUnavailable reveals them with faction provenance. PvP can also be excluded using Blizzard's category hierarchy.", {"characterId":{"type":"integer","minimum":1},"order":{"type":"string","enum":["priority","new","expiring","updated"]},"state":{"type":"string","enum":["unknown","unearned","in_progress","completion_ready","earned"]},"onlyUnexpired":{"type":"boolean"},"excludePvp":{"type":"boolean"},"includeUnavailable":{"type":"boolean","description":"Include achievements Blizzard restricts to the opposite faction. Defaults to false."},"limit":{"type":"integer","minimum":1,"maximum":250}}, ["characterId"], read_only=True),
    _tracker_tool("achievement_compare", "Compare Character Achievement Needs", "Overlays a second tracked character on a primary character's achievement queue. By default it returns only achievements both still actionably need and can earn according to Blizzard faction requirements; PvP can be excluded using Blizzard's category hierarchy.", {"primaryCharacterId":{"type":"integer","minimum":1},"comparisonCharacterId":{"type":"integer","minimum":1},"neededByBoth":{"type":"boolean","description":"Defaults to true. When false, return the primary queue with the comparison state overlaid."},"excludePvp":{"type":"boolean"},"includeUnavailable":{"type":"boolean","description":"Include achievements restricted to the opposite faction of either character. Defaults to false."},"order":{"type":"string","enum":["priority","new","expiring","updated"]},"limit":{"type":"integer","minimum":1,"maximum":250}}, ["primaryCharacterId","comparisonCharacterId"], read_only=True),
    _tracker_tool("achievement_dashboard", "Get Achievement Dashboard", "Returns state counts and recent Blizzard-confirmed achievements for one or more selected tracker characters. This is a read-only aggregate suitable for a concise current-progress briefing.", {"characterIds":{"type":"array","items":{"type":"integer","minimum":1},"minItems":1,"maxItems":50,"uniqueItems":True}}, ["characterIds"], read_only=True),
    _tracker_tool("achievement_build_session_plan", "Build Shared Achievement Session Plan", "Builds an explainable shared session queue across selected characters. It boosts manual priority, verified deadlines, and activities needed by multiple selected characters; it never assumes undocumented completion.", {"characterIds":{"type":"array","items":{"type":"integer","minimum":1},"minItems":1,"maxItems":50,"uniqueItems":True},"limit":{"type":"integer","minimum":1,"maximum":100}}, ["characterIds"], read_only=True),
    _tracker_tool("list_character_inventories", "List My Character Inventory Snapshots", "Lists the authenticated user's latest private in-game inventory snapshots. Use this first for inventory or Great Vault questions to obtain a characterId, then call get_character_inventory. Each summary states when its capture occurred, equipped/bag/current-spell counts, capped-currency, decor-inventory and cached profession-entry counts when exported, and that its provenance is an in-game export; it never returns another user's data.", {}, [], read_only=True),
    _tracker_tool("get_character_inventory", "Get Character Inventory", "Returns the authenticated user's latest rich in-game snapshot for one character and is authoritative for the state captured by HammerLink in game. Depending on the player's enabled export options, it includes equipped items, every occupied backpack/bag/reagent-bag slot, the client-exposed current spellbook, talent import, exact captured Great Vault state, capped-currency records, owned Housing Catalog decor with stored/placed counts, current quest log facts, and cached learned profession entries. Current spellbook entries can include abilities marked off-spec; hidden and inactive-specialisation coverage may be incomplete. Profession entries are positive in-game observations that can include recipes, gathering techniques and bonuses: Retail exposes them only after the player opens the matching profession panel, so an uncached profession or absent entry is unknown, not evidence that the character lacks it. Check snapshot.currentSpellbook and snapshot.professionRecipes, their reason/truncated states, and the matching snapshot.exportOptions fields before answering spell or profession-ownership questions. For capped currencies, quantity is the current wallet amount; when useTotalEarnedForMaxQty is true, totalEarned/maxQuantity is seasonal cap progress, not the current balance. Spending can lower quantity without lowering totalEarned. quantityEarnedThisWeek/maxWeeklyQuantity is weekly cap progress when canEarnPerWeek is true. Quest-log data is a point-in-time list of currently active quests, not complete quest history or route advice. HammerLink format 3 exports contain the complete owned decor catalogue; older snapshots can be incomplete when snapshot.decorInventory.truncated is true, so never infer that an absent decor item is unowned from a truncated snapshot. Currency caps are ordered from lower to higher upgrade tier (Adventurer, Veteran, Champion, Hero, Myth), followed by Voidcore, Dust, then other records alphabetically. Great Vault activities include activityTypeName, threshold-clamped displayProgress and isComplete for player-facing interpretation; progress remains Blizzard's raw cumulative category value. Item records preserve full link, ID, name, stack count, location, type/subtype, quality, item levels, binding, sell value, icon, stats, gems, durability, equipment-set membership and client metadata when available. Check snapshot.exportOptions and capturedAt before assuming a category was collected or is current. This private in-game export excludes bank and warband-bank items and never reveals another user's snapshot.", {"characterId":{"type":"integer","minimum":1,"description":"Character ID from list_character_inventories."}}, ["characterId"], read_only=True),
    _tracker_tool("hammerlink_import_list", "List My HammerLink Imports (Legacy Alias)", "Compatibility alias for list_character_inventories. Prefer the generic inventory-named tool for new agent integrations; this alias returns the same private in-game snapshot summaries.", {}, [], read_only=True),
    _tracker_tool("hammerlink_import_get", "Get My HammerLink Character Import (Legacy Alias)", "Compatibility alias for get_character_inventory. Prefer the generic inventory-named tool for new agent integrations; this alias returns the same rich private in-game inventory snapshot.", {"characterId":{"type":"integer","minimum":1}}, ["characterId"], read_only=True),
)
TOOLS.update({tool.name: tool for tool in TRACKER_TOOLS})


def _request_metadata(context: ServerRequestContext[Any, Request]) -> dict[str, Any]:
    request = context.request
    headers = request.headers if request is not None else {}
    caller_address = str(headers.get("x-real-ip") or "").strip() or (
        request.client.host if request and request.client else None
    )
    session = getattr(context, "session", None)
    client_params = getattr(session, "client_params", None)
    client_info = client_params.client_info if client_params is not None else None
    # Browser tracker calls are keyed by Authelia's Remote-User (the username).
    # The OAuth gateway supplies the same identity as preferred_username, while
    # `sub` is an opaque, different value. Prefer the username so one account
    # owns the same private imports in both browser and MCP sessions.
    username = str(headers.get("x-auth-request-preferred-username") or "").strip()
    subject = str(headers.get("x-auth-request-sub") or "").strip()
    principal = username or subject
    metadata = {
        "callerAddress": caller_address,
        "userAgent": str(headers.get("user-agent") or "")[:300] or None,
        "clientName": client_info.name if client_info is not None else None,
        "clientVersion": client_info.version if client_info is not None else None,
        "protocolVersion": context.protocol_version,
    }
    # Persist a non-reversible actor correlation id, never a raw OAuth subject.
    if principal:
        metadata["actor"] = hashlib.sha256(principal.encode("utf-8")).hexdigest()[:24]
    return metadata


def _write_audit(record: dict[str, Any]) -> None:
    line = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    LOGGER.info("wow_mcp_query %s", line)
    with AUDIT_LOCK:
        with AUDIT_LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())


def _validate_character_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    region = str(arguments.get("region") or "").strip().lower()
    realm = str(arguments.get("realm") or "").strip()
    character = str(arguments.get("character") or "").strip()
    refresh = arguments.get("refresh", False)
    if region not in REGIONS:
        raise ValueError("region must be one of: us, eu, kr, tw")
    if not realm or len(realm) > 80:
        raise ValueError("realm must contain 1 to 80 characters")
    if not character or len(character) > 24:
        raise ValueError("character must contain 1 to 24 characters")
    if not isinstance(refresh, bool):
        raise ValueError("refresh must be a boolean")
    return {"region": region, "realm": realm, "character": character, "refresh": refresh}


def _validate_region_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    region = str(arguments.get("region") or "").strip().lower()
    if region not in REGIONS:
        raise ValueError("region must be one of: us, eu, kr, tw")
    return {"region": region}


def _validate_season_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    category = arguments.get("category", "all")
    if not isinstance(category, str) or category.lower() not in SEASON_REWARD_CATEGORIES:
        raise ValueError("category must be one of: " + ", ".join(SEASON_REWARD_CATEGORIES))
    category = category.lower()
    raw_item_level = arguments.get("itemLevel")
    item_level: int | None = None
    if raw_item_level is not None:
        # bool is an int subclass; reject it explicitly.
        if isinstance(raw_item_level, bool) or not isinstance(raw_item_level, int):
            raise ValueError("itemLevel must be a whole number")
        if not 1 <= raw_item_level <= 1000:
            raise ValueError("itemLevel must be between 1 and 1000")
        item_level = raw_item_level
    if category == "recommended_activities" and item_level is None:
        raise ValueError("recommended_activities requires an itemLevel")
    return {"category": category, "itemLevel": item_level}


def _validate_guidance_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    class_name = arguments.get("className")
    spec = arguments.get("spec")
    for label, value in (("className", class_name), ("spec", spec)):
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z ]{2,24}", value.strip()):
            raise ValueError(f"{label} must be a class or specialization name")
    spec_id = arguments.get("specId")
    if spec_id is not None:
        if isinstance(spec_id, bool) or not isinstance(spec_id, int) or spec_id < 1:
            raise ValueError("specId must be a positive whole number")
    activity = arguments.get("activity")
    if activity is not None:
        if not isinstance(activity, str) or not re.fullmatch(r"[a-z0-9+_-]{2,30}", activity.strip().lower()):
            raise ValueError("activity must be a valid activity key")
        activity = activity.strip().lower()
    hero_talent = arguments.get("heroTalent")
    if hero_talent is not None:
        if not isinstance(hero_talent, str) or not re.fullmatch(r"[a-z0-9-]{2,48}", hero_talent.strip().lower()):
            raise ValueError("heroTalent must be a valid hero talent key")
        hero_talent = hero_talent.strip().lower()
    encounter_id = arguments.get("encounterId")
    if encounter_id is not None and (isinstance(encounter_id, bool) or not isinstance(encounter_id, int) or encounter_id < 1):
        raise ValueError("encounterId must be a positive whole number")
    source = arguments.get("source")
    if source is not None:
        if not isinstance(source, str) or source.lower() not in {"icyveins", "ugg"}:
            raise ValueError("source must be icyveins or ugg")
        source = source.lower()
    return {
        "className": class_name.strip().lower(),
        "spec": spec.strip().lower(),
        "specId": spec_id,
        "activity": activity,
        "heroTalent": hero_talent,
        "encounterId": encounter_id,
        "source": source,
    }


def _validate_meta_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    season = arguments.get("season")
    if not isinstance(season, str) or not re.fullmatch(r"[a-z0-9-]{3,40}", season.strip().lower()):
        raise ValueError("season must be a Raider.IO season slug, e.g. season-mn-2")
    region = arguments.get("region", "world")
    if not isinstance(region, str) or region.lower() not in {"world", "us", "eu", "kr", "tw"}:
        raise ValueError("region must be world, us, eu, kr or tw")
    pages = arguments.get("pages", 3)
    if isinstance(pages, bool) or not isinstance(pages, int) or not 1 <= pages <= 5:
        raise ValueError("pages must be a whole number between 1 and 5")
    spec = arguments.get("spec")
    if spec is not None and (not isinstance(spec, str) or not re.fullmatch(r"[A-Za-z ]{2,40}", spec.strip())):
        raise ValueError("spec must be a specialization name")
    spec_id = arguments.get("specId")
    if spec_id is not None and (isinstance(spec_id, bool) or not isinstance(spec_id, int) or spec_id < 1):
        raise ValueError("specId must be a positive whole number")
    return {
        "season": season.strip().lower(),
        "region": region.lower(),
        "pages": pages,
        "spec": spec.strip().lower() if isinstance(spec, str) else None,
        "specId": spec_id,
    }


def _upstream_query(
    path: str,
    query: dict[str, Any],
    caller_address: str | None,
) -> tuple[dict[str, Any], int, str | None]:
    request = urllib.request.Request(
        f"{UPSTREAM_URL}{path}?{urllib.parse.urlencode(query)}",
        headers={
            "Accept": "application/json",
            "User-Agent": "wow-site-mcp/1.0",
            **({"X-Forwarded-For": caller_address} if caller_address else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode("utf-8")), response.status, response.headers.get("Retry-After")
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"error": "upstream_error", "message": raw or f"Upstream returned HTTP {error.code}."}
        return payload, error.code, error.headers.get("Retry-After")


def _invoke_tool(
    name: str,
    arguments: dict[str, Any],
    metadata: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    started = time.monotonic()
    character_tools = {
        CHARACTER_TOOL.name: "/api/character",
        GEAR_AUDIT_TOOL.name: "/api/gear-audit",
        MYTHIC_PLANNER_TOOL.name: "/api/mythic-planner",
        RAID_PROGRESS_TOOL.name: "/api/raid-progress",
        TALENTS_TOOL.name: "/api/talents",
        PROFILE_TOOL.name: "/api/profile",
        ACHIEVEMENTS_TOOL.name: "/api/achievements",
    }
    if name in character_tools:
        audit_arguments: dict[str, Any] = {
            "region": arguments.get("region"),
            "realm": arguments.get("realm"),
            "character": arguments.get("character"),
            "refresh": arguments.get("refresh", False),
        }
    elif name == REALMS_TOOL.name:
        audit_arguments = {"region": arguments.get("region")}
    elif name == META_BUILDS_TOOL.name:
        audit_arguments = {
            "season": arguments.get("season"),
            "region": arguments.get("region"),
            "spec": arguments.get("spec"),
        }
    elif name == GUIDANCE_TOOL.name:
        audit_arguments = {
            "className": arguments.get("className"),
            "spec": arguments.get("spec"),
            "specId": arguments.get("specId"),
        }
    elif name == SEASON_REWARDS_TOOL.name:
        audit_arguments = {
            "category": arguments.get("category", "all"),
            "itemLevel": arguments.get("itemLevel"),
        }
    else:
        audit_arguments = {}
    outcome = "error"
    http_status: int | None = None
    cache_status: str | None = None
    error_code: str | None = None
    try:
        if name in {tool.name for tool in TRACKER_TOOLS}:
            actor = metadata.get("actor")
            if name == "achievement_character_upsert":
                value = dict(arguments)
                value["region"] = str(value.get("region") or "").lower()
                if value["region"] not in REGIONS or not isinstance(value.get("realm"), str) or not isinstance(value.get("name"), str):
                    raise ValueError("region, realm and name must be valid character values")
                result = TRACKER.add_character(value, actor)
            elif name == "achievement_character_list":
                result = TRACKER.list_characters(actor)
            elif name == "achievement_character_forget":
                result = TRACKER.forget_character(int(arguments["characterId"]), actor)
            elif name == "achievement_refresh_character":
                identity = TRACKER.character_identity(int(arguments["characterId"]))
                query = {"region": identity["region"], "realm": identity["realm"], "name": identity["name"]}
                if arguments.get("refresh", False): query["refresh"] = "1"
                payload, http_status, retry_after = _upstream_query("/api/achievements", query, metadata.get("callerAddress"))
                if http_status != 200:
                    result = {"error": str(payload.get("error") or "upstream_error"), "message": str(payload.get("message") or "Blizzard achievement refresh failed."), "httpStatus": http_status}
                    if retry_after: result["retryAfterSeconds"] = int(retry_after) if retry_after.isdigit() else retry_after
                    error_code = result["error"]
                    return result, True
                character = payload.get("character") or {}
                if character.get("name") and character.get("realm"):
                    TRACKER.add_character({
                        "region": identity["region"], "realm": character["realm"],
                        "realmSlug": character.get("realmSlug"), "name": character["name"],
                        "race": character.get("race"), "characterClass": character.get("characterClass"),
                        "faction": character.get("faction"),
                        "avatarUrl": character.get("avatarUrl"),
                    }, actor)
                result = TRACKER.record_blizzard_recent(int(arguments["characterId"]), payload.get("recentAchievements") or [], actor)
            elif name == "achievement_set_priority":
                result = TRACKER.set_priority(int(arguments["characterId"]), int(arguments["achievementId"]), int(arguments["priority"]), actor)
            elif name == "achievement_priority_labels_get":
                result = TRACKER.user_priority_labels(actor)
            elif name == "achievement_priority_labels_set":
                result = TRACKER.set_user_priority_labels(actor or '', arguments["labels"])
            elif name == "achievement_update_state": result = TRACKER.update_state(arguments, actor)
            elif name == "achievement_set_curated_metadata": result = TRACKER.curate(arguments, actor)
            elif name == "achievement_list": result = TRACKER.list_achievements({**arguments, "actor": actor})
            elif name == "achievement_compare":
                primary_id = int(arguments["primaryCharacterId"])
                comparison_id = int(arguments["comparisonCharacterId"])
                if actor and (not TRACKER.user_has_character(actor, primary_id) or not TRACKER.user_has_character(actor, comparison_id)):
                    raise ValueError("open both characters with this account before comparing them")
                result = TRACKER.list_achievements({
                    "actor": actor,
                    "characterId": primary_id,
                    "compareCharacterId": comparison_id,
                    "neededByBoth": arguments.get("neededByBoth", True),
                    "excludePvp": arguments.get("excludePvp", False),
                    "includeUnavailable": arguments.get("includeUnavailable", False),
                    "order": arguments.get("order", "priority"),
                    "limit": int(arguments.get("limit", 100)),
                })
            elif name == "achievement_dashboard": result = TRACKER.dashboard(arguments["characterIds"], actor)
            elif name == "achievement_build_session_plan": result = TRACKER.plan(arguments["characterIds"], int(arguments.get("limit", 20)), actor)
            elif name in ("list_character_inventories", "hammerlink_import_list"):
                if not actor: raise ValueError("authentication is required to read HammerLink imports")
                result = TRACKER.list_hammerlink_imports(actor)
            elif name in ("get_character_inventory", "hammerlink_import_get"):
                if not actor: raise ValueError("authentication is required to read a HammerLink import")
                result = TRACKER.hammerlink_import(actor, int(arguments["characterId"]))
            else:
                raise ValueError(f"unknown tracker tool: {name}")
            outcome = "success"
            return result, False
        if name in character_tools:
            validated = _validate_character_arguments(arguments)
            query = {
                "region": validated["region"],
                "realm": validated["realm"],
                "name": validated["character"],
            }
            if validated["refresh"]:
                query["refresh"] = "1"
            path = character_tools[name]
        elif name == REALMS_TOOL.name:
            validated = _validate_region_arguments(arguments)
            query = {"region": validated["region"]}
            path = "/api/realms"
        elif name == META_BUILDS_TOOL.name:
            validated = _validate_meta_arguments(arguments)
            query = {"season": validated["season"], "region": validated["region"], "pages": validated["pages"]}
            if validated["spec"]:
                query["spec"] = validated["spec"]
            if validated["specId"] is not None:
                query["specId"] = validated["specId"]
            path = "/api/meta-builds"
        elif name == GUIDANCE_TOOL.name:
            validated = _validate_guidance_arguments(arguments)
            query = {"class": validated["className"], "spec": validated["spec"]}
            if validated["specId"] is not None:
                query["specId"] = validated["specId"]
            if validated["activity"]:
                query["activity"] = validated["activity"]
            if validated["heroTalent"]:
                query["heroTalent"] = validated["heroTalent"]
            if validated["encounterId"] is not None:
                query["encounterId"] = validated["encounterId"]
            if validated["source"]:
                query["source"] = validated["source"]
            path = "/api/class-guidance"
        elif name == SEASON_REWARDS_TOOL.name:
            validated = _validate_season_arguments(arguments)
            query = {"category": validated["category"]}
            if validated["itemLevel"] is not None:
                query["itemLevel"] = validated["itemLevel"]
            path = "/api/season-rewards"
        else:
            error_code = "unknown_tool"
            return {"error": error_code, "message": f"Unknown tool: {name}"}, True
        audit_arguments = validated
        payload, http_status, retry_after = _upstream_query(path, query, metadata.get("callerAddress"))
        if http_status != 200:
            error_code = str(payload.get("error") or "upstream_error")
            result = {
                "error": error_code,
                "message": str(payload.get("message") or f"Character service returned HTTP {http_status}."),
                "httpStatus": http_status,
            }
            if retry_after:
                result["retryAfterSeconds"] = int(retry_after) if retry_after.isdigit() else retry_after
            return result, True
        cache_status = str((payload.get("cache") or {}).get("status") or "") or None
        outcome = "success"
        return payload, False
    except ValueError as error:
        error_code = "invalid_arguments"
        return {"error": error_code, "message": str(error)}, True
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        error_code = "character_service_unavailable"
        return {"error": error_code, "message": f"Character service request failed: {error}"}, True
    except Exception as error:  # noqa: BLE001
        error_code = "internal_error"
        return {"error": error_code, "message": f"Unexpected MCP tool failure: {error}"}, True
    finally:
        _write_audit(
            {
                "timestamp": datetime.now(UTC).isoformat(),
                "event": "mcp_tool_query",
                "tool": name,
                "arguments": audit_arguments,
                "outcome": outcome,
                "errorCode": error_code,
                "httpStatus": http_status,
                "cacheStatus": cache_status,
                "durationMs": round((time.monotonic() - started) * 1000, 2),
                **metadata,
            }
        )


async def _list_tools(
    _context: ServerRequestContext[Any, Request],
    _params: types.PaginatedRequestParams | None,
) -> types.ListToolsResult:
    return types.ListToolsResult(tools=list(TOOLS.values()))


async def _call_tool(
    context: ServerRequestContext[Any, Request],
    params: types.CallToolRequestParams,
) -> types.CallToolResult:
    metadata = _request_metadata(context)
    result, is_error = await anyio.to_thread.run_sync(
        lambda: _invoke_tool(params.name, params.arguments or {}, metadata)
    )
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False, indent=2))],
        structuredContent=result,
        isError=is_error,
    )


@asynccontextmanager
async def _lifespan(_server: Server):
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG_PATH.open("a", encoding="utf-8"):
        pass
    AUDIT_LOG_PATH.chmod(0o640)
    TRACKER.initialise()
    yield None


async def _healthz(_request: Request) -> Response:
    return PlainTextResponse("ok\n")


async def _version(_request: Request) -> Response:
    return JSONResponse({"service": "wow-site-mcp", "version": "1.1.0", "tools": sorted(TOOLS)})


mcp_server = Server(
    name="wow-site-mcp",
    version="1.1.0",
    instructions=(
        "Read-only World of Warcraft character data from Blizzard. Use get_character_profile for compact identity, "
        "progression, and current Mythic+ context; get_character_equipment for equipped slots and Season 2 upgrade "
        "paths; get_character_talents for the current logged-out Armory build and import code; "
        "get_character_achievements for totals and recent completions; list_realms to discover realm slugs; and "
        "get_season_rewards for curated season reward rules and deterministic activity suggestions; "
        "get_class_guidance for recommended stats, talent builds, trinkets and best-in-slot lists; and "
        "get_gear_audit to cross-reference equipped items against those recommendations; "
        "list_character_inventories followed by get_character_inventory for authoritative captured in-game inventory, "
        "currencies, Housing decor and Great Vault state; get_raid_progress for boss "
        "kills; and get_meta_builds for what top Mythic+ teams actually ran. "
        "Character data comes from Blizzard; season reward rules are curated community data labelled "
        "provenance='curated'."
    ),
    lifespan=_lifespan,
    on_list_tools=_list_tools,
    on_call_tool=_call_tool,
)

app = mcp_server.streamable_http_app(
    streamable_http_path="/mcp",
    json_response=True,
    stateless_http=True,
    max_request_body_size=MAX_REQUEST_BYTES,
    host=HOST,
    custom_starlette_routes=[
        Route("/healthz", _healthz, methods=["GET"]),
        Route("/version", _version, methods=["GET"]),
    ],
)


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
