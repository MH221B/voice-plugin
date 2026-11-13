from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import torch

from worker import conditioning_cache as cache
from worker.chatterbox_backend import ChatterboxBackend


class T3Cond:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class Conditionals:
    def __init__(self, t3, gen):
        self.t3, self.gen = t3, gen


class Model:
    sr = 24000
    tokenizer = staticmethod(lambda text, **kwargs: {"input_ids": list(text)})

    def __init__(self):
        self.conds = "bundled"
        self.prepared = []

    def prepare_conditionals(self, reference, exaggeration):
        self.prepared.append((reference, exaggeration))
        value = float(Path(reference).read_text())
        t3 = {key: None for key in cache.T3_KEYS}
        t3.update(speaker_emb=torch.tensor([value]), cond_prompt_speech_tokens=torch.tensor([1]), emotion_adv=torch.tensor([0.]))
        gen = {key: torch.tensor([value]) for key in cache.GEN_KEYS}
        gen["prompt_feat_len"] = None
        self.conds = Conditionals(T3Cond(**t3), gen)

    def generate(self, text, audio_prompt_path=None):
        assert audio_prompt_path is None
        return torch.tensor([0.5])


class CacheTests(unittest.TestCase):
    def backend(self, nano=True, version="v1"):
        backend = ChatterboxBackend(nano, lambda message: None)
        backend.model = Model()
        backend.bundled_conds = backend.model.conds
        backend.device = "cpu"
        backend.version = version
        backend.module = types.SimpleNamespace(T3Cond=T3Cond, Conditionals=Conditionals)
        return backend

    def test_restart_changes_isolation_and_corruption(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cache, "CACHE_DIR", Path(directory) / "cache"):
            one, two = Path(directory) / "one.wav", Path(directory) / "two.wav"
            one.write_text("1")
            two.write_text("2")
            a = self.backend()
            a.synthesize("first", str(one))
            a.synthesize("next", str(one))
            self.assertEqual(a.model.prepared, [(str(one), 0.0)])
            a.synthesize("second voice", str(two))
            self.assertEqual(a.model.conds.t3.speaker_emb.item(), 2)
            a.synthesize("default", None)
            self.assertEqual(a.model.conds, "bundled")
            b = self.backend()
            b.synthesize("restart", str(one))
            self.assertEqual(b.model.prepared, [])
            self.assertEqual(b.model.conds.t3.speaker_emb.item(), 1)
            one.write_text("3")
            b.synthesize("changed", str(one))
            self.assertEqual(len(b.model.prepared), 1)
            self.assertEqual(b.model.conds.t3.speaker_emb.item(), 3)
            one.unlink()
            c = self.backend()
            c.synthesize("missing after restart", str(one))
            self.assertEqual(c.model.conds.t3.speaker_emb.item(), 3)
            for backend in (self.backend(False), self.backend(version="v2")):
                with self.assertRaisesRegex(RuntimeError, "no valid matching conditioning cache"):
                    backend.synthesize("wrong model", str(one))
            path = cache.cache_path(str(one), True, "v1")
            path.write_bytes(b"corrupt")
            with self.assertRaisesRegex(RuntimeError, "no valid matching conditioning cache"):
                self.backend().synthesize("corrupt", str(one))
            one.write_text("4")
            d = self.backend()
            d.synthesize("regenerate", str(one))
            self.assertEqual(len(d.model.prepared), 1)
            self.assertEqual(d.model.conds.t3.speaker_emb.item(), 4)

    def test_gpu_fallback_restores_cached_voice_and_long_text_prepares_once(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cache, "CACHE_DIR", Path(directory) / "cache"):
            reference = Path(directory) / "voice.wav"
            reference.write_text("7")
            backend = self.backend()
            backend.device = "cuda"
            original_load = cache.load
            def load_cpu_cache(path, reference_hash, device, module):
                return original_load(path, reference_hash, "cpu", module)
            def fail(*args, **kwargs):
                raise RuntimeError("GPU failure")
            backend.model.generate = fail
            loaded = []
            def load(device):
                loaded.append(device)
                backend.model = Model()
                backend.bundled_conds = backend.model.conds
                backend.device = device
                backend.conditioning_key = None
            backend.load = load
            with patch.object(cache, "load", side_effect=load_cpu_cache):
                backend.synthesize("x" * 1500, str(reference))
            self.assertEqual(loaded, ["cpu"])
            self.assertEqual(backend.model.prepared, [])
            self.assertEqual(backend.model.conds.t3.speaker_emb.item(), 7)

    def test_cancel_during_preparation_does_not_publish(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cache, "CACHE_DIR", Path(directory) / "cache"):
            reference = Path(directory) / "voice.wav"
            reference.write_text("1")
            backend = self.backend()
            prepare = backend.model.prepare_conditionals
            def cancel(*args, **kwargs):
                prepare(*args, **kwargs)
                backend.cancelled = lambda: True
            backend.model.prepare_conditionals = cancel
            with self.assertRaisesRegex(RuntimeError, "cancelled"):
                backend.synthesize("hello", str(reference))
            self.assertFalse(cache.cache_path(str(reference), True, "v1").exists())

    def test_failed_atomic_replace_keeps_previous_entry(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(cache, "CACHE_DIR", Path(directory) / "cache"):
            reference = Path(directory) / "voice.wav"
            reference.write_text("1")
            backend = self.backend()
            backend.synthesize("first", str(reference))
            path = cache.cache_path(str(reference), True, "v1")
            original = path.read_bytes()
            reference.write_text("2")
            with patch.object(cache.os, "replace", side_effect=OSError("disk error")):
                with self.assertRaisesRegex(RuntimeError, "disk error"):
                    backend.synthesize("second", str(reference))
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(path.parent.glob("*.tmp")), [])
            reference.write_text("1")
            backend.synthesize("original again", str(reference))
            self.assertEqual(backend.model.conds.t3.speaker_emb.item(), 1)


if __name__ == "__main__":
    unittest.main()
