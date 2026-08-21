import json
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from backend.app import main


class _Response:
    def __init__(self, payload: bytes):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, limit: int) -> bytes:
        return self.payload[:limit]


class BrowserBoundaryTests(unittest.TestCase):
    def test_browser_accepts_exports_up_to_the_node_parser_limit(self) -> None:
        accepted = "HL1:" + "a" * (main.HAMMERLINK_MAX_EXPORT_CHARS - 4)
        self.assertEqual(main.HammerLinkImportRequest(export=accepted).export, accepted)
        with self.assertRaises(ValidationError):
            main.HammerLinkImportRequest(export=accepted + "a")

    def test_adapter_accepts_a_valid_expanded_snapshot_above_400_kib(self) -> None:
        payload = json.dumps({"snapshot": {"decorInventory": {"items": ["x" * 500_000]}}}).encode()
        with patch.object(main, "urlopen", return_value=_Response(payload)):
            result = main.upstream_post_json("/api/hammerlink-import", {"export": "HL1:test"})
        self.assertEqual(len(result["snapshot"]["decorInventory"]["items"][0]), 500_000)

    def test_browser_username_wins_over_an_opaque_subject(self) -> None:
        self.assertEqual(main.request_actor("opaque-subject", "kevin"), main.actor("kevin"))


if __name__ == "__main__":
    unittest.main()
