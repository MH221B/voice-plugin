"""Local, non-pickle storage for Chatterbox reference conditioning."""
import hashlib
import json
import os
from pathlib import Path
import tempfile


CACHE_DIR = Path(__file__).resolve().parent.parent / ".voice-cache"
T3_KEYS = {"speaker_emb", "clap_emb", "cond_prompt_speech_tokens", "cond_prompt_speech_emb", "emotion_adv"}
GEN_KEYS = {"prompt_token", "prompt_token_len", "prompt_feat", "prompt_feat_len", "embedding"}


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def model_version(model, module):
    import torch
    digest = hashlib.sha256(b"voice-conditioning-v1")
    package = Path(module.__file__).resolve().parent
    for source in sorted(package.rglob("*.py")):
        digest.update(str(source.relative_to(package)).encode())
        digest.update(source.read_bytes())
    for name in ("t3", "s3gen", "ve"):
        for key, tensor in sorted(getattr(model, name).state_dict().items()):
            digest.update(f"{name}.{key}:{tensor.dtype}:{tuple(tensor.shape)}".encode())
            array = tensor.detach().cpu().contiguous().reshape(-1).view(torch.uint8).numpy()
            digest.update(memoryview(array).cast("B"))
    return digest.hexdigest()


def cache_path(reference, nano, version):
    path = os.path.normcase(os.path.realpath(reference))
    key = hashlib.sha256(json.dumps([path, nano, version]).encode()).hexdigest()
    return CACHE_DIR / f"{key}.safetensors"


def save(path, conds, reference_hash):
    import torch
    from safetensors.torch import save_file
    tensors, empty = {}, []
    for prefix, values, expected in (("t3", vars(conds.t3), T3_KEYS), ("gen", conds.gen, GEN_KEYS)):
        if set(values) != expected:
            raise ValueError("Unsupported Chatterbox conditioning fields")
        for key, value in values.items():
            name = f"{prefix}.{key}"
            if value is None:
                empty.append(name)
            elif torch.is_tensor(value):
                tensors[name] = value.detach().cpu().contiguous().clone()
            else:
                raise ValueError(f"Unsupported Chatterbox conditioning value: {name}")
    digest = hashlib.sha256()
    for name, tensor in sorted(tensors.items()):
        digest.update(f"{name}:{tensor.dtype}:{tuple(tensor.shape)}".encode())
        digest.update(tensor.reshape(-1).view(torch.uint8).numpy().tobytes())
    metadata = {"reference_hash": reference_hash, "empty": json.dumps(empty), "digest": digest.hexdigest(), "key": path.name}
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    os.close(fd)
    try:
        save_file(tensors, temporary, metadata=metadata)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load(path, reference_hash, device, module):
    import torch
    from safetensors import safe_open
    with safe_open(path, framework="pt", device="cpu") as stream:
        metadata = stream.metadata()
        if not isinstance(metadata, dict) or metadata.get("key") != path.name or len(metadata.get("reference_hash", "")) != 64 or (reference_hash is not None and metadata.get("reference_hash") != reference_hash):
            raise ValueError("Reference audio changed")
        empty = json.loads(metadata["empty"])
        names = set(stream.keys())
        expected = {f"t3.{key}" for key in T3_KEYS} | {f"gen.{key}" for key in GEN_KEYS}
        if not isinstance(empty, list) or any(not isinstance(x, str) for x in empty) or len(empty) != len(set(empty)) or names & set(empty) or names | set(empty) != expected:
            raise ValueError("Invalid conditioning fields")
        tensors = {name: stream.get_tensor(name).clone() for name in names}
    digest = hashlib.sha256()
    for name, tensor in sorted(tensors.items()):
        digest.update(f"{name}:{tensor.dtype}:{tuple(tensor.shape)}".encode())
        digest.update(tensor.contiguous().reshape(-1).view(torch.uint8).numpy().tobytes())
    if digest.hexdigest() != metadata.get("digest"):
        raise ValueError("Invalid conditioning checksum")
    values = {name: tensor.to(device) for name, tensor in tensors.items()}
    values.update({name: None for name in empty})
    t3 = {key: values[f"t3.{key}"] for key in T3_KEYS}
    gen = {key: values[f"gen.{key}"] for key in GEN_KEYS}
    if any(t3[key] is None for key in ("speaker_emb", "cond_prompt_speech_tokens", "emotion_adv")) or any(gen[key] is None for key in GEN_KEYS - {"prompt_feat_len"}):
        raise ValueError("Missing conditioning tensors")
    return module.Conditionals(module.T3Cond(**t3), gen)
