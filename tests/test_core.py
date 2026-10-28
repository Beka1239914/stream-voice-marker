import math
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from core import make_plan


class PlanTests(unittest.TestCase):
    def test_minimum_speech_excludes_pauses_and_overlapping_windows(self):
        rows = [{'start': 0, 'end': 25, 'score': .8},
                {'start': 10, 'end': 25, 'score': .8},
                {'start': 50, 'end': 65, 'score': .8}]
        # A 65-second moment contains exactly 40 seconds of detected speech.
        self.assertEqual(make_plan(rows, 100, 30, min_speech=40)['speech_count'], 0)
        rows[-1]['end'] = 66
        p = make_plan(rows, 100, 30, min_speech=40, padding=0)
        self.assertEqual(p['parts'][0], {'start_frame': 0, 'end_frame': 1980, 'speech': True})
        self.assertEqual(make_plan(rows, 100, 30, min_speech=40, gap=20)['speech_count'], 0)

    def test_empty_keeps_all_video(self):
        plan = make_plan([], 14400, 60)
        self.assertEqual(plan['parts'], [{'start_frame': 0, 'end_frame': 864000, 'speech': False}])

    def test_padding_and_merge(self):
        rows = [{'start': 1, 'end': 2, 'score': .8}, {'start': 2.5, 'end': 3, 'score': .8}]
        p = make_plan(rows, 10, 30, padding=.2, gap=.7)
        self.assertEqual(p['parts'][1], {'start_frame': 24, 'end_frame': 96, 'speech': True})

    def test_low_scores_never_green(self):
        p = make_plan([{'start': 1, 'end': 5, 'score': .3}], 10, 30, threshold=.6)
        self.assertEqual(p['speech_count'], 0)

    def test_pause_within_moment_is_kept_as_one_clip(self):
        rows = [{'start': 1, 'end': 5, 'score': .8},
                {'start': 15, 'end': 20, 'score': .8},
                {'start': 50, 'end': 55, 'score': .8},
                {'start': 86, 'end': 90, 'score': .8}]
        p = make_plan(rows, 120, 30, padding=0)
        moments = [part for part in p['parts'] if part['speech']]
        self.assertEqual(moments, [
            {'start_frame': 30, 'end_frame': 1650, 'speech': True},
            {'start_frame': 2580, 'end_frame': 2700, 'speech': True}])
        self.assertEqual(p['parts'][2], {'start_frame': 1650, 'end_frame': 2580, 'speech': False})

    def test_fractional_fps_and_edges(self):
        p = make_plan([{'start': 0, 'end': 10, 'score': .9}], 10, 30000/1001)
        self.assertEqual(len(p['parts']), 1)
        self.assertEqual(p['parts'][0]['end_frame'], 300)

    def test_invalid_numbers(self):
        for value in [math.nan, math.inf, -1]:
            with self.assertRaises(ValueError):
                make_plan([], value, 30)

    def test_random_full_coverage_without_overlaps(self):
        rng = random.Random(73)
        for _ in range(100):
            rows = [{'start': a, 'end': min(100, a+rng.random()*4), 'score': rng.random()}
                    for a in sorted(rng.random()*100 for _ in range(100))]
            p = make_plan(rows, 100, 60000/1001)
            cursor = 0
            for part in p['parts']:
                self.assertEqual(part['start_frame'], cursor)
                self.assertGreater(part['end_frame'], cursor)
                cursor = part['end_frame']
            self.assertEqual(cursor, p['total_frames'])


if __name__ == '__main__':
    unittest.main()
