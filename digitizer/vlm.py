"""The optional vision-language model that reads handwriting on a map: one question per call, JSON back.

Three choices, picked in the Digitizer page (``MODELS``): none, Qwen3-VL 4B on this computer, or
Qwen3-VL 32B on a server.

* On this computer the model runs in this process with PyTorch and transformers: on an 8 GB laptop
  GPU the language model is loaded 4-bit (NF4) and the vision tower stays in bf16, because
  quantising the vision tower costs the most accuracy for the least memory. Neither package is in
  requirements.txt (the app runs without them); see the README.
* On a server: any OpenAI-compatible endpoint serving the model (``vllm serve Qwen/Qwen3-VL-32B-Instruct``,
  or Ollama). Its address is set in the page and kept in data/vlm.json.

Answers are cached on disk by (model, prompt, image), so reading a sheet again costs nothing twice.
"""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np

from backend import config

# transformers must not load TensorFlow, which this computer's Python carries built for NumPy 1.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")

# id -> what the page shows and how the model is reached.
MODELS = {
    "qwen3-vl-4b": {"label": "Qwen3-VL 4B", "where": "this computer", "backend": "local",
                    "model": "Qwen/Qwen3-VL-4B-Instruct"},
    "qwen3-vl-32b": {"label": "Qwen3-VL 32B", "where": "server", "backend": "server",
                     "model": "Qwen/Qwen3-VL-32B-Instruct"},
}
# Qwen3-VL turns every 32x32 pixel block into one visual token.
TOKEN_PIXELS = 32


def settings_path() -> Path:
    return Path(config.DIGITIZER_VLM_FILE)


def load_settings() -> dict:
    """{"serverUrl": "...", "serverModel": "...", "apiKey": "..."}; empty when never set."""
    try:
        data = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_settings(changes: dict) -> dict:
    data = load_settings()
    for key in ("serverUrl", "serverModel", "apiKey"):
        if key in changes:
            data[key] = str(changes[key] or "").strip()
    settings_path().parent.mkdir(parents=True, exist_ok=True)
    settings_path().write_text(json.dumps(data, indent=2), encoding="utf-8")
    return data


def _import_transformers():
    """transformers, kept from its optional scikit-learn use: that pulls in pandas and pyarrow,
    which generating text does not need."""
    import transformers
    import transformers.utils.import_utils as import_utils
    import_utils._sklearn_available = False
    return transformers


def local_status() -> tuple[bool, str]:
    """Whether the model can run on this computer, and if not why. Only looks for the packages:
    importing PyTorch takes seconds, so the GPU is checked when the model loads."""
    if importlib.util.find_spec("torch") is None or importlib.util.find_spec("transformers") is None:
        return False, "needs PyTorch and transformers on this computer (see the Digitizer README)"
    return True, ""


def server_status(timeout: float = 4.0) -> tuple[bool, str]:
    """Whether the server answers at the address set in the page."""
    settings = load_settings()
    url = settings.get("serverUrl", "").rstrip("/")
    if not url:
        return False, "set the server's address"
    try:
        request = urllib.request.Request(f"{url}/models", headers=_auth(settings))
        with urllib.request.urlopen(request, timeout=timeout) as response:
            names = [m.get("id") for m in json.loads(response.read().decode("utf-8")).get("data", [])]
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return False, f"no answer from {url} ({getattr(exc, 'reason', exc)})"
    wanted = settings.get("serverModel") or MODELS["qwen3-vl-32b"]["model"]
    if names and wanted not in names:
        return False, f"the server runs {', '.join(n for n in names if n)}, not {wanted}"
    return True, ""


def _auth(settings: dict) -> dict:
    return {"Authorization": f"Bearer {settings.get('apiKey') or 'EMPTY'}"}


def to_pil(image: Any) -> "Image.Image":
    """A PIL image from an OpenCV BGR array (or a PIL image)."""
    from PIL import Image

    if isinstance(image, Image.Image):
        return image.convert("RGB")
    array = np.asarray(image)
    if array.ndim == 2:
        return Image.fromarray(array).convert("RGB")
    return Image.fromarray(array[:, :, ::-1].copy())


def fit_pixels(image: "Image.Image", max_pixels: int, min_pixels: int = 64 * 1024) -> "Image.Image":
    """Resized to at most ``max_pixels``, both sides a multiple of 32: the token count stays known."""
    from PIL import Image

    width, height = image.size
    area = width * height
    scale = (max_pixels / area) ** 0.5 if area > max_pixels else (min_pixels / area) ** 0.5 if area < min_pixels else 1.0
    new_w = max(TOKEN_PIXELS, int(round(width * scale / TOKEN_PIXELS)) * TOKEN_PIXELS)
    new_h = max(TOKEN_PIXELS, int(round(height * scale / TOKEN_PIXELS)) * TOKEN_PIXELS)
    while new_w * new_h > max_pixels and (new_w > TOKEN_PIXELS or new_h > TOKEN_PIXELS):
        if new_w >= new_h:
            new_w -= TOKEN_PIXELS
        else:
            new_h -= TOKEN_PIXELS
    return image if (new_w, new_h) == image.size else image.resize((new_w, new_h), Image.LANCZOS)


def extract_json(text: str) -> Any:
    """The first JSON object or array in a model answer."""
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    for opener, closer in (("{", "}"), ("[", "]")):
        start, end = cleaned.find(opener), cleaned.rfind(closer)
        if start < 0 or end <= start:
            continue
        candidate = cleaned[start:end + 1]
        for attempt in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
            try:
                return json.loads(attempt)
            except json.JSONDecodeError:
                continue
    raise ValueError(f"no JSON in model answer: {text[:200]!r}")


class VLM:
    """One of ``MODELS``, answering one question about one image."""

    def __init__(self, model_key: str, cache_path: Path | None = None):
        spec = MODELS[model_key]
        self.key = model_key
        self.backend = spec["backend"]
        settings = load_settings()
        self.model_id = (settings.get("serverModel") or spec["model"]) if self.backend == "server" else spec["model"]
        self.settings = settings
        self._model = None
        self._processor = None
        self._lock = threading.Lock()
        self._cache: dict[str, Any] = {}
        self._cache_path = cache_path
        if cache_path and cache_path.exists():
            for line in cache_path.read_text(encoding="utf-8").splitlines():
                try:
                    item = json.loads(line)
                    self._cache[item["key"]] = item["answer"]
                except (ValueError, KeyError):
                    continue
        self.stats = {"calls": 0, "cached": 0, "seconds": 0.0}

    def ask(self, image: Any, prompt: str, max_new_tokens: int = 512, max_pixels: int = 1_400_000,
            min_pixels: int = 64 * 1024) -> Any:
        """Ask one question about one image; the answer is parsed as JSON."""
        picture = fit_pixels(to_pil(image), max_pixels, min_pixels)
        key = hashlib.sha1(json.dumps({
            "model": self.model_id, "prompt": prompt, "tokens": max_new_tokens,
            "image": hashlib.sha1(picture.tobytes() + repr(picture.size).encode()).hexdigest(),
        }, sort_keys=True).encode()).hexdigest()
        if key in self._cache:
            self.stats["cached"] += 1
            return self._cache[key]
        full = f"{prompt}\n\nAnswer with one JSON object only, no prose."
        started = time.time()
        with self._lock:
            text = self._generate(picture, full, max_new_tokens)
            try:
                answer = extract_json(text)
            except ValueError:   # small models sometimes open with prose: one retry, told why
                answer = extract_json(self._generate(picture, full + " Your previous answer was not JSON.",
                                                     max_new_tokens))
        self.stats["calls"] += 1
        self.stats["seconds"] += time.time() - started
        self._cache[key] = answer
        if self._cache_path:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            with self._cache_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"key": key, "answer": answer}, ensure_ascii=False) + "\n")
        return answer

    def unload(self) -> None:
        """Free the GPU (8 GB holds one model at a time)."""
        self._model = None
        self._processor = None
        if self.backend == "local":
            import torch
            torch.cuda.empty_cache()

    # ---------------------------------------------------------------- backends
    def _generate(self, picture: Image.Image, prompt: str, max_new_tokens: int) -> str:
        if self.backend == "server":
            return self._ask_server(picture, prompt, max_new_tokens)
        return self._ask_local(picture, prompt, max_new_tokens)

    def _load(self) -> None:
        if self._model is not None:
            return
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError(f"{MODELS[self.key]['label']} needs an NVIDIA GPU with CUDA on this computer")
        _import_transformers()
        from transformers import AutoProcessor, BitsAndBytesConfig, Qwen3VLForConditionalGeneration

        quantisation = BitsAndBytesConfig(
            load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True, llm_int8_skip_modules=["visual", "lm_head"])
        self._model = Qwen3VLForConditionalGeneration.from_pretrained(
            self.model_id, dtype=torch.bfloat16, device_map="cuda:0", attn_implementation="sdpa",
            quantization_config=quantisation).eval()
        self._processor = AutoProcessor.from_pretrained(self.model_id)

    def _ask_local(self, picture: Image.Image, prompt: str, max_new_tokens: int) -> str:
        import torch

        self._load()
        messages = [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": prompt}]}]
        text = self._processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self._processor(text=[text], images=[picture], return_tensors="pt").to(self._model.device)
        with torch.inference_mode():
            output = self._model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False,
                                          temperature=None, top_p=None, top_k=None)
        generated = output[:, inputs["input_ids"].shape[1]:]
        return self._processor.batch_decode(generated, skip_special_tokens=True)[0].strip()

    def _ask_server(self, picture: Image.Image, prompt: str, max_new_tokens: int) -> str:
        url = self.settings.get("serverUrl", "").rstrip("/")
        if not url:
            raise RuntimeError("the VLM server's address is not set")
        buffer = io.BytesIO()
        picture.save(buffer, format="JPEG", quality=92)
        body = {
            "model": self.model_id, "temperature": 0, "max_tokens": max_new_tokens,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,"
                                                           + base64.b64encode(buffer.getvalue()).decode()}},
                {"type": "text", "text": prompt}]}],
        }
        request = urllib.request.Request(f"{url}/chat/completions", data=json.dumps(body).encode("utf-8"),
                                         headers={"Content-Type": "application/json", **_auth(self.settings)})
        with urllib.request.urlopen(request, timeout=600) as response:
            return json.loads(response.read().decode("utf-8"))["choices"][0]["message"]["content"].strip()
