import copy
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from voices import MODEL, fingerprint, load_profile, validate_profile


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.voice = {'schema': 1, 'model': MODEL, 'sample_rate': 16000,
                      'name': 'Мой стример', 'embedding': [1.] + [0.]*191}

    def test_profile_portable_without_original_video(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'голос.json'
            path.write_text(json.dumps(self.voice), encoding='utf-8')
            self.assertEqual(load_profile(path), self.voice)

    def test_voice_changes_invalidate_cache_but_rename_does_not(self):
        renamed = copy.deepcopy(self.voice)
        renamed['name'] = 'Другое название'
        self.assertEqual(fingerprint(renamed), fingerprint(self.voice))
        renamed['embedding'] = [0., 1.] + [0.]*190
        self.assertNotEqual(fingerprint(renamed), fingerprint(self.voice))

    def test_corrupt_or_wrong_model_rejected(self):
        for changes in [{'embedding': [0.]*192}, {'embedding': [1.]},
                        {'embedding': [math.nan] + [0.]*191}, {'model': 'other'},
                        {'sample_rate': 48000}, {'name': ''}]:
            with self.subTest(changes=list(changes)):
                with self.assertRaises(ValueError):
                    validate_profile(dict(self.voice, **changes))


if __name__ == '__main__':
    unittest.main()
