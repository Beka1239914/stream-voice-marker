import sys
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from jumpcut import detect, keep_frames


class JumpCutTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
    def test_sparse_clicks_do_not_split_a_quiet_pause(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'clicks.wav'
            # Very short peaks above -45 dB, but a quiet 20-ms average.
            expr = "if(lt(mod(t,0.5),0.0001),0.02,0)"
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            f"aevalsrc='{expr}|{expr}':s=48000:d=3", '-y', str(path)],
                           check=True, capture_output=True)
            pauses = detect(path, 0, 3, -45, .3, 'ffmpeg')
            self.assertEqual(len(pauses), 1)
            self.assertAlmostEqual(pauses[0][0], 0, places=2)
            self.assertAlmostEqual(pauses[0][1], 3, places=2)

    def test_padding_and_frame_rounding(self):
        parts = keep_frames(600, 900, [(1, 2)], 60, .1)
        self.assertEqual([(p['start_frame'], p['end_frame']) for p in parts], [(600, 666), (714, 900)])

    def test_no_silence_retains_selection(self):
        self.assertEqual(keep_frames(100, 250, [], 30, .1),
                         [dict(start_frame=100, end_frame=250, speech=True)])

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
    def test_actual_stereo_audio_and_short_pause(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'stereo.wav'
            # Opposite-phase channels: downmix would incorrectly erase every tone.
            expr = 'if(between(t,1,2)+between(t,3,3.2),0,0.2*sin(2*PI*440*t))'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            f"aevalsrc='{expr}|-({expr})':s=48000:d=4", '-y', str(path)],
                           check=True, capture_output=True)
            pauses = detect(path, 0, 4, -45, .6, 'ffmpeg')
            self.assertEqual(len(pauses), 1)
            self.assertAlmostEqual(pauses[0][0], 1, places=2)
            self.assertAlmostEqual(pauses[0][1], 2, places=2)
            # A seek into the same source must produce relative timestamps.
            pauses = detect(path, .5, 2, -45, .6, 'ffmpeg')
            self.assertEqual(len(pauses), 1)
            self.assertAlmostEqual(pauses[0][0], .5, places=2)
            self.assertAlmostEqual(pauses[0][1], 1.5, places=2)

    @unittest.skipUnless(shutil.which('ffmpeg'), 'FFmpeg required')
    def test_trailing_silence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'quiet.wav'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            'anullsrc=r=48000:cl=stereo', '-t', '2', '-y', str(path)],
                           check=True, capture_output=True)
            pauses = detect(path, 0, 2, -45, .6, 'ffmpeg')
            self.assertEqual(len(pauses), 1)
            self.assertAlmostEqual(pauses[0][0], 0, places=2)
            self.assertAlmostEqual(pauses[0][1], 2, places=2)


if __name__ == '__main__':
    unittest.main()
