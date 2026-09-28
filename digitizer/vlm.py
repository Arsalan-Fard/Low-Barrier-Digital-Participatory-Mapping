"""Vision-language model access: one narrow question per call, JSON back.

The pipeline never asks the model to "find everything on the photo". It asks
small questions about small crops -- read this handwriting, how many stickers
are in this crop -- and expects a JSON object back. Two backends answer them:

* ``transformers``: the model runs in this process. On the 8 GB laptop GPU the
  language model is loaded 4-bit (NF4) and the vision tower stays in bf16,
  because quantising the vision tower costs the most accuracy for the least
  memory.
* ``openai``: any OpenAI-compatible server (vLLM, llama.cpp, LM Studio...).
  Moving to a bigger GPU is a matter of starting ``vllm serve <model>`` there
  and pointing ``--vlm-url`` at it; the prompts do not change.

Answers are cached on disk by (model, prompt, schema, image bytes), so
re-running a sheet after a correction does not pay for the same calls twice.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterable

# The global Python environment carries a TensorFlow build that fails to import
# against NumPy 2; transformers must not try it.
os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TRANSFORMERS_NO_TF", "1")

import numpy as np
from PIL import Image

DEFAULT_MODEL = "Qwen/Qwen3-VL-4B-Instruct"
# Qwen3-VL turns every 32x32 pixel block into one visual token.
TOKEN_PIXELS = 32


def to_pil(image: Any) -> Image.Image:
    """Accept a PIL image, an OpenCV BGR array or a path."""
    if isinstance(image, Image.Image):
        return image.convert("RGB")
    if isinstance(image, (str, Path)):
        return Image.open(image).convert("RGB")
    array = np.asarray(image)
    if array.ndim == 2:
        return Image.fromarray(array).convert("RGB")
    return Image.fromarray(array[:, :, ::-1].copy())  # BGR -> RGB


def fit_pixels(image: Image.Image, max_pixels: int, min_pixels: int = 64 * 1024) -> Image.Image:
    """Resize to at most ``max_pixels`` with both sides a multiple of 32.

    Doing it here, rather than leaving it to the processor, keeps the token
    count -- and so the memory a call needs -- under the caller's control.
    """
    width, height = image.size
    area = width * height
    scale = 1.0
    if area > max_pixels:
        scale = (max_pixels / area) ** 0.5
    elif area < min_pixels:
        scale = (min_pixels / area) ** 0.5
    new_w = max(TOKEN_PIXELS, int(round(width * scale / TOKEN_PIXELS)) * TOKEN_PIXELS)
    new_h = max(TOKEN_PIXELS, int(round(height * scale / TOKEN_PIXELS)) * TOKEN_PIXELS)
    while new_w * new_h > max_pixels and (new_w > TOKEN_PIXELS or new_h > TOKEN_PIXELS):
        if new_w >= new_h:
            new_w -= TOKEN_PIXELS
        else:
            new_h -= TOKEN_PIXELS
    if (new_w, new_h) == image.size:
        return image
    return image.resize((new_w, new_h), Image.LANCZOS)


def extract_json(text: str) -> Any:
    """Pull the first JSON object or array out of a model answer."""
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    for opener, closer in (("{", "}"), ("[", "]")):
        start = cleaned.find(opener)
        end = cleaned.rfind(closer)
        if start < 0 or end <= start:
            continue
        candidate = cleaned[start:end + 1]
        for attempt in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
            try:
                return json.loads(attempt)
            except json.JSONDecodeError:
                continue
    raise ValueError(f"no JSON in model answer: {text[:200]!r}")


def _image_digest(image: Image.Image) -> str:
    return hashlib.sha1(image.tobytes() + repr(image.size).encode()).hexdigest()


class VLM:
    """A vision-language model that answers one question about a few images."""

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL,
        backend: str = "transformers",
        quant: str = "4bit",
        max_pixels: int = 1_600_000,
        base_url: str | None = None,
        api_key: str | None = None,
        cache_path: str | Path | None = None,
        device: str = "cuda:0",
    ):
        self.model_id = model_id
        self.backend = backend
        self.quant = quant
        self.max_pixels = int(max_pixels)
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key or os.environ.get("VLM_API_KEY", "EMPTY")
        self.device = device
        self._model = None
        self._processor = None
        self._lock = threading.Lock()
        self._cache: dict[str, Any] = {}
        self._cache_path = Path(cache_path) if cache_path else None
        if self._cache_path and self._cache_path.exists():
            for line in self._cache_path.read_text(encoding="utf-8").splitlines():
                try:
                    item = json.loads(line)
                    self._cache[item["key"]] = item["answer"]
                except (json.JSONDecodeError, KeyError):
                    continue
        self.stats = {"calls": 0, "cached": 0, "seconds": 0.0}

    # ------------------------------------------------------------------ public
    def ask(
        self,
        images: Iterable[Any],
        prompt: str,
        schema: dict | None = None,
        max_new_tokens: int = 512,
        system: str | None = None,
        max_pixels: int | None = None,
        min_pixels: int = 64 * 1024,
    ) -> Any:
        """Ask one question. Returns parsed JSON when ``schema`` is given.

        ``min_pixels`` upscales small crops: a line of handwriting cut at the
        photo's resolution is only a few hundred visual tokens' worth of
        pixels, and the model reads it better when each letter gets more.
        """
        budget = int(max_pixels or self.max_pixels)
        pil_images = [fit_pixels(to_pil(image), budget, min_pixels) for image in images]
        key = hashlib.sha1(json.dumps({
            "model": self.model_id,
            "system": system,
            "prompt": prompt,
            "schema": schema,
            "images": [_image_digest(image) for image in pil_images],
            "tokens": max_new_tokens,
        }, sort_keys=True).encode()).hexdigest()
        if key in self._cache:
            self.stats["cached"] += 1
            return self._cache[key]

        full_prompt = prompt
        if schema is not None:
            full_prompt = (
                f"{prompt}\n\nAnswer with one JSON object only, no prose, matching this "
                f"JSON schema:\n{json.dumps(schema, ensure_ascii=False)}"
            )
        started = time.time()
        with self._lock:
            if self.backend == "openai":
                text = self._ask_openai(pil_images, full_prompt, schema, max_new_tokens, system)
            else:
                text = self._ask_transformers(pil_images, full_prompt, max_new_tokens, system)
            answer: Any = text
            if schema is not None:
                try:
                    answer = extract_json(text)
                except ValueError:
                    # One retry, telling the model what went wrong. Small
                    # models occasionally open with prose.
                    retry = full_prompt + "\n\nYour previous answer was not valid JSON. Reply with the JSON object only."
                    if self.backend == "openai":
                        text = self._ask_openai(pil_images, retry, schema, max_new_tokens, system)
                    else:
                        text = self._ask_transformers(pil_images, retry, max_new_tokens, system)
                    answer = extract_json(text)
        self.stats["calls"] += 1
        self.stats["seconds"] += time.time() - started
        self._cache[key] = answer
        if self._cache_path:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            with self._cache_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"key": key, "answer": answer}, ensure_ascii=False) + "\n")
        return answer

    def unload(self) -> None:
        """Free the GPU for the next stage (8 GB holds one model at a time)."""
        self._model = None
        self._processor = None
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001 - freeing memory is best-effort
            pass

    # --------------------------------------------------------------- backends
    def _load(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration

        kwargs: dict[str, Any] = {"dtype": torch.bfloat16, "device_map": self.device}
        if self.quant in ("4bit", "8bit"):
            from transformers import BitsAndBytesConfig
            if self.quant == "4bit":
                kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_compute_dtype=torch.bfloat16,
                    bnb_4bit_use_double_quant=True,
                    llm_int8_skip_modules=["visual", "lm_head"],
                )
            else:
                kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_8bit=True, llm_int8_skip_modules=["visual", "lm_head"],
                )
        self._model = Qwen3VLForConditionalGeneration.from_pretrained(
            self.model_id, attn_implementation="sdpa", **kwargs
        ).eval()
        self._processor = AutoProcessor.from_pretrained(self.model_id)

    def _ask_transformers(self, images, prompt, max_new_tokens, system) -> str:
        import torch

        self._load()
        content = [{"type": "image"} for _ in images] + [{"type": "text", "text": prompt}]
        messages = []
        if system:
            messages.append({"role": "system", "content": [{"type": "text", "text": system}]})
        messages.append({"role": "user", "content": content})
        text = self._processor.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self._processor(
            text=[text], images=images or None, return_tensors="pt"
        ).to(self._model.device)
        with torch.inference_mode():
            output = self._model.generate(
                **inputs, max_new_tokens=max_new_tokens, do_sample=False,
                temperature=None, top_p=None, top_k=None,
            )
        generated = output[:, inputs["input_ids"].shape[1]:]
        return self._processor.batch_decode(generated, skip_special_tokens=True)[0].strip()

    def _ask_openai(self, images, prompt, schema, max_new_tokens, system) -> str:
        import requests

        content = []
        for image in images:
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=92)
            content.append({
                "type": "image_url",
                "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()},
            })
        content.append({"type": "text", "text": prompt})
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": content})
        body: dict[str, Any] = {
            "model": self.model_id,
            "messages": messages,
            "temperature": 0,
            "max_tokens": max_new_tokens,
        }
        if schema is not None:
            # vLLM and llama.cpp constrain decoding to the schema with this.
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "answer", "schema": schema},
            }
        response = requests.post(
            f"{self.base_url}/chat/completions", json=body, timeout=600,
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        response.raise_for_status()
        return response.json()["choices"][0]["message"]["content"].strip()
