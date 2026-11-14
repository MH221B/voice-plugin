import io
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from worker.main import Worker, prepare_runtime


def speak(id, texts=("one",), voice="af_heart"):
    return {"type": "speak", "id": id, "sessionId": "s", "config": {"voice": voice, "speed": 1},
            "units": [{"text": text, "emotions": {}, "boundary": "span"} for text in texts]}


class Input:
    def __init__(self):
        self.queue = queue.Queue()

    def __iter__(self):
        while (line := self.queue.get()) is not None:
            yield line

    def send(self, request):
        self.queue.put(json.dumps(request))


class Output:
    def __init__(self):
        self.queue = queue.Queue()

    def write(self, line):
        self.queue.put(json.loads(line))

    def flush(self):
        pass


class Audio:
    def __init__(self, writes):
        self.writes = writes
        self.aborted = threading.Event()

    def start(self):
        pass

    def write(self, samples):
        self.writes.append(samples)

    def abort(self):
        self.aborted.set()

    def stop(self):
        pass

    def close(self):
        pass


class RuntimeTests(unittest.TestCase):
    def test_worker_stdin_decodes_utf8_protocol(self):
        script = """
import json, sys
from worker import main
sys.stdin.reconfigure(encoding="cp1252")
main.prepare_runtime = lambda: None
def run(self, stream):
    request = json.loads(stream.readline())
    self.emit({"type": "diagnostic", "id": request["id"], "message": request["units"][0]["text"]})
main.Worker.run = run
main.main()
"""
        request = {"id": "synthetic", "units": [{"text": "I’m ready."}]}
        result = subprocess.run([sys.executable, "-c", script],
                                input=(json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"),
                                capture_output=True, timeout=10, check=True)
        self.assertEqual(json.loads(result.stdout.decode("utf-8"))["message"], "I’m ready.")

    def test_caught_exception_tracebacks_are_opt_in_and_stderr_only(self):
        for enabled in (False, True):
            output = Output()
            stderr = io.StringIO()
            with patch.dict(os.environ, {"VOICE_WORKER_LOG": "1" if enabled else "0"}), \
                 patch("sys.stderr", stderr):
                Worker(output).receive("not json")
            self.assertEqual(output.queue.get()["type"], "error")
            self.assertEqual("Traceback" in stderr.getvalue(), enabled)

    def test_bundled_espeak_defaults_and_explicit_overrides(self):
        loader = types.SimpleNamespace(get_library_path=lambda: "bundled/espeak.dll",
                                       get_data_path=lambda: "bundled/espeak-ng-data")
        with patch.dict(sys.modules, {"numpy": types.ModuleType("numpy"), "espeakng_loader": loader}), \
             patch("worker.main.sys.platform", "win32"), patch.dict(os.environ, {}, clear=True):
            prepare_runtime()
            self.assertEqual(os.environ["PHONEMIZER_ESPEAK_LIBRARY"], "bundled/espeak.dll")
            self.assertEqual(os.environ["PHONEMIZER_ESPEAK_DATA_PATH"], "bundled")
        with patch.dict(sys.modules, {"numpy": types.ModuleType("numpy"), "espeakng_loader": loader}), \
             patch("worker.main.sys.platform", "win32"), \
             patch.dict(os.environ, {"PHONEMIZER_ESPEAK_LIBRARY": "custom.dll"}, clear=True):
            prepare_runtime()
            self.assertEqual(os.environ["PHONEMIZER_ESPEAK_LIBRARY"], "custom.dll")
            self.assertNotIn("PHONEMIZER_ESPEAK_DATA_PATH", os.environ)
        with patch.dict(sys.modules, {"numpy": types.ModuleType("numpy"), "espeakng_loader": loader}), \
             patch("worker.main.sys.platform", "win32"), \
             patch.dict(os.environ, {"PHONEMIZER_ESPEAK_DATA_PATH": "custom-data"}, clear=True):
            prepare_runtime()
            self.assertEqual(os.environ["PHONEMIZER_ESPEAK_DATA_PATH"], "custom-data")

    def test_numpy_imported_on_main_thread_before_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "thread.txt"
            Path(directory, "numpy.py").write_text(
                "import os, threading\nopen(os.environ['NUMPY_MARKER'], 'w').write(threading.current_thread().name)\n",
                encoding="utf-8")
            env = os.environ.copy()
            env["NUMPY_MARKER"] = str(marker)
            env["PYTHONPATH"] = directory + os.pathsep + env.get("PYTHONPATH", "")
            process = subprocess.run([sys.executable, "-m", "worker.main"], input="", capture_output=True,
                                     text=True, env=env, timeout=10)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(json.loads(process.stdout), {"type": "ready"})
            self.assertEqual(marker.read_text(encoding="utf-8"), "MainThread")

    def test_numpy_startup_failure_is_protocol_error(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "numpy.py").write_text("raise ImportError('numpy failed')\n", encoding="utf-8")
            env = os.environ.copy()
            env["PYTHONPATH"] = directory + os.pathsep + env.get("PYTHONPATH", "")
            process = subprocess.run([sys.executable, "-m", "worker.main"], input="", capture_output=True,
                                     text=True, env=env, timeout=10)
            self.assertEqual(json.loads(process.stdout), {"type": "error", "message": "numpy failed"})


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.input = Input()
        self.output = Output()
        self.writes = []
        self.worker = None
        self.thread = None

    def start(self, pipeline, stream=None):
        self.worker = Worker(self.output, pipeline, stream or (lambda: Audio(self.writes)))
        self.thread = threading.Thread(target=self.worker.run, args=(self.input,))
        self.thread.start()
        self.assertEqual(self.output.queue.get(timeout=2), {"type": "ready"})

    def tearDown(self):
        if self.thread:
            self.input.queue.put(None)
            self.thread.join(timeout=3)
            self.assertFalse(self.thread.is_alive())

    def result(self, kind, id):
        self.assertEqual(self.output.queue.get(timeout=3), {"type": kind, "id": id})

    def test_cosyvoice_routing_validation_and_order(self):
        calls = []
        class Adapter:
            def __init__(self, source, model, diagnostic):
                calls.append((source, model))
            def synthesize(self, text, reference):
                calls.append((text, reference))
                return [text], 24000
        with patch("worker.cosyvoice_backend.CosyVoiceBackend", Adapter):
            self.start(lambda _: None, lambda rate: Audio(self.writes))
            bad = speak("bad")
            bad["config"]["backend"] = "cosyvoice3"
            self.input.send(bad)
            self.assertIn("referenceAudio", self.output.queue.get(timeout=2)["message"])
            request = speak("good", ("one", "two"))
            request["config"].update(backend="cosyvoice3", referenceAudio=os.path.abspath("ref.wav"),
                                     cosyvoiceSource=os.path.abspath("source"), cosyvoiceModel=os.path.abspath("model"))
            self.input.send(request)
            self.result("done", "good")
            self.assertEqual(self.writes, [["one"], ["two"]])
            self.assertEqual(calls[0], (request["config"]["cosyvoiceSource"], request["config"]["cosyvoiceModel"]))
            self.assertEqual([x[0] for x in calls[1:]], ["one", "two"])

    def test_cosyvoice_cancel_suppresses_inflight_audio(self):
        entered, release = threading.Event(), threading.Event()
        class Adapter:
            def __init__(self, source, model, diagnostic):
                pass
            def synthesize(self, text, reference):
                entered.set()
                release.wait(3)
                return [text], 24000
        with patch("worker.cosyvoice_backend.CosyVoiceBackend", Adapter):
            self.start(lambda _: None, lambda rate: Audio(self.writes))
            request = speak("cancel")
            request["config"].update(backend="cosyvoice3", referenceAudio=os.path.abspath("ref.wav"),
                                     cosyvoiceSource=os.path.abspath("source"), cosyvoiceModel=os.path.abspath("model"))
            self.input.send(request)
            self.assertTrue(entered.wait(2))
            self.input.send({"type": "cancel", "id": "cancel"})
            self.result("cancelled", "cancel")
            release.set()
            self.input.queue.put(None)
            self.thread.join(timeout=3)
            self.thread = None
            self.assertEqual(self.writes, [])

    def test_order_and_cached_languages(self):
        languages = []
        def factory(language):
            languages.append(language)
            return lambda text, **kwargs: [(None, None, [text + "1"]), (None, None, [text + "2"])]
        self.start(factory)
        self.input.send(speak("a", ("first", "second")))
        self.result("done", "a")
        self.input.send(speak("b", ("third",), "bf_emma"))
        self.result("done", "b")
        self.input.send(speak("c"))
        self.result("done", "c")
        self.assertEqual(self.writes, [["first1"], ["first2"], ["second1"], ["second2"], ["third1"], ["third2"], ["one1"], ["one2"]])
        self.assertEqual(languages, ["a", "b"])

    def test_kokoro_prefetch_overlap_delivery_and_rate(self):
        playing, generated, release = threading.Event(), threading.Event(), threading.Event()
        calls, rates = [], []

        class Tensor:
            def __init__(self, value):
                self.value = value
            def numpy(self):
                return [self.value]

        def factory(language):
            def pipeline(text, **kwargs):
                calls.append((language, text, kwargs))
                yield None, None, Tensor(text + "1")
                if text == "first":
                    if playing.wait(2):
                        generated.set()
                    yield None, None, Tensor(text + "2")
            return pipeline

        class BlockingAudio(Audio):
            def write(self, samples):
                if samples == ["first1"]:
                    playing.set()
                    release.wait(3)
                super().write(samples)

        def stream(rate=24000):
            rates.append(rate)
            return BlockingAudio(self.writes)

        self.start(factory, stream)
        self.input.send(speak("kokoro-overlap", ("first", "second")))
        try:
            self.assertTrue(generated.wait(2))
        finally:
            release.set()
        self.result("done", "kokoro-overlap")
        self.assertEqual(self.writes, [["first1"], ["first2"], ["second1"]])
        self.assertEqual(rates, [24000])
        self.assertEqual(calls, [("a", "first", {"voice": "af_heart", "speed": 1}),
                                 ("a", "second", {"voice": "af_heart", "speed": 1})])

    def test_kokoro_cancel_at_write_boundary_discards_prefetch(self):
        entered, prefetched, release = threading.Event(), threading.Event(), threading.Event()

        def pipeline(text, **kwargs):
            yield None, None, ["first"]
            prefetched.set()
            yield None, None, ["second"]

        class BoundaryAudio(Audio):
            def write(self, samples):
                entered.set()
                release.wait(3)
                if not self.aborted.is_set():
                    super().write(samples)

        audio = BoundaryAudio(self.writes)
        self.start(lambda _: pipeline, lambda: audio)
        self.input.send(speak("boundary"))
        try:
            self.assertTrue(entered.wait(2))
            self.assertTrue(prefetched.wait(2))
            self.input.send({"type": "cancel", "id": "boundary"})
            self.result("cancelled", "boundary")
            self.assertTrue(audio.aborted.is_set())
        finally:
            release.set()
        self.input.queue.put(None)
        self.thread.join(timeout=3)
        self.assertFalse(self.thread.is_alive())
        self.thread = None
        self.assertEqual(self.writes, [])
        self.assertTrue(self.output.queue.empty())

    def test_kokoro_synthesis_failure_drains_queued_audio(self):
        playing, failed, release = threading.Event(), threading.Event(), threading.Event()

        def pipeline(text, **kwargs):
            yield None, None, ["first"]
            playing.wait(2)
            yield None, None, ["second"]
            failed.set()
            raise RuntimeError("synthesis failed")

        class BlockingAudio(Audio):
            def write(self, samples):
                if samples == ["first"]:
                    playing.set()
                    release.wait(3)
                super().write(samples)

        self.start(lambda _: pipeline, lambda: BlockingAudio(self.writes))
        self.input.send(speak("synthesis-error"))
        try:
            self.assertTrue(failed.wait(2))
        finally:
            release.set()
        self.assertEqual(self.output.queue.get(timeout=3),
                         {"type": "error", "id": "synthesis-error", "message": "synthesis failed"})
        self.assertEqual(self.writes, [["first"], ["second"]])

    def test_kokoro_playback_failure_stops_production(self):
        class FailingAudio(Audio):
            def write(self, samples):
                raise RuntimeError("playback failed")

        def pipeline(text, **kwargs):
            for i in range(100):
                yield None, None, [i]

        self.start(lambda _: pipeline, lambda: FailingAudio(self.writes))
        self.input.send(speak("playback-error"))
        self.assertEqual(self.output.queue.get(timeout=3),
                         {"type": "error", "id": "playback-error", "message": "playback failed"})
        self.assertTrue(self.output.queue.empty())

    def test_queued_and_blocked_synthesis_cancellation(self):
        entered, release = threading.Event(), threading.Event()
        def pipeline(text, **kwargs):
            entered.set()
            release.wait(3)
            yield None, None, [text]
        self.start(lambda language: pipeline)
        self.input.send(speak("active"))
        self.assertTrue(entered.wait(2))
        self.input.send(speak("queued"))
        self.input.send({"type": "cancel", "id": "queued"})
        self.result("cancelled", "queued")
        self.input.send({"type": "cancel", "id": "active"})
        self.result("cancelled", "active")
        release.set()
        self.input.send(speak("new"))
        self.result("done", "new")
        self.assertEqual(self.writes, [["one"]])
        self.assertTrue(self.output.queue.empty())

    def test_abort_during_write(self):
        entered = threading.Event()
        audio = Audio(self.writes)
        def write(samples):
            entered.set()
            audio.aborted.wait(3)
        audio.write = write
        self.start(lambda language: lambda text, **kwargs: [(None, None, [0] * 2400)], lambda: audio)
        self.input.send(speak("active"))
        self.assertTrue(entered.wait(2))
        self.input.send({"type": "cancel", "id": "active"})
        self.result("cancelled", "active")
        self.assertTrue(audio.aborted.is_set())

    def test_malformed_and_failures(self):
        def factory(language):
            raise RuntimeError("model failed")
        self.start(factory)
        self.input.queue.put("not json")
        self.assertEqual(self.output.queue.get(timeout=2)["type"], "error")
        self.input.send({"type": "speak", "id": "bad"})
        self.assertEqual(self.output.queue.get(timeout=2)["id"], "bad")
        self.input.send(speak("model"))
        self.assertEqual(self.output.queue.get(timeout=2), {"type": "error", "id": "model", "message": "model failed"})

    def test_device_error(self):
        def fail():
            raise RuntimeError("device failed")
        self.start(lambda language: lambda text, **kwargs: [(None, None, [0])], fail)
        self.input.send(speak("device"))
        self.assertEqual(self.output.queue.get(timeout=2), {"type": "error", "id": "device", "message": "device failed"})

    def test_chatterbox_synthesizes_next_unit_during_playback(self):
        playing, second_ready, release = threading.Event(), threading.Event(), threading.Event()

        class FakeBackend:
            def __init__(self, nano, diagnostic):
                pass

            def synthesize(self, text, reference):
                if text == "second":
                    self.assert_playing = playing.wait(2)
                    if self.assert_playing:
                        second_ready.set()
                return [text], 24000

        class BlockingAudio(Audio):
            def write(self, samples):
                if samples == ["first"]:
                    playing.set()
                    release.wait(3)
                super().write(samples)

        with patch("worker.chatterbox_backend.ChatterboxBackend", FakeBackend):
            self.start(lambda language: None, lambda rate: BlockingAudio(self.writes))
            request = speak("overlap", ("first", "second"))
            request["config"]["backend"] = "chatterbox-turbo"
            self.input.send(request)
            try:
                self.assertTrue(playing.wait(2))
                self.assertTrue(second_ready.wait(2), "next sentence was not synthesized during playback")
            finally:
                release.set()
            self.result("done", "overlap")
            self.assertEqual(self.writes, [["first"], ["second"]])

    def test_chatterbox_cancel_discards_prefetched_audio(self):
        playing, prefetched = threading.Event(), threading.Event()

        class FakeBackend:
            def __init__(self, nano, diagnostic):
                pass

            def synthesize(self, text, reference):
                if text == "second":
                    playing.wait(2)
                    prefetched.set()
                return [text], 24000

        class BlockingAudio(Audio):
            def write(self, samples):
                playing.set()
                self.aborted.wait(3)
                if not self.aborted.is_set():
                    super().write(samples)

        audio = BlockingAudio(self.writes)
        with patch("worker.chatterbox_backend.ChatterboxBackend", FakeBackend):
            self.start(lambda language: None, lambda rate: audio)
            request = speak("cancel-prefetch", ("first", "second"))
            request["config"]["backend"] = "chatterbox-turbo"
            self.input.send(request)
            self.assertTrue(prefetched.wait(2))
            self.input.send({"type": "cancel", "id": "cancel-prefetch"})
            self.result("cancelled", "cancel-prefetch")
            self.assertTrue(audio.aborted.is_set())
            self.assertEqual(self.writes, [])

    def test_chatterbox_rate_selection_and_diagnostic(self):
        import numpy as np
        rates, calls = [], []
        class FakeBackend:
            def __init__(self, nano, diagnostic):
                calls.append(nano)
                self.diagnostic = diagnostic
            def synthesize(self, text, reference):
                self.diagnostic("GPU failed; retrying on CPU")
                return np.array([0.25, 0.5], dtype=np.float32), 22050
        def stream(rate):
            rates.append(rate)
            return Audio(self.writes)
        with patch("worker.chatterbox_backend.ChatterboxBackend", FakeBackend):
            self.start(lambda language: self.fail("Kokoro must not load"), stream)
            request = speak("nano")
            request["config"]["backend"] = "chatterbox-nano"
            self.input.send(request)
            self.assertEqual(self.output.queue.get(timeout=3), {"type": "diagnostic", "id": "nano", "message": "GPU failed; retrying on CPU"})
            self.result("done", "nano")
        self.assertEqual(calls, [True])
        self.assertEqual(rates, [22050])
        np.testing.assert_array_equal(self.writes[0], [0.25, 0.5])

    def test_chatterbox_cancel_during_synthesis_suppresses_output(self):
        import numpy as np
        entered, release = threading.Event(), threading.Event()
        class FakeBackend:
            def __init__(self, nano, diagnostic):
                self.diagnostic = diagnostic
            def synthesize(self, text, reference):
                entered.set()
                release.wait(3)
                self.diagnostic("stale")
                return np.array([1], dtype=np.float32), 16000
        with patch("worker.chatterbox_backend.ChatterboxBackend", FakeBackend):
            self.start(lambda language: self.fail("Kokoro must not load"), lambda rate: Audio(self.writes))
            request = speak("cancelled")
            request["config"]["backend"] = "chatterbox-turbo"
            self.input.send(request)
            self.assertTrue(entered.wait(2))
            self.input.send({"type": "cancel", "id": "cancelled"})
            self.result("cancelled", "cancelled")
            release.set()
            self.input.send(speak("next"))
            self.assertEqual(self.output.queue.get(timeout=3)["type"], "error")
            self.assertEqual(self.writes, [])
            self.assertTrue(self.output.queue.empty())

    def test_backend_and_reference_validation(self):
        self.start(lambda language: lambda text, **kwargs: [(None, None, [0])])
        for request_id, config, message in (
            ("bad-backend", {"backend": "other"}, "invalid backend"),
            ("bad-reference", {"backend": "chatterbox-nano", "referenceAudio": "relative.wav"}, "referenceAudio must be an absolute path"),
        ):
            request = speak(request_id)
            request["config"].update(config)
            self.input.send(request)
            response = self.output.queue.get(timeout=3)
            self.assertEqual(response["type"], "error")
            self.assertEqual(response["id"], request_id)
            self.assertIn(message, response["message"])
        self.input.send(speak("default"))
        self.result("done", "default")

    def test_cancel_during_gpu_failure_does_not_load_cpu(self):
        import numpy as np
        entered, release = threading.Event(), threading.Event()
        loads = []
        class Model:
            conds = object()
            sr = 24000
            tokenizer = staticmethod(lambda text, **kwargs: {"input_ids": list(text)})
            def generate(self, text, audio_prompt_path=None):
                entered.set()
                release.wait(3)
                raise RuntimeError("GPU failed")
        def load(**kwargs):
            loads.append(kwargs["device"])
            return Model()
        modules = {"torch": types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True)),
                   "chatterbox": types.ModuleType("chatterbox"),
                   "chatterbox.tts_turbo": types.SimpleNamespace(ChatterboxTurboTTS=types.SimpleNamespace(from_pretrained=load))}
        with patch.dict(sys.modules, modules):
            self.start(lambda language: lambda text, **kwargs: [(None, None, [0])], lambda rate=24000: Audio(self.writes))
            request = speak("active")
            request["config"]["backend"] = "chatterbox-nano"
            self.input.send(request)
            self.assertTrue(entered.wait(2))
            self.input.send({"type": "cancel", "id": "active"})
            self.result("cancelled", "active")
            release.set()
            self.input.send(speak("next"))
            self.result("done", "next")
            self.assertEqual(loads, ["cuda"])
            np.testing.assert_array_equal(self.writes[0], [0])
            self.assertTrue(self.output.queue.empty())
