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

    def test_tools_have_agent_friendly_read_only_contracts(self) -> None:
        for tool in server.TOOLS.values():
            with self.subTest(tool=tool.name):
                self.assertTrue(tool.title)
                self.assertGreater(len(tool.description or ""), 80)
                self.assertIsNotNone(tool.output_schema)
                Draft202012Validator.check_schema(tool.input_schema)
                Draft202012Validator.check_schema(tool.output_schema)
                annotations = tool.annotations.model_dump(by_alias=True, exclude_none=True)
                self.assertTrue(annotations["readOnlyHint"])
                self.assertFalse(annotations["destructiveHint"])
                self.assertTrue(annotations["idempotentHint"])
                self.assertTrue(annotations["openWorldHint"])

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
        self.assertIn("NOT as Blizzard data", guidance.description)
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
            {"className": "paladin", "spec": "holy", "specId": None},
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
