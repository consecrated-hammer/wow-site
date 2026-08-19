import tempfile
import unittest
from pathlib import Path

from achievement_tracker import AchievementTracker


class AchievementTrackerTests(unittest.TestCase):
    def test_priority_deadlines_and_shared_plan_are_persistent_and_explainable(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3')
            tracker.initialise()
            one = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, 'actor')['id']
            two = tracker.add_character({'region':'us','realm':'DathRemar','name':'Two'}, 'actor')['id']
            tracker.update_state({'characterId':one,'achievementId':42,'state':'in_progress','source':'manual'}, 'actor')
            tracker.update_state({'characterId':two,'achievementId':42,'state':'unknown','source':'manual'}, 'actor')
            tracker.set_priority(one, 42, 70, 'actor')
            tracker.curate({'achievementId':42,'sourceName':'Official source','sourceUrl':'https://example.test/42','verifiedAt':'2026-08-19T00:00:00+00:00','deadline':'2026-09-01T00:00:00+00:00'}, 'actor')
            listed = tracker.list_achievements({'characterId':one,'order':'priority','limit':10})
            self.assertEqual(listed['achievements'][0]['priority'], 70)
            plan = tracker.plan([one, two], 10)
            self.assertEqual(plan['items'][0]['achievementId'], 42)
            self.assertIn('manual priority 70', plan['items'][0]['reasons'])
            self.assertIn('helps 2 selected characters', plan['items'][0]['reasons'])

    def test_earned_requires_an_authoritative_source(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id']
            with self.assertRaisesRegex(ValueError, 'earned requires'):
                tracker.update_state({'characterId':character,'achievementId':1,'state':'earned'}, None)

    def test_realm_display_variants_share_one_character_and_refresh_uses_slug(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            original = tracker.add_character({'region':'us','realm':'Dath-Remar','realmSlug':'dathremar','name':'Reilly'}, None)
            duplicate = tracker.add_character({'region':'us','realm':"Dath'Remar",'realmSlug':'dathremar','name':'reilly'}, None)
            self.assertEqual(original['id'], duplicate['id'])
            self.assertEqual(tracker.character_identity(original['id'])['realm'], 'dathremar')
