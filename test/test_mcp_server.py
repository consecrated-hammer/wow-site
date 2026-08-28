import json
import tempfile
import unittest
from importlib.metadata import version
from pathlib import Path
from unittest.mock import patch

import anyio
from jsonschema import Draft202012Validator, validate
from mcp import Client

import mcp_server as server


def _success_character() -> dict:
    return {
        "source": "Blizzard",
        "character": {"name": "Bluehoof", "realm": "Dath'Remar", "region": "US"},
        "items": [],
        "fetchedAt": "2026-08-17T00:00:00.000Z",
        "cache": {
            "status": "hit",
            "refreshAvailableAt": "2026-08-17T00:01:00.000Z",
        },
    }


class WowMcpTests(unittest.TestCase):
    def test_hammerlink_tools_return_only_the_authenticated_users_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tracker = server.AchievementTracker(Path(directory) / "tracker.sqlite3")
            tracker.initialise()
            character = tracker.add_character({"region": "us", "realm": "DathRemar", "name": "Reilly"}, "bianca")["id"]
            tracker.select_character(character, "kevin")
            base = {
                "format": 1, "capturedAt": 1787200000,
                "character": {"name":"Reilly","realm":"DathRemar","region":1,"class":"PALADIN","level":80},
                "equipment": [], "talents": {"importString": None},
                "currencyCaps": [
                    {"currencyID":3509,"name":"Tidal Spark Dust","quantity":3,"totalEarned":3,"maxQuantity":5,"useTotalEarnedForMaxQty":True},
                    {"currencyID":3442,"name":"Adventurer Mistcrest","quantity":149},
                ],
                "currencies": {"available":True,"entries":[{"currencyID":3000,"name":"Traveler Coin","quantity":17}]},
                "reputations": {"available":True,"entries":[{"factionID":2507,"name":"Dornogal","reaction":5,"currentStanding":6000,"nextReactionThreshold":9000}]},
                "currentSpellbook": {"available":True,"spells":[{"spellID":17364,"name":"Stormstrike","skillLine":"Enhancement"}]},
                "vault": {"capturedAt":1787200000,"activities":[{"type":6,"index":1,"threshold":2,"progress":4}]},
            }
            tracker.save_hammerlink_import("bianca", character, {**base, "bagEquipment": [{"bag":0,"slot":1,"itemID":1,"link":"Bianca"}]})
            tracker.save_hammerlink_import("kevin", character, {**base, "bagEquipment": [{"bag":0,"slot":2,"itemID":2,"link":"Kevin"}]})
            with patch.object(server, "TRACKER", tracker):
                listed, list_error = server._invoke_tool("list_character_inventories", {}, {"actor": "kevin"})
                detail, detail_error = server._invoke_tool("get_character_inventory", {"characterId": character}, {"actor": "kevin"})
                legacy, legacy_error = server._invoke_tool("hammerlink_import_get", {"characterId": character}, {"actor": "kevin"})
                anonymous, anonymous_error = server._invoke_tool("list_character_inventories", {}, {})
            self.assertFalse(list_error or detail_error)
            self.assertEqual(len(listed["imports"]), 1)
            self.assertEqual(detail["snapshot"]["bagEquipment"][0]["itemID"], 2)
            self.assertEqual(detail["snapshot"]["vault"]["activities"][0]["activityTypeName"], "World activities")
            self.assertEqual(detail["snapshot"]["vault"]["activities"][0]["displayProgress"], 2)
            self.assertEqual(detail["snapshot"]["vault"]["activities"][0]["progress"], 4)
            self.assertEqual([item["currencyID"] for item in detail["snapshot"]["currencyCaps"]], [3442, 3509])
            self.assertEqual(detail["snapshot"]["currentSpellbook"]["spells"][0]["name"], "Stormstrike")
            self.assertEqual(detail["snapshot"]["currencies"]["entries"][0]["currencyID"], 3000)
            self.assertEqual(detail["snapshot"]["reputations"]["entries"][0]["factionID"], 2507)
            self.assertEqual(legacy["snapshot"]["bagEquipment"][0]["itemID"], 2)
            self.assertFalse(legacy_error)
            self.assertEqual(detail["provenance"], "in_game_export")
            self.assertIn("get_character_inventory", server.TOOLS)
            self.assertNotIn("get_great_vault_progress", server.TOOLS)
            self.assertIn("stack count", server.TOOLS["get_character_inventory"].description)
            self.assertIn("displayProgress", server.TOOLS["get_character_inventory"].description)
            self.assertIn("authoritative", server.TOOLS["get_character_inventory"].description)
            self.assertIn("Adventurer, Veteran, Champion", server.TOOLS["get_character_inventory"].description)
            self.assertIn("quest log", server.TOOLS["get_character_inventory"].description)
            self.assertIn("current spellbook", server.TOOLS["get_character_inventory"].description)
            self.assertIn("recipes, gathering techniques and bonuses", server.TOOLS["get_character_inventory"].description)
            self.assertIn("totalEarned/maxQuantity", server.TOOLS["get_character_inventory"].description)
            self.assertIn("current wallet amount", server.TOOLS["get_character_inventory"].description)
            self.assertIn("unknown, not evidence", server.TOOLS["get_character_inventory"].description)
            self.assertTrue(anonymous_error)
            self.assertIn("authentication", anonymous["message"])

    def test_recent_character_can_be_forgotten_without_deleting_shared_data(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tracker = server.AchievementTracker(Path(directory) / "tracker.sqlite3")
            tracker.initialise()
            character = tracker.add_character({"region": "us", "realm": "DathRemar", "name": "Visitor"}, "owner")["id"]
            with patch.object(server, "TRACKER", tracker):
                listed, list_error = server._invoke_tool("achievement_character_list", {}, {"actor": "owner"})
                forgotten, forget_error = server._invoke_tool("achievement_character_forget", {"characterId": character}, {"actor": "owner"})
                after, after_error = server._invoke_tool("achievement_character_list", {}, {"actor": "owner"})
            self.assertFalse(list_error or forget_error or after_error)
            self.assertEqual([item["id"] for item in listed["characters"]], [character])
            self.assertTrue(forgotten["removed"])
            self.assertEqual(after["characters"], [])
            self.assertEqual(tracker.character_identity(character)["name"], "Visitor")

    def test_achievement_comparison_is_exposed_as_a_read_only_mcp_tool(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            tracker = server.AchievementTracker(Path(directory) / "tracker.sqlite3")
            tracker.initialise()
            primary = tracker.add_character({"region": "us", "realm": "DathRemar", "name": "Reilly"}, "bianca")["id"]
            comparison = tracker.add_character({"region": "us", "realm": "DathRemar", "name": "Ferality"}, "bianca")["id"]
            tracker.set_priority(primary, 42, 100, "bianca")
            tracker.set_priority(comparison, 42, 0, "bianca")
            with tracker._connect() as db:
                db.execute(
                    "UPDATE user_achievement_overlays SET imported_tip='Use one helper.',imported_tip_source='Checklist' "
                    "WHERE user_id='bianca' AND character_id=? AND achievement_id=42",
                    (primary,),
                )
            tracker.update_state({"characterId": primary, "achievementId": 42, "state": "unearned", "source": "manual"}, "bianca")
            tracker.update_state({"characterId": comparison, "achievementId": 42, "state": "in_progress", "source": "manual", "progressCurrent": 2, "progressTarget": 5}, "bianca")
            with patch.object(server, "TRACKER", tracker):
                result, is_error = server._invoke_tool(
                    "achievement_compare",
                    {"primaryCharacterId": primary, "comparisonCharacterId": comparison},
                    {"actor": "bianca"},
                )
            self.assertFalse(is_error)
            self.assertTrue(result["neededByBoth"])
            self.assertEqual(result["achievements"][0]["comparisonState"], "in_progress")
            self.assertEqual(result["achievements"][0]["comparisonProgressCurrent"], 2)
            self.assertEqual(result["achievements"][0]["importedTip"], "Use one helper.")
            self.assertIn("excludePvp", server.TOOLS["achievement_compare"].input_schema["properties"])
            self.assertIn("excludePvp", server.TOOLS["achievement_list"].input_schema["properties"])
            self.assertIn("includeUnavailable", server.TOOLS["achievement_compare"].input_schema["properties"])
            self.assertIn("includeUnavailable", server.TOOLS["achievement_list"].input_schema["properties"])

            tracker.record_blizzard_recent(primary, [{
                "id": 42, "name": "Recent from Blizzard", "completedAt": "2026-08-20T01:02:03+00:00",
            }], "bianca")
            with patch.object(server, "TRACKER", tracker):
                dashboard, dashboard_error = server._invoke_tool(
                    "achievement_dashboard", {"characterIds": [primary]}, {"actor": "bianca"},
                )
            self.assertFalse(dashboard_error)
            self.assertEqual(dashboard["recentAchievements"][0]["achievements"][0]["name"], "Recent from Blizzard")

    def test_runtime_and_dual_protocol_discovery(self) -> None:
        self.assertEqual(version("mcp"), "2.0.0")

        async def discover(mode: str):
            async with Client(server.mcp_server, mode=mode) as client:
                listed = await client.list_tools()
                return client.protocol_version, listed.tools

        modern_version, modern_tools = anyio.run(discover, "auto")
        legacy_version, legacy_tools = anyio.run(discover, "legacy")
        self.assertEqual(modern_version, "2026-07-28")
        self.assertEqual(legacy_version, "2025-11-25")
        self.assertEqual({tool.name for tool in modern_tools}, set(server.TOOLS))
        self.assertEqual({tool.name for tool in legacy_tools}, set(server.TOOLS))

    def test_tools_have_agent_friendly_and_accurate_contracts(self) -> None:
        for tool in server.TOOLS.values():
            with self.subTest(tool=tool.name):
                self.assertTrue(tool.title)
                self.assertGreater(len(tool.description or ""), 80)
                self.assertIsNotNone(tool.output_schema)
                Draft202012Validator.check_schema(tool.input_schema)
                Draft202012Validator.check_schema(tool.output_schema)
                annotations = tool.annotations.model_dump(by_alias=True, exclude_none=True)
                self.assertEqual(annotations["readOnlyHint"], tool.name not in {
                    "achievement_character_upsert", "achievement_character_forget", "achievement_refresh_character", "achievement_set_priority", "achievement_priority_labels_set", "achievement_update_state", "achievement_set_curated_metadata"
                })
                self.assertEqual(annotations["destructiveHint"], tool.name == "achievement_character_forget")
                self.assertEqual(annotations["idempotentHint"], annotations["readOnlyHint"] or tool.name == "achievement_character_forget")

    def test_character_result_is_structured_and_audited(self) -> None:
        metadata = {
            "callerAddress": "203.0.113.7",
            "userAgent": "test-agent/1.0",
            "clientName": "test-agent",
            "clientVersion": "1.0",
            "protocolVersion": "2026-07-28",
        }
        with tempfile.TemporaryDirectory() as directory:
            audit_path = Path(directory) / "queries.jsonl"
            with (
                patch.object(server, "AUDIT_LOG_PATH", audit_path),
                patch.object(server, "_upstream_query", return_value=(_success_character(), 200, None)) as upstream,
            ):
                result, is_error = server._invoke_tool(
                    "get_character_equipment",
                    {"region": "US", "realm": "Dath'Remar", "character": "Bluehoof", "refresh": False},
                    metadata,
                )

            self.assertFalse(is_error)
            self.assertEqual(result["character"], {"name": "Bluehoof", "realm": "Dath'Remar", "region": "US"})
            upstream.assert_called_once_with(
                "/api/character",
                {"region": "us", "realm": "Dath'Remar", "name": "Bluehoof"},
                "203.0.113.7",
            )
            audit = json.loads(audit_path.read_text(encoding="utf-8"))
            self.assertEqual(audit["outcome"], "success")
            self.assertEqual(audit["cacheStatus"], "hit")
            self.assertEqual(audit["arguments"]["region"], "us")
            self.assertEqual(audit["callerAddress"], "203.0.113.7")
            validate(result, server.CHARACTER_OUTPUT_SCHEMA)

    def test_realm_result_is_structured_and_audited(self) -> None:
        payload = {
            "source": "Blizzard",
            "region": "US",
            "fetchedAt": "2026-08-17T00:00:00.000Z",
            "realms": [{"id": 1, "name": "Dath'Remar", "slug": "dathremar"}],
        }
        with tempfile.TemporaryDirectory() as directory:
            audit_path = Path(directory) / "queries.jsonl"
            with (
                patch.object(server, "AUDIT_LOG_PATH", audit_path),
                patch.object(server, "_upstream_query", return_value=(payload, 200, None)),
            ):
                result, is_error = server._invoke_tool("list_realms", {"region": "us"}, {})

            self.assertFalse(is_error)
            self.assertEqual(result["realms"][0]["slug"], "dathremar")
            audit = json.loads(audit_path.read_text(encoding="utf-8"))
            self.assertEqual(audit["tool"], "list_realms")
            self.assertEqual(audit["arguments"], {"region": "us"})
            validate(result, server.REALMS_OUTPUT_SCHEMA)

    def test_rate_limit_errors_are_preserved_and_audited(self) -> None:
        payload = {"error": "rate_limited", "message": "Too many requests."}
        with tempfile.TemporaryDirectory() as directory:
            audit_path = Path(directory) / "queries.jsonl"
            with (
                patch.object(server, "AUDIT_LOG_PATH", audit_path),
                patch.object(server, "_upstream_query", return_value=(payload, 429, "60")),
            ):
                result, is_error = server._invoke_tool("list_realms", {"region": "us"}, {})

            self.assertTrue(is_error)
            self.assertEqual(result["error"], "rate_limited")
            self.assertEqual(result["httpStatus"], 429)
            self.assertEqual(result["retryAfterSeconds"], 60)
            audit = json.loads(audit_path.read_text(encoding="utf-8"))
            self.assertEqual(audit["errorCode"], "rate_limited")
            self.assertEqual(audit["httpStatus"], 429)
            self.assertEqual(audit["outcome"], "error")
            validate(result, server.REALMS_OUTPUT_SCHEMA)

    def test_region_schema_accepts_uppercase_agent_input(self) -> None:
        # Driven by each schema's own shape rather than a tool-name exception,
        # so a tool that takes no region (get_season_rewards) is skipped and a
        # new region-taking tool is covered automatically.
        checked = 0
        for tool in server.TOOLS.values():
            properties = tool.input_schema["properties"]
            if "region" not in properties:
                continue
            payload = {"region": "US"}
            if "character" in properties:
                payload |= {"realm": "Dath'Remar", "character": "Bluehoof"}
            # Satisfy any other required field generically, so a new tool with
            # its own required inputs does not break this check.
            for required in tool.input_schema.get("required", []):
                if required not in payload:
                    payload[required] = "season-mn-2" if required == "season" else "placeholder"

            with self.subTest(tool=tool.name):
                validate(payload, tool.input_schema)
            checked += 1
        self.assertGreaterEqual(checked, 5)

    def test_new_character_tools_route_to_cached_internal_endpoints(self) -> None:
        fixtures = {
            "get_character_talents": (
                "/api/talents",
                {
                    "source": "Blizzard",
                    "character": {"name": "Bluehoof", "realm": "Dath'Remar", "realmSlug": "dathremar", "realmId": 3735, "region": "US"},
                    "activeSpecialization": {"id": 65, "name": "Holy"},
                    "activeHeroTalentTree": {"id": 50, "name": "Herald of the Sun"},
                    "loadout": {"importCode": "CODE", "classTalents": [], "specializationTalents": [], "heroTalents": []},
                    "fetchedAt": "2026-08-17T00:00:00.000Z",
                    "cache": {"status": "miss", "refreshAvailableAt": "2026-08-17T00:01:00.000Z"},
                },
                server.TALENTS_OUTPUT_SCHEMA,
            ),
            "get_character_profile": (
                "/api/profile",
                {
                    "source": "Blizzard",
                    "character": {"name": "Bluehoof", "realm": "Dath'Remar", "realmSlug": "dathremar", "realmId": 3735, "region": "US"},
                    "level": 90, "faction": "Alliance", "race": {"id": 11, "name": "Draenei"},
                    "characterClass": {"id": 2, "name": "Paladin"}, "activeSpecialization": {"id": 65, "name": "Holy"},
                    "guild": {"id": 7, "name": "Checklist Champions"}, "averageItemLevel": 290,
                    "equippedItemLevel": 290, "achievementPoints": 24710, "lastLoginAt": "2026-08-17T00:00:00.000Z",
                    "mythicPlus": {"seasonId": 17, "rating": 3034.8923, "bestRuns": []},
                    "mythicPlusWarning": None,
                    "fetchedAt": "2026-08-17T00:00:00.000Z",
                    "cache": {"status": "miss", "refreshAvailableAt": "2026-08-17T00:01:00.000Z"},
                },
                server.PROFILE_OUTPUT_SCHEMA,
            ),
            "get_character_achievements": (
                "/api/achievements",
                {
                    "source": "Blizzard",
                    "character": {"name": "Bluehoof", "realm": "Dath'Remar", "realmSlug": "dathremar", "realmId": 3735, "region": "US"},
                    "totalCompleted": 3201, "totalPoints": 24710, "recentAchievements": [],
                    "fetchedAt": "2026-08-17T00:00:00.000Z",
                    "cache": {"status": "miss", "refreshAvailableAt": "2026-08-17T00:01:00.000Z"},
                },
                server.ACHIEVEMENTS_OUTPUT_SCHEMA,
            ),
        }
        for tool_name, (path, payload, schema) in fixtures.items():
            with self.subTest(tool=tool_name), tempfile.TemporaryDirectory() as directory:
                audit_path = Path(directory) / "queries.jsonl"
                with (
                    patch.object(server, "AUDIT_LOG_PATH", audit_path),
                    patch.object(server, "_upstream_query", return_value=(payload, 200, None)) as upstream,
                ):
                    result, is_error = server._invoke_tool(
                        tool_name,
                        {"region": "US", "realm": "Dath'Remar", "character": "Bluehoof", "refresh": True},
                        {},
                    )
                self.assertFalse(is_error)
                upstream.assert_called_once_with(
                    path,
                    {"region": "us", "realm": "Dath'Remar", "name": "Bluehoof", "refresh": "1"},
                    None,
                )
                validate(result, schema)
                audit = json.loads(audit_path.read_text(encoding="utf-8"))
                self.assertEqual(audit["tool"], tool_name)
                self.assertEqual(audit["cacheStatus"], "miss")

    def test_request_metadata_is_safe_without_session_or_request(self) -> None:
        context = type("Context", (), {"request": None, "session": None, "protocol_version": "2026-07-28"})()
        self.assertEqual(
            server._request_metadata(context),
            {
                "callerAddress": None,
                "userAgent": None,
                "clientName": None,
                "clientVersion": None,
                "protocolVersion": "2026-07-28",
            },
        )

    def test_request_metadata_uses_preferred_username_for_browser_mcp_identity_parity(self) -> None:
        request = type("Request", (), {
            "headers": {
                "x-auth-request-sub": "opaque-oauth-subject",
                "x-auth-request-preferred-username": "kevin",
                "user-agent": "test-agent",
            },
            "client": type("Client", (), {"host": "127.0.0.1"})(),
        })()
        context = type("Context", (), {"request": request, "session": None, "protocol_version": "2026-07-28"})()
        metadata = server._request_metadata(context)
        self.assertEqual(metadata["actor"], server.hashlib.sha256(b"kevin").hexdigest()[:24])

    def test_season_rewards_tool_is_declared_read_only_with_strict_schema(self) -> None:
        tool = server.TOOLS["get_season_rewards"]
        annotations = tool.annotations.model_dump(by_alias=True, exclude_none=True)
        self.assertTrue(annotations["readOnlyHint"])
        self.assertFalse(annotations["destructiveHint"])
        self.assertTrue(annotations["idempotentHint"])
        self.assertFalse(tool.input_schema["additionalProperties"])
        self.assertEqual(set(tool.input_schema["properties"]), {"category", "itemLevel"})
        success = tool.output_schema["oneOf"][0]
        # Provenance is pinned so an agent can never read curated seasonal
        # rules as Blizzard character data.
        self.assertEqual(success["properties"]["provenance"]["const"], "curated")
        self.assertIn("provenance", success["required"])
        # verifiedAt is declared but NOT required, because it is legitimately
        # absent when the season has rolled over and no curated data exists.
        # That it is present whenever data IS returned is asserted on the Node
        # side, where the payload is actually built.
        self.assertIn("verifiedAt", success["properties"])
        self.assertIn("seasonDataUnavailable", success["properties"])
        Draft202012Validator.check_schema(tool.output_schema)

    def test_season_rewards_arguments_are_validated(self) -> None:
        self.assertEqual(
            server._validate_season_arguments({}), {"category": "all", "itemLevel": None}
        )
        self.assertEqual(
            server._validate_season_arguments({"category": "DELVES"})["category"], "delves"
        )
        for bad in (
            {"category": "loot_pinata"},
            {"itemLevel": 289.5},
            {"itemLevel": True},
            {"itemLevel": 0},
            {"category": "recommended_activities"},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    server._validate_season_arguments(bad)

    def test_season_rewards_routes_through_the_shared_internal_endpoint(self) -> None:
        captured: dict = {}

        def fake_upstream(path, query, caller_address):
            captured["path"] = path
            captured["query"] = query
            return {
                "season": "Midnight Season 2",
                "patch": "12.1",
                "verifiedAt": "2026-08-17",
                "provenance": "curated",
                "disclaimer": "Curated community data.",
                "sources": ["https://example.invalid"],
                "category": "mythic_plus",
            }, 200, None

        with patch.object(server, "_upstream_query", fake_upstream):
            result, is_error = server._invoke_tool(
                "get_season_rewards", {"category": "mythic_plus", "itemLevel": 289}, {}
            )

        self.assertFalse(is_error)
        # Must reuse the site API so cache, limiter and audit stay single-path.
        self.assertEqual(captured["path"], "/api/season-rewards")
        self.assertEqual(captured["query"], {"category": "mythic_plus", "itemLevel": 289})
        self.assertEqual(result["provenance"], "curated")
        validate(result, server.TOOLS["get_season_rewards"].output_schema)

    def test_guidance_and_audit_tools_declare_community_provenance(self) -> None:
        guidance = server.TOOLS["get_class_guidance"]
        success = guidance.output_schema["oneOf"][0]
        # Guidance must be unmistakably community data, never Blizzard's.
        self.assertEqual(success["properties"]["provenance"]["const"], "community")
        self.assertEqual(success["properties"]["source"]["const"], "classcodex")
        self.assertIn("lastScrape", success["properties"])
        self.assertIn("never Blizzard data", guidance.description)
        Draft202012Validator.check_schema(guidance.output_schema)

        audit = server.TOOLS["get_gear_audit"]
        Draft202012Validator.check_schema(audit.output_schema)
        self.assertIn("read from Blizzard, not from the caller", audit.description)
        for tool in (guidance, audit):
            annotations = tool.annotations.model_dump(by_alias=True, exclude_none=True)
            self.assertTrue(annotations["readOnlyHint"])
            self.assertFalse(annotations["destructiveHint"])

    def test_guidance_arguments_are_validated(self) -> None:
        self.assertEqual(
            server._validate_guidance_arguments({"className": " Paladin ", "spec": "Holy"}),
            {
                "className": "paladin", "spec": "holy", "specId": None,
                "activity": None, "heroTalent": None, "encounterId": None,
                "source": None,
            },
        )
        for bad in (
            {"className": "paladin"},
            {"className": "<script>", "spec": "holy"},
            {"className": "paladin", "spec": "holy", "specId": 0},
            {"className": "paladin", "spec": "holy", "specId": True},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    server._validate_guidance_arguments(bad)

    def test_unavailable_guidance_is_a_success_not_a_tool_failure(self) -> None:
        # A missing snapshot must not surface as an MCP error, or an agent
        # loses the tool mid-conversation instead of being told to try later.
        payload = {
            "provenance": "community",
            "source": "classcodex",
            "available": False,
            "reason": "No ClassCodex snapshot has been imported yet.",
        }

        def fake_upstream(path, query, caller_address):
            return payload, 200, None

        with patch.object(server, "_upstream_query", fake_upstream):
            result, is_error = server._invoke_tool(
                "get_class_guidance", {"className": "paladin", "spec": "holy"}, {}
            )
        self.assertFalse(is_error, "degraded guidance is a normal answer")
        validate(result, server.TOOLS["get_class_guidance"].output_schema)

    def test_season_unavailable_payload_is_valid_structured_output(self) -> None:
        # A rolled-over season is a normal degradation. If it fails the tool's
        # declared success schema, the MCP client sees invalid structured
        # output and the tool looks broken instead of merely uninformed.
        payload = {
            "seasonDataUnavailable": True,
            "seasonId": 19,
            "knownSeasonIds": [18],
            "provenance": "curated",
            "message": "No curated reward data for season 19.",
            "category": "all",
        }

        def fake_upstream(path, query, caller_address):
            return payload, 200, None

        with patch.object(server, "_upstream_query", fake_upstream):
            result, is_error = server._invoke_tool("get_season_rewards", {"category": "all"}, {})

        self.assertFalse(is_error)
        validate(result, server.TOOLS["get_season_rewards"].output_schema)

    def test_meta_builds_arguments_are_validated(self) -> None:
        self.assertEqual(
            server._validate_meta_arguments({"season": "SEASON-MN-2"})["season"], "season-mn-2"
        )
        self.assertEqual(server._validate_meta_arguments({"season": "season-mn-2", "region": "US"})["region"], "us")
        for bad in (
            {},
            {"season": "not a slug!"},
            {"season": "season-mn-2", "region": "mars"},
            {"season": "season-mn-2", "pages": 0},
            {"season": "season-mn-2", "pages": 99},
            {"season": "season-mn-2", "specId": True},
        ):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    server._validate_meta_arguments(bad)


if __name__ == "__main__":
    unittest.main()
