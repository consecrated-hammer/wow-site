import json
import tempfile
import unittest
from pathlib import Path

from achievement_tracker import AchievementTracker


class AchievementTrackerTests(unittest.TestCase):
    def test_character_identity_summary_and_filter_facets_are_server_derived(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({
                'region': 'us', 'realm': 'DathRemar', 'name': 'One',
                'race': 'Tauren', 'characterClass': 'Druid',
                'avatarUrl': 'https://render.example/one-avatar.jpg',
            }, None)['id']
            tracker.set_priority(character, 10, 100, None)
            tracker.set_priority(character, 11, 0, None)
            tracker.upsert_blizzard_metadata([
                {'achievementId': 10, 'name': 'Earned', 'points': 10, 'category': 'Exploration > Midnight', 'rewardType': 'mount'},
                {'achievementId': 11, 'name': 'Open', 'points': 5, 'category': 'Exploration > Midnight'},
            ], None)
            tracker.update_state({'characterId': character, 'achievementId': 10, 'state': 'earned', 'source': 'manual_confirmation'}, None)
            listed = tracker.list_characters()['characters'][0]
            self.assertEqual((listed['race'], listed['character_class']), ('Tauren', 'Druid'))
            self.assertEqual(listed['avatar_url'], 'https://render.example/one-avatar.jpg')
            self.assertEqual(listed['completionPct'], 50)
            summary = tracker.character_summary(character)
            self.assertEqual(summary.pop('recentAchievements'), [])
            self.assertEqual(summary, {
                'achievementTotal': 2, 'achievementEarned': 1,
                'pointsEarned': 10, 'pointsTotal': 15, 'completionPct': 50,
                'factionUnavailable': 0,
            })
            facets = tracker.facets(character)
            self.assertEqual(facets['reward'], [{'value': 'mount', 'count': 1}, {'value': 'none', 'count': 1}])
            self.assertEqual({item['value'] for item in facets['priority']}, {0, 100})

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
            listed = tracker.list_achievements({'actor':'actor','characterId':one,'order':'priority','limit':10})
            self.assertEqual(listed['achievements'][0]['priority'], 70)
            plan = tracker.plan([one, two], 10, 'actor')
            self.assertEqual(plan['items'][0]['achievementId'], 42)
            self.assertIn('manual priority 70', plan['items'][0]['reasons'])
            self.assertIn('helps 2 selected characters', plan['items'][0]['reasons'])

    def test_comparison_returns_overlay_state_and_filters_to_actionable_for_both(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            one = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, 'actor')['id']
            two = tracker.add_character({'region':'us','realm':'DathRemar','name':'Two'}, 'actor')['id']
            for achievement_id, name in ((1, 'Both open'), (2, 'Primary earned'), (3, 'Comparison unknown'), (4, 'Both progressing')):
                tracker.set_priority(one, achievement_id, 0, None)
                tracker.set_priority(two, achievement_id, 0, None)
                tracker.upsert_blizzard_metadata([{'achievementId': achievement_id, 'name': name}], None)
            tracker.update_state({'characterId': one, 'achievementId': 1, 'state': 'unearned', 'source': 'manual'}, None)
            tracker.update_state({'characterId': two, 'achievementId': 1, 'state': 'unearned', 'source': 'manual'}, None)
            tracker.update_state({'characterId': one, 'achievementId': 2, 'state': 'earned', 'source': 'manual_confirmation'}, None)
            tracker.update_state({'characterId': two, 'achievementId': 2, 'state': 'unearned', 'source': 'manual'}, None)
            tracker.update_state({'characterId': one, 'achievementId': 3, 'state': 'unearned', 'source': 'manual'}, None)
            tracker.update_state({'characterId': two, 'achievementId': 3, 'state': 'unknown', 'source': 'manual'}, None)
            tracker.update_state({'characterId': one, 'achievementId': 4, 'state': 'in_progress', 'source': 'manual', 'progressCurrent': 2, 'progressTarget': 8}, None)
            tracker.update_state({'characterId': two, 'achievementId': 4, 'state': 'completion_ready', 'source': 'manual', 'progressCurrent': 8, 'progressTarget': 8}, None)

            overlaid = tracker.list_achievements({'characterId': one, 'compareCharacterId': two, 'limit': 10})
            comparison = {item['achievementId']: item for item in overlaid['achievements']}
            self.assertEqual(comparison[4]['comparisonState'], 'completion_ready')
            self.assertEqual((comparison[4]['comparisonProgressCurrent'], comparison[4]['comparisonProgressTarget']), (8, 8))

            shared = tracker.list_achievements({'characterId': one, 'compareCharacterId': two, 'neededByBoth': True, 'limit': 10})
            self.assertEqual({item['achievementId'] for item in shared['achievements']}, {1, 4})
            self.assertEqual(shared['total'], 2)
            with self.assertRaisesRegex(ValueError, 'requires compareCharacterId'):
                tracker.list_achievements({'characterId': one, 'neededByBoth': True})
            with self.assertRaisesRegex(ValueError, 'must differ'):
                tracker.list_achievements({'characterId': one, 'compareCharacterId': one})

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

    def test_blizzard_returned_without_timestamp_becomes_unearned_not_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'Dath-Remar','name':'One'}, None)['id']
            tracker.set_priority(character, 42, 10, None)
            result = tracker.record_blizzard_unearned(character, [42], 'blizzard')
            self.assertEqual(result['recordedUnearned'], 1)
            self.assertEqual(tracker.list_achievements({'characterId':character, 'state':'unearned'})['achievements'][0]['achievementId'], 42)

    def test_priority_labels_are_user_scoped_and_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            self.assertEqual(tracker.user_priority_labels('one')['labels'][0]['label'], 'Do now')
            tracker.set_user_priority_labels('one', [{'priority': 100, 'label': 'Raid reset'}, {'priority': 0, 'label': 'Whenever'}])
            self.assertEqual(tracker.user_priority_labels('one')['labels'][0]['label'], 'Raid reset')
            self.assertEqual(tracker.user_priority_labels('two')['labels'][0]['label'], 'Do now')
            with self.assertRaisesRegex(ValueError, 'unique'):
                tracker.set_user_priority_labels('one', [{'priority': 0, 'label': 'A'}, {'priority': 0, 'label': 'B'}])

    def test_character_chooser_history_is_user_scoped(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            bluehoof = tracker.add_character({'region':'us','realm':'DathRemar','name':'Bluehoof'}, 'kevin')['id']
            tracker.add_character({'region':'us','realm':'DathRemar','name':'Ferality'}, 'kevin')
            reilly = tracker.add_character({'region':'us','realm':'DathRemar','name':'Reilly'}, 'bianca')['id']
            self.assertEqual({item['name'] for item in tracker.list_characters('kevin')['characters']}, {'Bluehoof', 'Ferality'})
            self.assertEqual([item['name'] for item in tracker.list_characters('bianca')['characters']], ['Reilly'])
            tracker.select_character(bluehoof, 'bianca')
            self.assertEqual({item['id'] for item in tracker.list_characters('bianca')['characters']}, {bluehoof, reilly})
            forgotten = tracker.forget_character(bluehoof, 'bianca')
            self.assertTrue(forgotten['removed'])
            self.assertEqual([item['id'] for item in tracker.list_characters('bianca')['characters']], [reilly])
            self.assertEqual({item['name'] for item in tracker.list_characters('kevin')['characters']}, {'Bluehoof', 'Ferality'})
            tracker.select_character(bluehoof, 'bianca')
            self.assertEqual({item['id'] for item in tracker.list_characters('bianca')['characters']}, {bluehoof, reilly})
            self.assertEqual(len(tracker.list_characters()['characters']), 3)

    def test_character_ownership_is_recovered_from_existing_audit_events(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tracker.sqlite3'
            tracker = AchievementTracker(path); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'Reilly'}, None)['id']
            with tracker._connect() as db:
                tracker._event(db, 'owner', 'character_upsert', character, None, {})
            tracker.initialise()
            self.assertEqual([item['id'] for item in tracker.list_characters('owner')['characters']], [character])

    def test_imported_character_labels_are_used_until_a_user_saves_a_legend(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'Reilly'}, None)['id']
            with tracker._connect() as db:
                db.execute('INSERT INTO character_priority_labels(character_id,priority,label) VALUES(?,?,?)', (character, 75, 'Near-finish rewards'))
            self.assertEqual(tracker.priority_labels_for_user_or_character('user', character)['labels'][0]['label'], 'Near-finish rewards')
            tracker.set_user_priority_labels('user', [{'priority': 50, 'label': 'This week'}])
            self.assertEqual(tracker.priority_labels_for_user_or_character('user', character)['labels'][0]['label'], 'This week')

    def test_legacy_custom_priorities_and_labels_survive_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tracker.sqlite3'
            tracker = AchievementTracker(path); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'Reilly'}, None)['id']
            tracker.set_priority(character, 1, 90, None)
            tracker.set_priority(character, 2, 70, None)
            tracker.set_priority(character, 3, 20, None)
            with tracker._connect() as db:
                db.execute('INSERT INTO character_priority_labels(character_id,priority,label) VALUES(?,?,?)', (character, 90, 'Custom'))
                db.execute('PRAGMA user_version=1')
            tracker.initialise()
            priorities = [item['priority'] for item in tracker.list_achievements({'characterId': character, 'order': 'priority'})['achievements']]
            self.assertEqual(priorities, [90, 70, 20])
            self.assertEqual(tracker.priority_labels(character)['labels'], [{'priority': 90, 'label': 'Custom'}])

    def test_checked_by_you_keeps_blizzard_confirmation(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id']
            tracker.update_state({'characterId': character, 'achievementId': 1, 'state': 'earned', 'source': 'manual_confirmation'}, None)
            self.assertEqual(tracker.character_summary(character)['recentAchievements'], [])
            tracker.record_blizzard_recent(character, [{'id': 1, 'name': 'Manually checked', 'completedAt': '2026-08-19T00:00:00+00:00'}, {'id': 2, 'name': 'Blizzard earned'}], None)
            listed = tracker.list_achievements({'characterId': character, 'filters': {'completionSource': 'manual_confirmation'}})
            self.assertEqual([item['achievementId'] for item in listed['achievements']], [1])
            self.assertEqual(listed['achievements'][0]['earnedAt'], '2026-08-19T00:00:00+00:00')
            self.assertIsNotNone(listed['achievements'][0]['blizzardConfirmedAt'])
            recent = tracker.character_summary(character)['recentAchievements']
            self.assertEqual([(item['achievementId'], item['name']) for item in recent], [(1, 'Manually checked')])

    def test_in_progress_is_derived_only_from_partial_meta_criteria(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id']
            for achievement_id in (100, 200):
                tracker.set_priority(character, achievement_id, 0, None)
            tracker.upsert_blizzard_metadata([
                {'achievementId': 100, 'name': 'Meta', 'criteria': {'child_criteria': [
                    {'id': 1, 'achievement': {'id': 101, 'name': 'One'}},
                    {'id': 2, 'achievement': {'id': 102, 'name': 'Two'}},
                ]}},
                {'achievementId': 200, 'name': 'Ordinary counter', 'criteria': {'child_criteria': [
                    {'id': 3, 'description': 'Collect things'},
                ]}},
            ], None)
            tracker.record_blizzard_progress(character, [
                {'id': 100, 'criteria': {'child_criteria': [
                    {'id': 1, 'is_completed': True}, {'id': 2, 'is_completed': False},
                ]}},
                {'id': 200, 'criteria': {'child_criteria': [{'id': 3, 'is_completed': True}]}},
            ], None)
            states = {item['achievementId']: item['state'] for item in tracker.list_achievements({'characterId': character})['achievements']}
            self.assertEqual(states[100], 'in_progress')
            self.assertNotEqual(states[200], 'in_progress')
            tracker.record_blizzard_progress(character, [{'id': 100, 'criteria': {'child_criteria': [
                {'id': 1, 'is_completed': True}, {'id': 2, 'is_completed': True},
            ]}}], None)
            self.assertEqual(tracker.list_achievements({'characterId': character, 'state': 'completion_ready'})['achievements'][0]['achievementId'], 100)

    def test_pvp_exclusion_uses_the_exact_blizzard_category_segment(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id']
            records = [
                {'achievementId': 1, 'name': 'Arena', 'category': 'Player vs. Player > Arena'},
                {'achievementId': 2, 'name': 'Legacy PvP', 'category': 'Legacy > Player vs. Player'},
                {'achievementId': 3, 'name': 'Explorer', 'category': 'Exploration'},
            ]
            for record in records:
                tracker.set_priority(character, record['achievementId'], 0, None)
            tracker.upsert_blizzard_metadata(records, None)
            listed = tracker.list_achievements({'characterId': character, 'filters': {'excludePvp': True}})
            self.assertEqual([item['achievementId'] for item in listed['achievements']], [3])

    def test_opposite_faction_achievements_are_unavailable_and_excluded_by_default(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            alliance = tracker.add_character({'region':'us','realm':'DathRemar','name':'Alliance One','faction':'Alliance'}, 'owner')['id']
            horde = tracker.add_character({'region':'us','realm':'DathRemar','name':'Horde One','faction':'Horde'}, 'owner')['id']
            records = [
                {'achievementId': 13924, 'name': 'The Fourth War', 'points': 10, 'requiredFaction': 'HORDE'},
                {'achievementId': 13925, 'name': 'The Fourth War', 'points': 10, 'requiredFaction': 'ALLIANCE'},
                {'achievementId': 1, 'name': 'Neutral', 'points': 5},
            ]
            for record in records:
                tracker.set_priority(alliance, record['achievementId'], 0, None)
                tracker.set_priority(horde, record['achievementId'], 0, None)
            tracker.upsert_blizzard_metadata(records, None)
            tracker.update_state({'characterId': alliance, 'achievementId': 1, 'state': 'unearned', 'source': 'manual'}, None)
            tracker.update_state({'characterId': horde, 'achievementId': 1, 'state': 'unearned', 'source': 'manual'}, None)

            listed = tracker.list_achievements({'characterId': alliance})
            self.assertEqual({item['achievementId'] for item in listed['achievements']}, {1, 13925})
            self.assertEqual(listed['factionUnavailable'], 1)
            all_rows = tracker.list_achievements({'characterId': alliance, 'includeUnavailable': True})
            unavailable = next(item for item in all_rows['achievements'] if item['achievementId'] == 13924)
            self.assertEqual((unavailable['requiredFaction'], unavailable['availableForCharacter']), ('HORDE', 0))
            self.assertEqual(tracker.character_summary(alliance)['achievementTotal'], 2)
            self.assertEqual(tracker.character_summary(alliance)['factionUnavailable'], 1)
            shared = tracker.list_achievements({'characterId': alliance, 'compareCharacterId': horde, 'neededByBoth': True})
            self.assertEqual([item['achievementId'] for item in shared['achievements']], [1])

    def test_blizzard_static_description_is_returned_to_the_table(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id']
            tracker.set_priority(character, 3, 0, None)
            tracker.upsert_blizzard_metadata([{
                'achievementId': 3, 'name': 'Static achievement', 'points': 10,
                'category': 'Exploration', 'description': 'Discover every hidden cave.',
            }], None)
            row = tracker.list_achievements({'characterId': character})['achievements'][0]
            self.assertEqual(row['description'], 'Discover every hidden cave.')

    def test_new_character_uses_global_catalogue_and_blizzard_progress_overlays_it(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'tracker.sqlite3'
            tracker = AchievementTracker(path); tracker.initialise()
            seed = tracker.add_character({'region':'us','realm':'DathRemar','name':'Seed'}, None)['id']
            tracker.set_priority(seed, 10, 0, None)
            tracker.set_priority(seed, 11, 0, None)
            tracker.upsert_blizzard_metadata([
                {'achievementId': 10, 'name': 'Earned globally'},
                {'achievementId': 11, 'name': 'Still to do'},
            ], None)
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'New'}, None)['id']
            tracker.record_blizzard_progress(character, [{'id': 10, 'completedAt': '2026-08-19T00:00:00+00:00'}], None)
            rows = tracker.list_achievements({'characterId': character, 'limit': 10})['achievements']
            self.assertEqual({row['achievementId'] for row in rows}, {10, 11})
            self.assertEqual(next(row for row in rows if row['achievementId'] == 10)['state'], 'earned')
            self.assertEqual(next(row for row in rows if row['achievementId'] == 11)['state'], 'unearned')

    def test_not_found_static_metadata_is_not_queued_again(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            tracker.set_priority(tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id'], 99, 0, None)
            self.assertEqual(tracker.achievement_ids_without_blizzard_metadata(10), [99])
            self.assertEqual(tracker.record_unavailable_blizzard_metadata([{'achievementId': 99, 'error': 'upstream_not_found'}], None), 1)
            self.assertEqual(tracker.achievement_ids_without_blizzard_metadata(10), [])

    def test_release_metadata_options_and_filters_are_global(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id']
            tracker.set_priority(character, 42, 0, None)
            tracker.upsert_wowhead_release_metadata([{
                'achievementId': 42,
                'addedExpansion': 'Dragonflight',
                'addedPatch': '10.2.0',
            }])
            self.assertEqual(tracker.release_options(character), {'expansions': ['Dragonflight'], 'patches': ['10.2.0']})
            listed = tracker.list_achievements({'characterId': character, 'filters': {'addedExpansion': 'Dragonflight', 'addedPatch': '10.2.0'}})
            self.assertEqual([item['achievementId'] for item in listed['achievements']], [42])

    def test_imported_checklist_tip_is_character_scoped_and_listed(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            reilly = tracker.add_character({'region':'us','realm':'DathRemar','name':'Reilly'}, None)['id']
            other = tracker.add_character({'region':'us','realm':'DathRemar','name':'Other'}, None)['id']
            tracker.set_priority(reilly, 42, 0, None)
            tracker.set_priority(other, 42, 0, None)
            with tracker._connect() as db:
                db.execute(
                    'UPDATE user_achievement_overlays SET imported_tip=?,imported_tip_source=?,imported_tip_imported_at=? '
                    'WHERE user_id=? AND character_id=? AND achievement_id=?',
                    ('Use one helper.', 'Checklist', '2026-08-20T00:00:00+00:00', '', reilly, 42),
                )
            reilly_row = tracker.list_achievements({'characterId': reilly})['achievements'][0]
            other_row = tracker.list_achievements({'characterId': other})['achievements'][0]
            self.assertEqual(reilly_row['importedTip'], 'Use one helper.')
            self.assertEqual(reilly_row['importedTipSource'], 'Checklist')
            self.assertIsNone(other_row['importedTip'])

    def test_planning_overlay_is_scoped_by_user_while_blizzard_progress_is_shared(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'Reilly'}, 'bianca')['id']
            tracker.select_character(character, 'kevin')
            tracker.set_priority(character, 41, 100, 'bianca')
            tracker.update_state({'characterId': character, 'achievementId': 41, 'state': 'earned', 'source': 'manual_confirmation', 'note': 'Bianca note'}, 'bianca')
            tracker.set_priority(character, 42, 50, 'kevin')
            tracker.record_blizzard_recent(character, [{'id': 42, 'name': 'Blizzard earned', 'completedAt': '2026-08-20T00:00:00+00:00'}], None)

            bianca = {row['achievementId']: row for row in tracker.list_achievements({'actor':'bianca','characterId':character})['achievements']}
            kevin = {row['achievementId']: row for row in tracker.list_achievements({'actor':'kevin','characterId':character})['achievements']}
            self.assertEqual((bianca[41]['priority'], bianca[41]['state'], bianca[41]['note']), (100, 'earned', 'Bianca note'))
            self.assertEqual((kevin[41]['priority'], kevin[41]['state'], kevin[41]['note']), (0, 'unknown', None))
            self.assertEqual((bianca[42]['state'], kevin[42]['state']), ('earned', 'earned'))
            self.assertEqual((bianca[42]['priority'], kevin[42]['priority']), (0, 50))

    def test_hammerlink_import_is_scoped_by_user_and_character(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':"Dath'Remar",'realmSlug':'dathremar','name':'Reilly'}, 'bianca')['id']
            tracker.select_character(character, 'kevin')

            base = {
                'format': 1, 'capturedAt': 1787200000,
                'character': {'name':'Reilly','realm':"Dath'Remar",'region':1,'class':'PALADIN','level':80,'equippedItemLevel':700,'overallItemLevel':705},
                'equipment': [{'slot':'HEAD','itemID':1001,'link':'|Hitem:1001|h[Helm]|h'}],
                'bagEquipment': [], 'talents': {'importString':'TALENTS'},
                'vault': {'capturedAt':1787200000,'activities':[]},
            }
            bianca = json.loads(json.dumps(base)); bianca['bagEquipment'] = [{'bag':0,'slot':1,'itemID':2001,'link':'|Hitem:2001|h[Bianca item]|h'}]
            kevin = json.loads(json.dumps(base)); kevin['bagEquipment'] = [{'bag':0,'slot':2,'itemID':2002,'link':'|Hitem:2002|h[Kevin item]|h'}]
            tracker.save_hammerlink_import('bianca', character, bianca)
            tracker.save_hammerlink_import('kevin', character, kevin)

            self.assertEqual(tracker.hammerlink_import('bianca', character)['snapshot']['bagEquipment'][0]['itemID'], 2001)
            self.assertEqual(tracker.hammerlink_import('kevin', character)['snapshot']['bagEquipment'][0]['itemID'], 2002)
            self.assertEqual(tracker.list_hammerlink_imports('bianca')['imports'][0]['bagItemCount'], 1)
            self.assertNotIn('snapshot', tracker.list_hammerlink_imports('bianca')['imports'][0])
            with tracker._connect() as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM hammerlink_imports WHERE character_id=?', (character,)).fetchone()[0], 2)
            with self.assertRaisesRegex(ValueError, 'authentication'):
                tracker.list_hammerlink_imports('')

    def test_hammerlink_option_aware_snapshot_preserves_currency_and_decor_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'Bianca'}, 'bianca')['id']
            snapshot = {
                'format': 2, 'capturedAt': 1787200000,
                'character': {'name':'Bianca','realm':'DathRemar','region':1,'class':'PALADIN','level':80},
                'exportOptions': {'equipment':False,'bagItems':False,'talents':False,'vault':False,'currencyCaps':True,'decorInventory':True,'questLog':True,'professionRecipes':True},
                'currencyCaps': [
                    {'currencyID':9000,'name':'Other Token','quantity':1},
                    {'currencyID':3445,'name':'Hero Mistcrest','quantity':45},
                    {'currencyID':3509,'name':'Tidal Spark Dust','quantity':3},
                    {'currencyID':3442,'name':'Adventurer Mistcrest','quantity':149},
                    {'currencyID':3418,'name':'Nebulous Voidcore','quantity':0},
                    {'currencyID':3444,'name':'Champion Mistcrest','quantity':80},
                    {'currencyID':3443,'name':'Veteran Mistcrest','quantity':110},
                    {'currencyID':3446,'name':'Myth Mistcrest','quantity':10},
                ],
                'decorInventory': {'available':True,'items':[{'decorID':77,'name':'Warm Chair','storedCount':2,'placedCount':1}]},
                'questLog': {'available':True,'totalQuests':1,'entries':[{'questID':123,'title':'A Current Quest','objectives':[]}]},
                'professionRecipes': {'available':True,'professions':[{'skillLineID':755,'name':'Classic Jewelcrafting','recipes':[{'recipeID':1261659,'name':'Ironforge Chandelier','learned':True}]}]},
            }
            tracker.save_hammerlink_import('bianca', character, snapshot)
            summary = tracker.list_hammerlink_imports('bianca')['imports'][0]
            detail = tracker.hammerlink_import('bianca', character)
            self.assertEqual((summary['equipmentCount'], summary['bagItemCount'], summary['currencyCapCount'], summary['decorItemCount'], summary['questLogCount']), (0, 0, 8, 1, 1))
            self.assertEqual((summary['professionRecipeCount'], summary['professionSkillLineCount']), (1, 1))
            self.assertFalse(detail['snapshot']['exportOptions']['vault'])
            self.assertEqual(detail['snapshot']['decorInventory']['items'][0]['storedCount'], 2)
            self.assertEqual(
                [item['name'] for item in detail['snapshot']['currencyCaps']],
                ['Adventurer Mistcrest', 'Veteran Mistcrest', 'Champion Mistcrest', 'Hero Mistcrest', 'Myth Mistcrest', 'Nebulous Voidcore', 'Tidal Spark Dust', 'Other Token'],
            )
            with tracker._connect() as db:
                stored = json.loads(db.execute('SELECT snapshot_json FROM hammerlink_imports').fetchone()[0])
            self.assertEqual(stored['currencyCaps'][0]['name'], 'Other Token')

    def test_hammerlink_vault_read_model_labels_and_clamps_cumulative_progress(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'Bianca'}, 'bianca')['id']
            snapshot = {
                'format': 2, 'capturedAt': 1787200000,
                'character': {'name':'Bianca','realm':'DathRemar','region':1,'class':'PALADIN','level':80},
                'equipment': [], 'bagEquipment': [], 'talents': {'importString':None},
                'vault': {'capturedAt':1787200000,'activities':[
                    {'type':6,'index':1,'threshold':2,'progress':4,'activityTierID':249,'level':11},
                    {'type':99,'index':1,'threshold':3,'progress':1},
                ]},
            }
            tracker.save_hammerlink_import('bianca', character, snapshot)
            activities = tracker.hammerlink_import('bianca', character)['snapshot']['vault']['activities']
            self.assertEqual(activities[0]['activityTypeName'], 'World activities')
            self.assertEqual((activities[0]['progress'], activities[0]['displayProgress'], activities[0]['isComplete']), (4, 2, True))
            self.assertEqual(activities[1]['activityTypeName'], 'Activity type 99')
            with tracker._connect() as db:
                stored = json.loads(db.execute('SELECT snapshot_json FROM hammerlink_imports').fetchone()[0])
            self.assertNotIn('displayProgress', stored['vault']['activities'][0])

    def test_hammerlink_history_keeps_ten_versions_per_user_and_character(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'Test Realm','name':'Test'}, 'owner')['id']
            import_ids = []
            for index in range(12):
                captured_at = 1787200000 + index
                snapshot = {
                    'format': 2, 'capturedAt': captured_at,
                    'character': {'name':'Test','realm':'Test Realm','region':1,'class':'PALADIN','level':80},
                    'exportOptions': {'equipment':False,'bagItems':False,'talents':False,'vault':False,'currencyCaps':False,'decorInventory':True},
                    'decorInventory': {'available':True,'items':[{'decorID':index + 1,'name':f'Decor {index + 1}','storedCount':1}]},
                }
                import_ids.append(tracker.save_hammerlink_import('owner', character, snapshot)['importId'])

            history = tracker.list_hammerlink_import_history('owner')['imports']
            latest = tracker.list_hammerlink_imports('owner')['imports']
            self.assertEqual(len(history), 10)
            self.assertEqual(len(latest), 1)
            self.assertEqual(history[0]['importId'], import_ids[-1])
            self.assertEqual(latest[0]['importId'], import_ids[-1])
            self.assertEqual(tracker.hammerlink_import_version('owner', import_ids[-1])['snapshot']['capturedAt'], 1787200011)
            with self.assertRaisesRegex(ValueError, 'not found'):
                tracker.hammerlink_import_version('owner', import_ids[0])
            with self.assertRaisesRegex(ValueError, 'not found'):
                tracker.hammerlink_import_version('another-user', import_ids[-1])

    def test_meta_achievement_requirements_are_global_but_state_is_per_character(self):
        with tempfile.TemporaryDirectory() as directory:
            tracker = AchievementTracker(Path(directory) / 'tracker.sqlite3'); tracker.initialise()
            character = tracker.add_character({'region':'us','realm':'DathRemar','name':'One'}, None)['id']
            tracker.set_priority(character, 100, 0, None)
            tracker.update_state({'characterId': character, 'achievementId': 101, 'state': 'earned', 'source': 'manual_confirmation'}, None)
            tracker.upsert_blizzard_metadata([{
                'achievementId': 100, 'name': 'Meta', 'isAccountWide': True,
                'rewardDescription': 'Mount: Test Steed', 'rewardItemId': 123, 'rewardItemName': 'Test Reins',
                'rewardType': 'mount', 'rewardUrl': 'https://www.wowhead.com/item=123',
                'rewardItemIconUrl': 'https://example.test/reward.jpg', 'iconUrl': 'https://example.test/icon.jpg',
                'criteria': {'child_criteria': [
                    {'achievement': {'id': 101, 'name': 'First'}},
                    {'achievement': {'id': 102, 'name': 'Second'}},
                ]},
            }], None)
            tree = tracker.achievement_requirements(character, 100)
            self.assertEqual([(item['achievementId'], item['completed']) for item in tree['children']], [(101, True), (102, False)])
            self.assertTrue(tree['isAccountWide'])
            self.assertEqual(tree['rewardItemName'], 'Test Reins')
            self.assertEqual(tree['rewardItemIconUrl'], 'https://example.test/reward.jpg')
            self.assertEqual(tree['rewardType'], 'mount')
            filtered = tracker.list_achievements({'characterId': character, 'filters': {'rewardType': 'mount'}})
            self.assertEqual([item['achievementId'] for item in filtered['achievements']], [100])
            listed = tracker.list_achievements({'characterId': character})['achievements']
            self.assertTrue(next(item for item in listed if item['achievementId'] == 100)['hasDependencies'])
