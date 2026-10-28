from array import array
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from analyze import extract_audio, probe, run, RATE


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), 'FFmpeg required')
class TimestampTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.base = Path(cls.directory.name) / 'base.mp4'
        cls.shifted = Path(cls.directory.name) / 'shifted.ts'
        run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=10:d=12',
             '-f', 'lavfi', '-i', r'aevalsrc=if(between(t\,3\,4)+between(t\,9\,10)\,0.3*sin(2*PI*440*t)\,0):s=16000:d=12',
             '-c:v', 'libx264', '-g', '10', '-c:a', 'aac', '-y', str(cls.base)])
        run(['ffmpeg', '-v', 'error', '-i', str(cls.base), '-c', 'copy',
             '-output_ts_offset', '8', '-muxdelay', '0', '-y', str(cls.shifted)])

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def onset(self, file, start):
        _, _, _, offset = probe(file, 'ffprobe')
        samples = array('f', extract_audio(file, start, 3, seek_offset=offset))
        self.assertEqual(len(samples), RATE*3)
        for i in range(0, len(samples), 160):
            if sum(abs(x) for x in samples[i:i+160])/160 > .05:
                return i/RATE
        self.fail('Expected pulse was lost')

    def test_offset_ts_matches_zero_based_video_at_early_and_late_seek(self):
        for start in (2, 8):
            with self.subTest(start=start):
                base = self.onset(self.base, start)
                shifted = self.onset(self.shifted, start)
                self.assertAlmostEqual(base, 1, delta=.04)
                self.assertAlmostEqual(shifted, base, delta=.04)
