import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

try:
    import numpy as np
    import soundfile as sf
except ImportError:
    np = sf = None

from worker.cosyvoice_backend import CosyVoiceBackend, MODEL_FILES, SOURCE_FILES
from worker.synthesis import RequestContext


@unittest.skipUnless(np is not None and sf is not None, "requires numpy and soundfile")
class CosyVoiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.reference = self.root / "reference.wav"
        self.adapter = CosyVoiceBackend(str(self.root / "source"), str(self.root / "model"))
        self.adapter.identity = "model"
        self.seen = []
        self.model = SimpleNamespace(frontend=SimpleNamespace(spk2info={}), sample_rate=24000)
        self.model.add_zero_shot_spk = self.prepare
        self.adapter.model = self.model

    def prepare(self, text, path, speaker_id):
        audio, rate = sf.read(path)
        self.seen.append((audio, rate))
        self.model.frontend.spk2info[speaker_id] = {"audio": audio}
        return True

    def write_reference(self, seconds, rate=16000, stereo=False):
        values = np.arange(seconds * rate, dtype=np.float32) / (seconds * rate)
        sf.write(self.reference, np.column_stack([values, values]) if stereo else values, rate, subtype="FLOAT")

    def test_crop_boundaries_and_reuse(self):
        for seconds, expected_start in ((21, 10), (20, 10), (19, 0), (5, 0)):
            with self.subTest(seconds=seconds):
                self.write_reference(seconds, stereo=True)
                before = self.reference.read_bytes()
                speaker = self.adapter.prepare_voice(str(self.reference))
                self.assertEqual(self.adapter.prepare_voice(str(self.reference)), speaker)
                audio, rate = self.seen[-1]
                self.assertEqual(len(audio), min(10, seconds) * rate)
                self.assertAlmostEqual(audio[0], expected_start / seconds, places=5)
                self.assertEqual(before, self.reference.read_bytes())
                self.assertEqual(len(self.model.frontend.spk2info), 1)
        self.assertEqual(len(self.seen), 4)

    def test_missing_short_unsupported_and_rollback(self):
        with self.assertRaisesRegex(ValueError, "Cannot read"):
            self.adapter.prepare_voice(str(self.reference))
        self.write_reference(1, rate=8000)
        with self.assertRaisesRegex(ValueError, "16000"):
            self.adapter.prepare_voice(str(self.reference))
        sf.write(self.reference, np.zeros(100), 16000)
        with self.assertRaisesRegex(ValueError, "one second"):
            self.adapter.prepare_voice(str(self.reference))
        self.write_reference(2)
        def changed(text, path, speaker_id):
            self.model.frontend.spk2info[speaker_id] = {}
            self.write_reference(3)
            return True
        self.model.add_zero_shot_spk = changed
        with self.assertRaisesRegex(ValueError, "changed"):
            self.adapter.prepare_voice(str(self.reference))
        self.assertEqual(self.model.frontend.spk2info, {})
        self.assertIsNone(self.adapter.speaker_id)

    def test_cancelled_preparation_removes_partial_entry(self):
        self.write_reference(2)
        state = [False]
        def cancel(text, path, speaker_id):
            self.model.frontend.spk2info[speaker_id] = {}
            state[0] = True
            return True
        self.model.add_zero_shot_spk = cancel
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.adapter.prepare_voice(str(self.reference), RequestContext(lambda: state[0]))
        self.assertEqual(self.model.frontend.spk2info, {})

    def test_model_is_validated_before_loading(self):
        with self.assertRaisesRegex(ValueError, "required file missing"):
            self.adapter.validate_paths()
        for root, names in ((self.adapter.source, SOURCE_FILES), (self.adapter.model_dir, MODEL_FILES)):
            for name in names:
                path = Path(root) / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
        self.adapter.validate_paths()
        (Path(self.adapter.model_dir) / "cosyvoice2.yaml").touch()
        with self.assertRaisesRegex(ValueError, "conflicting"):
            self.adapter.validate_paths()

    def test_synthesis_parameters_and_invalid_audio(self):
        self.write_reference(2)
        class Tensor:
            def __init__(self, values):
                self.values = values
            def detach(self):
                return self
            def cpu(self):
                return self
            def numpy(self):
                return np.asarray(self.values)
        calls = []
        def inference(text, prompt, **kwargs):
            calls.append((text, prompt, kwargs))
            yield {"tts_speech": Tensor([[0.1, 0.2]])}
        self.model.inference_cross_lingual = inference
        text = "I’m sure we‘re ready; don't change [laughter] or ‘quotes’."
        audio, rate = self.adapter.synthesize(text, str(self.reference))
        self.assertEqual(rate, 24000)
        self.assertEqual(audio.shape, (2,))
        self.assertEqual(audio.dtype, np.float32)
        self.assertEqual(calls[0][0], "You are a helpful assistant.<|endofprompt|>I'm sure we're ready; don't change [laughter] or ‘quotes’.")
        self.assertEqual(text, "I’m sure we‘re ready; don't change [laughter] or ‘quotes’.")
        self.assertEqual(calls[0][1], "")
        self.assertFalse(calls[0][2]["stream"])
        self.assertFalse(calls[0][2]["text_frontend"])
        self.model.inference_cross_lingual = lambda *a, **k: [{"tts_speech": Tensor([[float("nan")]])}]
        with self.assertRaisesRegex(ValueError, "invalid audio"):
            self.adapter.synthesize("Hello", str(self.reference))


if __name__ == "__main__":
    unittest.main()
