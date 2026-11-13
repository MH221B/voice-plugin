import json
import os
import queue
import sys
import threading

from worker.delivery import delivery


def pipeline_factory(language):
    from kokoro import KPipeline
    return KPipeline(lang_code=language)


def stream_factory(samplerate=24000):
    import sounddevice
    return sounddevice.OutputStream(samplerate=samplerate, channels=1, dtype="float32")


def prepare_runtime():
    # NumPy's Windows native import can stall when first loaded on the playback thread.
    import numpy  # noqa: F401

    # Chatterbox's native imports can also stall on that thread on Windows.
    if sys.platform == "win32":
        import importlib.util
        if importlib.util.find_spec("chatterbox") is not None:
            from chatterbox import tts_turbo  # noqa: F401

    if sys.platform == "win32" and "PHONEMIZER_ESPEAK_LIBRARY" not in os.environ:
        try:
            import espeakng_loader
        except ModuleNotFoundError as exc:
            if exc.name != "espeakng_loader":
                raise
        else:
            os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = espeakng_loader.get_library_path()
            os.environ.setdefault("PHONEMIZER_ESPEAK_DATA_PATH", os.path.dirname(espeakng_loader.get_data_path()))


class Worker:
    def __init__(self, output, pipeline_factory=pipeline_factory, stream_factory=stream_factory):
        self.output = output
        self.pipeline_factory = pipeline_factory
        self.stream_factory = stream_factory
        self.pipelines = {}
        self.chatterboxes = {}
        self.lock = threading.RLock()
        self.pending = {}
        self.seen = set()
        self.active = None
        self.stream = None
        self.queue = queue.Queue()

    def emit(self, response):
        with self.lock:
            self.output.write(json.dumps(response, ensure_ascii=False) + "\n")
            self.output.flush()

    def terminal(self, request_id, kind, message=None):
        with self.lock:
            if request_id not in self.pending:
                return
            del self.pending[request_id]
            response = {"type": kind, "id": request_id}
            if message is not None:
                response["message"] = message
            self.emit(response)

    def cancel(self, request_id):
        with self.lock:
            if request_id not in self.pending:
                return
            if self.active == request_id and self.stream is not None:
                try:
                    self.stream.abort()
                except Exception:
                    pass
            self.terminal(request_id, "cancelled")

    def receive(self, line):
        request_id = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            request_id = request.get("id")
            if not isinstance(request_id, str) or not request_id:
                request_id = None
                raise ValueError("invalid request id")
            if request.get("type") == "cancel":
                self.cancel(request_id)
                return
            if request.get("type") != "speak":
                raise ValueError("invalid request type")
            if not isinstance(request.get("sessionId"), str) or not request["sessionId"]:
                raise ValueError("invalid session id")
            config = request.get("config")
            if not isinstance(config, dict):
                raise ValueError("invalid config")
            backend = config.get("backend", "kokoro")
            if backend not in ("kokoro", "chatterbox-nano", "chatterbox-turbo"):
                raise ValueError("invalid backend: choose kokoro, chatterbox-nano, or chatterbox-turbo")
            reference = config.get("referenceAudio")
            if reference is not None and (not isinstance(reference, str) or not os.path.isabs(reference)):
                raise ValueError("referenceAudio must be an absolute path")
            units = request.get("units")
            if not isinstance(units, list):
                raise ValueError("invalid units")
            delivery({}, config.get("voice"), config.get("speed"))
            for unit in units:
                if (not isinstance(unit, dict) or not isinstance(unit.get("text"), str)
                        or unit.get("boundary") not in ("sentence", "span")):
                    raise ValueError("invalid unit")
                delivery(unit.get("emotions"), config["voice"], config["speed"])
            with self.lock:
                if request_id in self.seen:
                    # A duplicate must not terminate the original request.
                    return
                self.seen.add(request_id)
                self.pending[request_id] = request
                self.queue.put(request)
        except (ValueError, TypeError, OverflowError) as exc:
            with self.lock:
                if request_id in self.seen:
                    return
                response = {"type": "error", "message": str(exc)}
                if request_id is not None:
                    response["id"] = request_id
                self.emit(response)

    def play(self, request):
        request_id = request["id"]
        with self.lock:
            if request_id not in self.pending:
                return
            self.active = request_id
        if request["config"].get("backend", "kokoro") != "kokoro":
            self.play_chatterbox(request)
            return
        stream = None
        try:
            config = request["config"]
            for unit in request["units"]:
                with self.lock:
                    if request_id not in self.pending:
                        return
                voice, speed = delivery(unit["emotions"], config["voice"], config["speed"])
                language = voice[0]
                if language not in self.pipelines:
                    self.pipelines[language] = self.pipeline_factory(language)
                with self.lock:
                    if request_id not in self.pending:
                        return
                chunks = (audio for _, _, audio in self.pipelines[language](unit["text"], voice=voice, speed=speed))
                for audio in chunks:
                    with self.lock:
                        if request_id not in self.pending:
                            return
                        if stream is None:
                            stream = self.stream_factory()
                            self.stream = stream
                            stream.start()
                    if hasattr(audio, "numpy"):
                        audio = audio.numpy()
                    for offset in range(0, len(audio), 1200):
                        with self.lock:
                            if request_id not in self.pending:
                                return
                        stream.write(audio[offset:offset + 1200])
            if stream is not None:
                # Drain queued audio without blocking the reader from aborting it.
                stream.stop()
            self.terminal(request_id, "done")
        except Exception as exc:
            self.terminal(request_id, "error", str(exc) or type(exc).__name__)
        finally:
            with self.lock:
                self.stream = None
                self.active = None
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

    def play_chatterbox(self, request):
        request_id = request["id"]
        config = request["config"]
        backend = config["backend"]
        audio_queue = queue.Queue(maxsize=1)
        finished = threading.Event()
        errors = []

        def cancelled():
            with self.lock:
                return request_id not in self.pending

        def diagnostic(message):
            with self.lock:
                if request_id in self.pending:
                    self.emit({"type": "diagnostic", "id": request_id, "message": message})

        def playback():
            stream = None
            rate = None
            try:
                while not cancelled():
                    try:
                        audio, current_rate = audio_queue.get(timeout=0.05)
                    except queue.Empty:
                        if finished.is_set():
                            break
                        continue
                    with self.lock:
                        if request_id not in self.pending:
                            return
                        if stream is None:
                            rate = current_rate
                            stream = self.stream_factory(rate)
                            self.stream = stream
                            stream.start()
                    if rate != current_rate:
                        raise ValueError("Chatterbox sample rate changed within a request")
                    for offset in range(0, len(audio), 1200):
                        if cancelled():
                            return
                        stream.write(audio[offset:offset + 1200])
                if stream is not None and not cancelled():
                    stream.stop()
            except Exception as exc:
                errors.append(exc)
                finished.set()
            finally:
                with self.lock:
                    self.stream = None
                if stream is not None:
                    try:
                        stream.close()
                    except Exception:
                        pass

        thread = threading.Thread(target=playback)
        thread.start()
        try:
            from worker.chatterbox_backend import ChatterboxBackend
            if backend not in self.chatterboxes:
                self.chatterboxes[backend] = ChatterboxBackend(backend == "chatterbox-nano", diagnostic)
            adapter = self.chatterboxes[backend]
            adapter.cancelled = cancelled
            adapter.diagnostic = diagnostic
            for unit in request["units"]:
                if cancelled() or finished.is_set():
                    break
                audio, rate = adapter.synthesize(unit["text"], config.get("referenceAudio"))
                while not cancelled() and not finished.is_set():
                    try:
                        audio_queue.put((audio, rate), timeout=0.05)
                        break
                    except queue.Full:
                        continue
        except Exception as exc:
            errors.append(exc)
        finally:
            finished.set()
            thread.join()
            with self.lock:
                self.active = None
            if errors:
                self.terminal(request_id, "error", str(errors[0]) or type(errors[0]).__name__)
            else:
                self.terminal(request_id, "done")

    def run(self, input_stream):
        def playback():
            while True:
                request = self.queue.get()
                if request is None:
                    return
                self.play(request)

        thread = threading.Thread(target=playback)
        thread.start()
        self.emit({"type": "ready"})
        try:
            for line in input_stream:
                self.receive(line)
        finally:
            with self.lock:
                for request_id in list(self.pending):
                    self.cancel(request_id)
            self.queue.put(None)
            thread.join()


def main():
    protocol_output = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    try:
        prepare_runtime()
    except Exception as exc:
        protocol_output.write(json.dumps({"type": "error", "message": str(exc) or type(exc).__name__}) + "\n")
        protocol_output.flush()
        return
    Worker(protocol_output).run(sys.stdin)


if __name__ == "__main__":
    main()
