import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
from worker.chatterbox_backend import ChatterboxBackend
from worker.synthesis import RequestContext


class Model:
    sr = 22050
    conds = object()
    tokenizer = staticmethod(lambda text, **kwargs: {"input_ids": list(text)})

    def __init__(self, device, fail=False):
        self.device, self.fail = device, fail

    def generate(self, text, audio_prompt_path=None):
        if self.fail:
            raise RuntimeError("GPU inference failed")
        return np.array([[1, 3], [3, 5]], dtype=np.float64)


class BackendTests(unittest.TestCase):
    def test_windows_rocm_disables_cudnn_only_for_gpu(self):
        for platform, hip, device, expected in (
            ("win32", "6.4", "cuda", False),
            ("win32", "6.4", "cpu", True),
            ("linux", "6.4", "cuda", True),
            ("win32", None, "cuda", True),
        ):
            with self.subTest(platform=platform, hip=hip, device=device):
                cudnn = types.SimpleNamespace(enabled=True)
                torch = types.SimpleNamespace(version=types.SimpleNamespace(hip=hip),
                                              backends=types.SimpleNamespace(cudnn=cudnn))
                def load(**kw):
                    self.assertEqual(cudnn.enabled, expected)
                    return Model(kw["device"])
                modules = {"torch": torch, "chatterbox": types.ModuleType("chatterbox"),
                           "chatterbox.tts_turbo": types.SimpleNamespace(ChatterboxTurboTTS=types.SimpleNamespace(from_pretrained=load))}
                with patch.dict(sys.modules, modules), patch("sys.platform", platform):
                    ChatterboxBackend(False).load(device)
                self.assertEqual(cudnn.enabled, expected)

    def test_long_text_is_synthesized_without_dropping_characters(self):
        texts = []
        backend = ChatterboxBackend(True)
        backend.model = Model("cpu")
        backend.device = "cpu"
        backend.bundled_conds = backend.model.conds
        def generate(text, audio_prompt_path=None):
            texts.append(text)
            return np.array([0.25])
        backend.model.generate = generate
        text = "Long words [chuckle] " * 130
        backend.synthesize(text, None)
        self.assertGreater(len(texts), 1)
        self.assertEqual("".join(texts), text)
        self.assertTrue(all(len(chunk) <= 1024 for chunk in texts))
        self.assertEqual(sum(chunk.count("[chuckle]") for chunk in texts), text.count("[chuckle]"))

    def test_cancel_during_gpu_failure_skips_cpu_load(self):
        cancelled = False
        calls = []
        class CancelModel(Model):
            def generate(self, text, audio_prompt_path=None):
                nonlocal cancelled
                cancelled = True
                raise RuntimeError("GPU failed")
        def load(**kw):
            calls.append(kw["device"])
            return CancelModel(kw["device"])
        modules = {"torch": types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True)),
                   "chatterbox": types.ModuleType("chatterbox"),
                   "chatterbox.tts_turbo": types.SimpleNamespace(ChatterboxTurboTTS=types.SimpleNamespace(from_pretrained=load))}
        with patch.dict(sys.modules, modules):
            backend = ChatterboxBackend(True)
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                backend.synthesize("hello", None, RequestContext(lambda: cancelled))
        self.assertEqual(calls, ["cuda"])

    def test_nano_and_turbo_load_and_convert(self):
        for nano in (True, False):
            calls = []
            cls = types.SimpleNamespace(from_pretrained=lambda **kw: (calls.append(kw), Model(kw["device"]))[1])
            modules = {"torch": types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False)),
                       "chatterbox": types.ModuleType("chatterbox"),
                       "chatterbox.tts_turbo": types.SimpleNamespace(ChatterboxTurboTTS=cls)}
            with patch.dict(sys.modules, modules):
                wav, rate = ChatterboxBackend(nano).synthesize("hello", None, RequestContext(diagnostic=self.fail))
            self.assertEqual(calls, [{"device": "cpu", "nano": nano}])
            self.assertEqual(rate, 22050)
            self.assertEqual(wav.dtype, np.float32)
            np.testing.assert_array_equal(wav, [2, 4])

    def test_gpu_load_and_synthesis_fallback(self):
        for fail_load in (True, False):
            calls, diagnostics = [], []
            def load(**kw):
                calls.append(kw["device"])
                if kw["device"] == "cuda" and fail_load:
                    raise RuntimeError("GPU initialization failed")
                return Model(kw["device"], fail=kw["device"] == "cuda")
            modules = {"torch": types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True)),
                       "chatterbox": types.ModuleType("chatterbox"),
                       "chatterbox.tts_turbo": types.SimpleNamespace(ChatterboxTurboTTS=types.SimpleNamespace(from_pretrained=load))}
            with patch.dict(sys.modules, modules):
                wav, _ = ChatterboxBackend(True).synthesize("hello", None, RequestContext(diagnostic=diagnostics.append))
            self.assertEqual(calls, ["cuda", "cpu"])
            self.assertEqual(len(diagnostics), 1)
            self.assertIn("retrying on CPU", diagnostics[0])
            np.testing.assert_array_equal(wav, [2, 4])

    def test_gpu_success_is_not_retried(self):
        calls, diagnostics = [], []
        def load(**kw):
            calls.append(kw["device"])
            return Model(kw["device"])
        modules = {"torch": types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True)),
                   "chatterbox": types.ModuleType("chatterbox"),
                   "chatterbox.tts_turbo": types.SimpleNamespace(ChatterboxTurboTTS=types.SimpleNamespace(from_pretrained=load))}
        with patch.dict(sys.modules, modules):
            backend = ChatterboxBackend(False)
            context = RequestContext(diagnostic=diagnostics.append)
            backend.synthesize("hello", None, context)
            backend.synthesize("again", None, context)
        self.assertEqual(calls, ["cuda"])
        self.assertEqual(diagnostics, [])

    def test_missing_dependencies_and_conditioning(self):
        backend = ChatterboxBackend(True)
        with patch.dict(sys.modules, {"torch": None}):
            with self.assertRaisesRegex(RuntimeError, "PyTorch missing"):
                backend.synthesize("hello", None)
        with patch.dict(sys.modules, {"chatterbox": None, "chatterbox.tts_turbo": None}):
            with self.assertRaisesRegex(RuntimeError, "Chatterbox dependencies missing"):
                backend.load("cpu")
        backend.model = Model("cpu")
        backend.model.conds = None
        backend.device = "cpu"
        with self.assertRaisesRegex(ValueError, "set referenceAudio"):
            backend.synthesize("hello", None)
        with self.assertRaisesRegex(ValueError, "existing audio file"):
            backend.synthesize("hello", "relative.wav")

    def test_invalid_audio_and_reference_conditioning(self):
        backend = ChatterboxBackend(True)
        backend.model = Model("cpu")
        backend.device = "cpu"
        backend.bundled_conds = backend.model.conds
        backend.model.generate = lambda *args, **kwargs: np.array([float("nan")])
        with self.assertRaisesRegex(ValueError, "invalid audio"):
            backend.synthesize("hello", None)
        calls = []
        def generate(text, audio_prompt_path=None):
            calls.append((audio_prompt_path, backend.model.conds))
            return np.array([0.5])
        backend.model.generate = generate
        def prepare(reference, context=None):
            backend.model.conds = "reference conditioning" if reference else backend.bundled_conds
        with patch.object(backend, "prepare_voice", side_effect=prepare), tempfile.NamedTemporaryFile() as reference:
            backend.synthesize("first", reference.name)
            backend.synthesize("second", None)
        self.assertEqual(calls[0], (None, "reference conditioning"))
        self.assertIs(calls[1][1], backend.bundled_conds)
