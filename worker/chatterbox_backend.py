import os
import sys

from worker import conditioning_cache


class ChatterboxBackend:
    def __init__(self, nano, diagnostic):
        self.nano = nano
        self.diagnostic = diagnostic
        self.model = None
        self.device = None
        self.bundled_conds = None
        self.cancelled = lambda: False
        self.normalize = lambda text: text
        self.version = None
        self.conditioning_key = None
        self.module = None

    def load(self, device):
        if device == "cuda" and sys.platform == "win32":
            import torch
            if getattr(getattr(torch, "version", None), "hip", None):
                # Windows ROCm MIOpen kernels may lack the type_traits headers.
                torch.backends.cudnn.enabled = False
        try:
            from chatterbox import tts_turbo
        except ImportError as exc:
            raise RuntimeError("Chatterbox dependencies missing; install the pinned Chatterbox environment") from exc
        self.model = tts_turbo.ChatterboxTurboTTS.from_pretrained(device=device, nano=self.nano)
        self.device = device
        self.bundled_conds = self.model.conds
        self.normalize = getattr(tts_turbo, "punc_norm", lambda text: text)
        self.module = tts_turbo
        self.version = None
        self.conditioning_key = None

    def prepare_voice(self, reference):
        if reference is None:
            self.model.conds = self.bundled_conds
            self.conditioning_key = None
            if self.model.conds is None:
                raise ValueError("Chatterbox has no bundled conditioning; set referenceAudio to an absolute audio path")
            return
        if not os.path.isabs(reference):
            raise ValueError("referenceAudio must be an absolute path to an existing audio file or cached reference")
        if self.version is None:
            self.version = conditioning_cache.model_version(self.model, self.module)
        path = conditioning_cache.cache_path(reference, self.nano, self.version)
        try:
            reference_hash = conditioning_cache.file_hash(reference)
        except FileNotFoundError:
            reference_hash = None
        key = (str(path), reference_hash)
        if self.conditioning_key == key:
            return
        self.conditioning_key = None
        try:
            self.model.conds = conditioning_cache.load(path, reference_hash, self.device, self.module)
        except Exception as exc:
            self.check_cancelled()
            if reference_hash is None:
                raise ValueError(f"Reference audio is missing and no valid matching conditioning cache exists: {reference}") from exc
            self.model.prepare_conditionals(reference, exaggeration=0.0)
            self.check_cancelled()
            if conditioning_cache.file_hash(reference) != reference_hash:
                raise ValueError("Reference audio changed while preparing conditioning; retry")
            conditioning_cache.save(path, self.model.conds, reference_hash)
        self.conditioning_key = key

    def check_cancelled(self):
        if self.cancelled():
            raise RuntimeError("Chatterbox request cancelled")

    def split_text(self, text):
        def fits(value):
            return len(self.model.tokenizer(self.normalize(value), truncation=False)["input_ids"]) <= 1024

        parts = []
        while text:
            self.check_cancelled()
            if fits(text):
                parts.append(text)
                break
            low, high = 1, len(text) - 1
            while low < high:
                middle = (low + high + 1) // 2
                if fits(text[:middle]):
                    low = middle
                else:
                    high = middle - 1
            cut = low
            if not fits(text[:cut]):
                raise ValueError("Chatterbox cannot tokenize this text within its limit")
            space = text.rfind(" ", 0, cut)
            if space > 0 and fits(text[:space + 1]):
                cut = space + 1
            opening = text.rfind("[", 0, cut)
            if opening >= 0 and text.find("]", opening, cut) == -1 and text.find("]", cut) != -1:
                if opening == 0:
                    raise ValueError("Chatterbox tag exceeds its token limit")
                cut = opening
            parts.append(text[:cut])
            text = text[cut:]
        return parts

    def synthesize(self, text, reference):
        self.check_cancelled()
        if reference is not None and not os.path.isabs(reference):
            raise ValueError("referenceAudio must be an absolute path to an existing audio file or cached reference")
        if self.model is None:
            try:
                import torch
            except ImportError as exc:
                raise RuntimeError("PyTorch missing; install the pinned Chatterbox environment") from exc
            try:
                gpu = torch.cuda.is_available()
            except Exception as exc:
                self.diagnostic(f"GPU detection failed; retrying on CPU: {exc}")
                gpu = False
            if gpu:
                try:
                    self.load("cuda")
                except Exception as exc:
                    self.check_cancelled()
                    self.diagnostic(f"GPU initialization failed; retrying on CPU: {exc}")
            if self.model is None:
                self.check_cancelled()
                self.load("cpu")
        self.check_cancelled()
        parts = self.split_text(text)
        if len(parts) > 1:
            import numpy as np
            audio = []
            rate = None
            for part in parts:
                self.check_cancelled()
                samples, current_rate = self.synthesize(part, reference)
                if rate is not None and rate != current_rate:
                    raise ValueError("Chatterbox sample rate changed within a unit")
                rate = current_rate
                audio.append(samples)
            return np.concatenate(audio), rate
        if reference is None and self.bundled_conds is None:
            raise ValueError("Chatterbox has no bundled conditioning; set referenceAudio to an absolute audio path")
        try:
            self.prepare_voice(reference)
            self.check_cancelled()
            wav = self.model.generate(text, audio_prompt_path=None)
        except Exception as exc:
            self.check_cancelled()
            if self.device != "cuda":
                raise RuntimeError(f"Chatterbox synthesis failed (check reference audio): {exc}") from exc
            self.diagnostic(f"GPU synthesis failed; retrying on CPU: {exc}")
            self.model = None
            self.check_cancelled()
            self.load("cpu")
            self.check_cancelled()
            try:
                self.prepare_voice(reference)
                self.check_cancelled()
                wav = self.model.generate(text, audio_prompt_path=None)
            except Exception as cpu_exc:
                raise RuntimeError(f"Chatterbox CPU synthesis failed (check reference audio): {cpu_exc}") from cpu_exc

        import numpy as np
        if hasattr(wav, "detach"):
            wav = wav.detach()
        if hasattr(wav, "cpu"):
            wav = wav.cpu()
        if hasattr(wav, "numpy"):
            wav = wav.numpy()
        wav = np.asarray(wav, dtype=np.float32)
        if wav.ndim == 2:
            wav = wav.mean(axis=0, dtype=np.float32)
        if wav.ndim != 1 or not wav.size or not np.isfinite(wav).all():
            raise ValueError("Chatterbox produced invalid audio")
        rate = self.model.sr
        if not isinstance(rate, int) or isinstance(rate, bool) or rate <= 0:
            raise ValueError("Chatterbox returned an invalid sample rate")
        return wav, rate
