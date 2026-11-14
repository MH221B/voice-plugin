import hashlib
from pathlib import Path
import tempfile
import types
import unittest

import torch

from worker.conditioning_cache import model_version


def old_model_version(model, module):
    digest = hashlib.sha256(b"voice-conditioning-v1")
    package = Path(module.__file__).resolve().parent
    for source in sorted(package.rglob("*.py")):
        digest.update(str(source.relative_to(package)).encode())
        digest.update(source.read_bytes())
    for name in ("t3", "s3gen", "ve"):
        for key, tensor in sorted(getattr(model, name).state_dict().items()):
            digest.update(f"{name}.{key}:{tensor.dtype}:{tuple(tensor.shape)}".encode())
            digest.update(tensor.detach().cpu().contiguous().reshape(-1).view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


class ModelVersionTests(unittest.TestCase):
    def test_matches_old_digest_for_tensors_metadata_and_sources(self):
        tensors = {
            "scalar": torch.tensor(3.5),
            "empty": torch.empty((2, 0, 3)),
            "noncontiguous": torch.arange(24).reshape(4, 6).t(),
            "multidimensional": torch.arange(24).reshape(2, 3, 4),
            "float16": torch.tensor([1.5, -2.0], dtype=torch.float16),
            "bfloat16": torch.tensor([1.5, -2.0], dtype=torch.bfloat16),
        }
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            (package / "__init__.py").write_bytes(b"# package\n")
            (package / "nested").mkdir()
            source = package / "nested" / "model.py"
            source.write_bytes(b"value = 1\n")
            module = types.SimpleNamespace(__file__=package / "__init__.py")
            states = [dict(tensors), {"weight": torch.tensor([1, 2])}, {}]
            model = types.SimpleNamespace(**{
                name: types.SimpleNamespace(state_dict=lambda state=state: state)
                for name, state in zip(("t3", "s3gen", "ve"), states)
            })

            def check():
                actual = model_version(model, module)
                self.assertEqual(actual, old_model_version(model, module))
                return actual

            original = check()
            source.write_bytes(b"value = 2\n")
            self.assertNotEqual(original, check())
            source.write_bytes(b"value = 1\n")
            source.rename(source.with_name("renamed.py"))
            self.assertNotEqual(original, check())
            source.with_name("renamed.py").rename(source)
            states[0]["scalar"] = torch.tensor([3.5])
            self.assertNotEqual(original, check())
            states[0]["scalar"] = torch.tensor(3.5, dtype=torch.float64)
            self.assertNotEqual(original, check())
            states[0]["renamed"] = states[0].pop("scalar")
            self.assertNotEqual(original, check())


if __name__ == "__main__":
    unittest.main()
