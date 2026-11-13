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
