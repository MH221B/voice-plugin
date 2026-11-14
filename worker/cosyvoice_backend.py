"""Local CosyVoice 3 inference; loaded only in a CosyVoice worker."""
import hashlib
import os
from worker.logging_utils import log_exception
from pathlib import Path
import re
import sys
import tempfile
import types

from worker.conditioning_cache import file_hash
from worker.synthesis import RequestContext


SOURCE_FILES = ("cosyvoice/cli/cosyvoice.py", "third_party/Matcha-TTS/matcha/__init__.py")
MODEL_FILES = (
    "cosyvoice3.yaml", "campplus.onnx", "speech_tokenizer_v3.onnx",
    "llm.pt", "flow.pt", "hift.pt", "CosyVoice-BlankEN/config.json",
    "CosyVoice-BlankEN/model.safetensors", "CosyVoice-BlankEN/tokenizer_config.json",
    "CosyVoice-BlankEN/vocab.json", "CosyVoice-BlankEN/merges.txt",
)
PREFIX = "You are a helpful assistant.<|endofprompt|>"


class CosyVoiceBackend:
    def __init__(self, source, model_dir):
        self.source = source
        self.model_dir = model_dir
        self.model = None
        self.identity = None
        self.speaker_id = None

    def check_cancelled(self, context):
        context.check_cancelled("CosyVoice request cancelled")

    def validate_paths(self):
        for label, root, names in (("source", self.source, SOURCE_FILES), ("model", self.model_dir, MODEL_FILES)):
            if not isinstance(root, str) or not os.path.isabs(root):
                raise ValueError(f"cosyvoice {label} must be an absolute path")
            for name in names:
                path = Path(root) / name
                if not path.is_file():
                    raise ValueError(f"CosyVoice required file missing: {path}")
        for name in ("cosyvoice.yaml", "cosyvoice2.yaml"):
            if (Path(self.model_dir) / name).exists():
                raise ValueError(f"CosyVoice 3 model directory contains conflicting {name}")

    def load(self, context=None):
        context = context or RequestContext()
        self.validate_paths()
        self.check_cancelled(context)
        digest = hashlib.sha256(b"cosyvoice3-reference-10s-v1")
        for root, names in ((self.source, SOURCE_FILES), (self.model_dir, MODEL_FILES)):
            digest.update(os.path.realpath(root).encode("utf-8"))
            for name in names:
                digest.update(name.encode("utf-8"))
                digest.update(file_hash(Path(root) / name).encode("ascii"))
                self.check_cancelled(context)
        for directory in (Path(self.source) / "cosyvoice", Path(self.source) / "third_party" / "Matcha-TTS" / "matcha"):
            for path in sorted(directory.rglob("*.py")):
                digest.update(str(path.relative_to(self.source)).encode("utf-8"))
                digest.update(file_hash(path).encode("ascii"))
                self.check_cancelled(context)
        try:
            import soundfile as sf
            import torch
            import torchaudio

            existing = sys.modules.get("cosyvoice")
            if existing is not None and not Path(existing.__file__).resolve().is_relative_to(Path(self.source).resolve()):
                raise RuntimeError("Another CosyVoice source is already imported")
            sys.path[:0] = [self.source, str(Path(self.source) / "third_party" / "Matcha-TTS")]
            if sys.platform == "win32":
                def soundfile_load(path, **kwargs):
                    if set(kwargs) - {"backend"} or kwargs.get("backend", "soundfile") != "soundfile":
                        raise ValueError("Unsupported torchaudio.load options for CosyVoice")
                    data, rate = sf.read(path, dtype="float32", always_2d=True)
                    return torch.from_numpy(data.T.copy()), rate
                torchaudio.load = soundfile_load
                try:
                    import pyworld  # noqa: F401
                except ModuleNotFoundError as exc:
                    if exc.name != "pyworld":
                        raise
                    sys.modules["pyworld"] = types.ModuleType("pyworld")
                    context.diagnostic("CosyVoice: pyworld unavailable; training-only pitch operations disabled")
            from cosyvoice.cli.cosyvoice import AutoModel
            self.check_cancelled(context)
            model = AutoModel(model_dir=self.model_dir)
            self.check_cancelled(context)
            devices = {name: str(next(getattr(model.model, name).parameters()).device)
                       for name in ("llm", "flow", "hift")}
            providers = model.frontend.speech_tokenizer_session.get_providers()
            context.diagnostic(f"CosyVoice model devices: {devices}; speech tokenizer providers: {providers}")
            self.model = model
            self.identity = digest.hexdigest()
        except Exception as exc:
            log_exception()
            self.check_cancelled(context)
            raise RuntimeError(f"CosyVoice initialization failed; check local dependencies and model: {exc}") from exc

    def prepare_voice(self, reference, context=None):
        context = context or RequestContext()
        import numpy as np
        import soundfile as sf

        self.check_cancelled(context)
        if not isinstance(reference, str) or not os.path.isabs(reference):
            raise ValueError("CosyVoice referenceAudio must be an absolute audio path")
        try:
            reference_hash = file_hash(reference)
        except OSError as exc:
            raise ValueError(f"Cannot read reference audio {reference}: {exc}") from exc
        self.check_cancelled(context)
        speaker_id = hashlib.sha256((self.identity + reference_hash).encode("ascii")).hexdigest()
        if speaker_id == self.speaker_id:
            return speaker_id
        temporary = None
        try:
            with sf.SoundFile(reference) as audio:
                rate, frames = audio.samplerate, len(audio)
                if rate < 16000:
                    raise ValueError("sample rate must be at least 16000 Hz")
                if frames < rate:
                    raise ValueError("reference must be at least one second")
                start = 10 * rate if frames >= 20 * rate else 0
                audio.seek(start)
                samples = audio.read(min(10 * rate, frames - start), dtype="float32", always_2d=True)
            if not samples.size or not np.isfinite(samples).all():
                raise ValueError("reference is empty or contains non-finite samples")
            with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as output:
                temporary = output.name
            sf.write(temporary, samples.mean(axis=1, dtype=np.float32), rate, subtype="FLOAT")
            self.check_cancelled(context)
            if not self.model.add_zero_shot_spk("", temporary, speaker_id):
                raise ValueError("CosyVoice rejected reference conditioning")
            self.check_cancelled(context)
            if file_hash(reference) != reference_hash:
                raise ValueError("reference audio changed during preparation; retry")
            self.check_cancelled(context)
            if self.speaker_id is not None:
                self.model.frontend.spk2info.pop(self.speaker_id, None)
            self.speaker_id = speaker_id
            return speaker_id
        except Exception as exc:
            log_exception()
            self.model.frontend.spk2info.pop(speaker_id, None)
            self.check_cancelled(context)
            raise ValueError(f"CosyVoice reference audio {reference}: {exc}") from exc
        finally:
            if temporary is not None:
                os.unlink(temporary)

    def synthesize(self, text, reference, context=None):
        context = context or RequestContext()
        self.check_cancelled(context)
        if self.model is None:
            self.load(context)
        speaker_id = self.prepare_voice(reference, context)
        self.check_cancelled(context)
        try:
            chunks = list(self.model.inference_cross_lingual(
                PREFIX + re.sub(r"(?<=\w)[‘’](?=\w)", "'", text), "", zero_shot_spk_id=speaker_id, stream=False, text_frontend=False))
        except Exception as exc:
            log_exception()
            self.check_cancelled(context)
            raise RuntimeError(f"CosyVoice inference failed: {exc}") from exc
        self.check_cancelled(context)
        import numpy as np
        pieces = [np.asarray(chunk["tts_speech"].detach().cpu().numpy(), dtype=np.float32).reshape(-1)
                  for chunk in chunks]
        if not pieces:
            raise ValueError("CosyVoice produced no audio")
        wav = np.ascontiguousarray(np.concatenate(pieces))
        rate = self.model.sample_rate
        if not wav.size or not np.isfinite(wav).all() or isinstance(rate, bool) or not isinstance(rate, int) or rate <= 0:
            raise ValueError("CosyVoice produced invalid audio or sample rate")
        return wav, rate
