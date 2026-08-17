import json
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


LOGGER = logging.getLogger("uvicorn.error")
HOST = os.environ.get("WOW_MCP_HOST", "0.0.0.0")
PORT = int(os.environ.get("WOW_MCP_PORT", "8767"))
UPSTREAM_URL = os.environ.get("WOW_MCP_UPSTREAM_URL", "http://wow-site").rstrip("/")
AUDIT_LOG_PATH = Path(os.environ.get("WOW_MCP_AUDIT_LOG_PATH", "/data/queries.jsonl"))
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
GUIDANCE_SUCCESS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "provenance": {"const": "community"},
        "source": {"const": "classcodex"},
        "available": {"type": "boolean"},
        "reason": {"type": "string"},
        "addonVersion": {"type": ["string", "null"]},
        "lastScrape": {"type": ["string", "null"], "description": "Date the guidance was scraped. Treat advice as of this date."},
        "licence": {"type": ["string", "null"]},
        "class": {"type": "string"},
        "spec": {"type": "string"},
        "statPriorities": {"type": ["array", "null"]},
        "statTargets": {"type": ["object", "null"]},
        "talentBuilds": {"type": ["array", "null"]},
        "rotation": {"type": ["array", "object", "null"]},
        "trinkets": {"type": ["array", "null"]},
        "enchants": {"type": ["array", "null"]},
        "gems": {"type": ["object", "null"]},
        "consumables": {"type": ["object", "null"]},
        "bisGear": {"type": ["object", "null"]},
        "crafting": {"type": ["object", "null"]},
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
    },
    "required": ["season", "patch", "verifiedAt", "provenance", "disclaimer", "sources", "category"],
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
        "Get recommended stat priorities, stat targets, talent builds per content type (Raid, Mythic+, "
        "Delves), tiered trinkets with the boss that drops them, best-in-slot lists, enchants, gems, "
        "consumables and crafting for a class specialization. This is community guidance imported from "
        "the ClassCodex addon (MIT), aggregating Wowhead, Icy Veins, Archon and Murlok. It is labelled "
        "provenance='community' and carries lastScrape: treat it as advice as of that date, NOT as "
        "Blizzard data and NOT as current. Pass specId to have talent builds decoded into named talents."
    ),
    inputSchema={
        "type": "object",
        "properties": {
            "className": {"type": "string", "description": "Class name, e.g. 'paladin'."},
            "spec": {"type": "string", "description": "Specialization, e.g. 'holy'."},
            "specId": {"type": "integer", "minimum": 1, "description": "Blizzard spec id; supplying it decodes the talent builds."},
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

TOOLS = {
    tool.name: tool
    for tool in (CHARACTER_TOOL, TALENTS_TOOL, PROFILE_TOOL, ACHIEVEMENTS_TOOL, REALMS_TOOL, SEASON_REWARDS_TOOL, GUIDANCE_TOOL, GEAR_AUDIT_TOOL)
}


def _request_metadata(context: ServerRequestContext[Any, Request]) -> dict[str, Any]:
    request = context.request
    headers = request.headers if request is not None else {}
    caller_address = str(headers.get("x-real-ip") or "").strip() or (
        request.client.host if request and request.client else None
    )
    session = getattr(context, "session", None)
    client_params = getattr(session, "client_params", None)
    client_info = client_params.client_info if client_params is not None else None
    return {
        "callerAddress": caller_address,
        "userAgent": str(headers.get("user-agent") or "")[:300] or None,
        "clientName": client_info.name if client_info is not None else None,
        "clientVersion": client_info.version if client_info is not None else None,
        "protocolVersion": context.protocol_version,
    }


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
    return {
        "className": class_name.strip().lower(),
        "spec": spec.strip().lower(),
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
        elif name == GUIDANCE_TOOL.name:
            validated = _validate_guidance_arguments(arguments)
            query = {"class": validated["className"], "spec": validated["spec"]}
            if validated["specId"] is not None:
                query["specId"] = validated["specId"]
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
        "get_gear_audit to cross-reference equipped items against those recommendations. "
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
