import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / 'scripts' / 'import-achievement-spreadsheet.py'
SPEC = importlib.util.spec_from_file_location('achievement_spreadsheet_importer', SCRIPT)
IMPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMPORTER)


class AchievementSpreadsheetImporterTests(unittest.TestCase):
    def test_useful_tip_rejects_repeated_and_snapshot_guidance(self):
        self.assertTrue(IMPORTER.is_useful_tip('Bring one helper and wait for five adds.', 1))
        self.assertFalse(IMPORTER.is_useful_tip('Generic advice.', 12))
        self.assertFalse(IMPORTER.is_useful_tip('Only 2 listed components remain in your export.', 1))
        self.assertFalse(IMPORTER.is_useful_tip('Earned since the original export.', 1))

    def test_resolution_requires_exact_unique_identity_or_character_faction(self):
        self.assertEqual(IMPORTER.resolve_achievement([(10, None)], 'Alliance'), 10)
        self.assertEqual(IMPORTER.resolve_achievement([(20, 'HORDE'), (21, 'ALLIANCE')], 'Alliance'), 21)
        self.assertIsNone(IMPORTER.resolve_achievement([(30, None), (31, None)], 'Alliance'))
        self.assertIsNone(IMPORTER.resolve_achievement([(20, 'HORDE'), (21, 'ALLIANCE')], None))


if __name__ == '__main__':
    unittest.main()
