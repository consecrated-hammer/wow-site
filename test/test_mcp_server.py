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
        for tool in server.TOOLS.values():
            validate({"region": "US", **(
                {"realm": "Dath'Remar", "character": "Bluehoof"}
                if tool.name != "list_realms"
                else {}
            )}, tool.input_schema)

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


if __name__ == "__main__":
    unittest.main()
