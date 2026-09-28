"""What the VLM reads and judges: the questionnaire checkboxes, doubtful stickers.

Every call is one image (or a few), one narrow question and a JSON answer, and
every question is written from the legend, so a different workshop's form needs
a new ``legend.json``, not new code. The model may always answer "unclear";
those answers go to the reviewer instead of being guessed.

* Questionnaire: the side panel, cut upright from the tags' page pose; then
  each field located by the model and re-read from a full-resolution crop.
* Stickers: a crop of a doubtful sticker, shown next to confident stickers of
  the candidate colours *from the same photo* -- the model compares instead of
  naming colours in the abstract, which is where small models go wrong.
"""
from __future__ import annotations

import re
import unicodedata

import cv2
import numpy as np

from .checkboxes import merge as merge_marks, tick_marks
from .vlm import VLM

UNCLEAR = "unclear"


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z]+", " ", text.lower()).strip()


def printed(item: dict) -> str:
    """The text as printed on the sheet (French), which is what the model can find and read."""
    return item.get("printed") or item["label"]


# ------------------------------------------------------------------ questionnaire

_BOX_SCHEMA = {"type": "object", "properties": {"bbox_2d": {"type": "array", "items": {"type": "number"}}},
               "required": ["bbox_2d"]}


def locate(vlm: VLM, image: np.ndarray, what: str, pad: float = 0.02) -> np.ndarray | None:
    """Ask the model where something is; returns that crop (padded) or None.

    Qwen3-VL grounds in coordinates relative to the image, 0-1000.
    """
    answer = vlm.ask([image], f"Locate {what}. Give its bounding box as bbox_2d [x1, y1, x2, y2] in "
                              "coordinates relative to the image, from 0 to 1000.",
                     schema=_BOX_SCHEMA, max_new_tokens=60, max_pixels=1_800_000)
    box = answer.get("bbox_2d") if isinstance(answer, dict) else None
    if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
        return None
    h, w = image.shape[:2]
    x1, y1, x2, y2 = (min(1.0, max(0.0, v / 1000.0)) for v in box)
    if x2 <= x1 or y2 <= y1:
        return None
    x1, x2 = max(0.0, x1 - pad), min(1.0, x2 + pad)
    y1, y2 = max(0.0, y1 - pad), min(1.0, y2 + pad)
    crop = image[int(y1 * h):int(np.ceil(y2 * h)), int(x1 * w):int(np.ceil(x2 * w))]
    return crop if crop.size else None


def _checkbox_question(field: dict) -> tuple[str, dict]:
    options = field["options"]
    listing = "; ".join(f"{o['id']} = \"{printed(o)}\"" for o in options)
    prompt = (f"Under \"{printed(field)}\" there is a list of checkboxes. For each option say \"checked\" if the "
              f"child made ANY mark in or over ITS OWN box (tick, cross, slash, scribble, fill) -- a stroke from a "
              f"neighbouring box that only passes nearby does not count -- \"empty\" if its box is blank, or "
              f"\"{UNCLEAR}\". Options: {listing}.")
    schema = {"type": "object",
              "properties": {o["id"]: {"type": "string", "enum": ["checked", "empty", UNCLEAR]} for o in options},
              "required": [o["id"] for o in options]}
    return prompt, schema


def read_questionnaire(vlm: VLM, panel: np.ndarray, legend: dict) -> dict:
    """Several narrow calls: one pass over the whole panel, then each field again up close.

    The overview answers everything at once; each field is then located
    (grounding) and re-read from a full-resolution crop. Where the two
    readings of a checkbox disagree it becomes "unclear" for the reviewer.
    """
    form = legend.get("questionnaire") or {}
    fields = form.get("fields") or []
    if not fields:
        return {}
    lines, properties = [], {}
    for number, field in enumerate(fields, start=1):
        if field["kind"] == "checkboxes":
            prompt, schema = _checkbox_question(field)
            lines.append(f"{number}. {prompt}")
            properties[field["id"]] = schema
        else:
            lines.append(f"{number}. Transcribe the handwriting after \"{printed(field)}\" exactly as written "
                         f"(keep the original spelling, do not correct it). Use \"\" if nothing is written.")
            properties[field["id"]] = {"type": "string"}
    overview = vlm.ask([panel], "This image is part of a printed French questionnaire that a child filled in by "
                                "hand.\n" + "\n".join(lines),
                       schema={"type": "object", "properties": properties, "required": list(properties)},
                       max_new_tokens=400, max_pixels=1_800_000)
    overview = overview if isinstance(overview, dict) else {}

    result: dict = {"fields": {}, "disagreements": []}
    for field in fields:
        fid = field["id"]
        if field["kind"] == "checkboxes":
            first = overview.get(fid) if isinstance(overview.get(fid), dict) else {}
            crop = locate(vlm, panel, f"the list of checkboxes under \"{printed(field)}\" (all rows and columns, "
                                      "with their labels)")
            second = {}
            if crop is not None:
                prompt, schema = _checkbox_question(field)
                answer = vlm.ask([crop], prompt, schema=schema, max_new_tokens=250, max_pixels=1_200_000)
                second = answer if isinstance(answer, dict) else {}
            # Ink measured inside each printed box wins where it is clear, then
            # the close-up (which sees each box at full resolution), then the
            # overview; disagreements are kept so the reviewer's eye goes there
            # first. Measured on map 1: the close-up beat the overview (it
            # credited a neighbour's slash to "Train"), and the pixels beat both
            # (light single slashes read "empty" twice, on 5 of 20 sheets).
            states, disagreements = merge_marks(fid, field["options"], first, second, tick_marks(panel, field))
            result["fields"][fid] = states
            result["disagreements"].extend(disagreements)
        else:
            text = overview.get(fid) if isinstance(overview.get(fid), str) else ""
            close = ""
            crop = locate(vlm, panel, f"the handwritten text after \"{printed(field)}\"") if text.strip() else None
            if crop is not None:
                answer = vlm.ask([crop], "Transcribe the handwriting in this image exactly as written (keep the "
                                         "original spelling, do not correct it; ignore printed text). Use \"\" if "
                                         "there is no handwriting.",
                                 schema={"type": "object", "properties": {"text": {"type": "string"}},
                                         "required": ["text"]},
                                 max_new_tokens=80, max_pixels=600_000, min_pixels=350_000)
                close = answer.get("text", "") if isinstance(answer, dict) else ""
                close = close.strip().lstrip(":").strip()
            chosen = (close or text).strip()
            result["fields"][fid] = chosen
            if close and text and _normalise(close) != _normalise(text):
                result.setdefault("alternatives", {})[fid] = [text.strip()]
    return result


# ------------------------------------------------------------------ stickers

def _crop(image: np.ndarray, x: float, y: float, size: float) -> np.ndarray:
    half = int(round(size / 2))
    h, w = image.shape[:2]
    x0, y0 = max(0, int(x) - half), max(0, int(y) - half)
    x1, y1 = min(w, int(x) + half), min(h, int(y) + half)
    return image[y0:y1, x0:x1]


def _outlined_crop(image: np.ndarray, sticker, size: float) -> np.ndarray:
    """Crop around a sticker with a thin magenta ring just outside its outline.

    Without the ring the model answered about whatever sat at the centre --
    between two overlapping circles that was the map's own printed star icon.
    """
    half = int(round(size / 2))
    h, w = image.shape[:2]
    x0, y0 = max(0, int(sticker.x) - half), max(0, int(sticker.y) - half)
    x1, y1 = min(w, int(sticker.x) + half), min(h, int(sticker.y) + half)
    crop = image[y0:y1, x0:x1].copy()
    polygon = np.asarray(sticker.polygon, np.float64) - [x0, y0]
    centre = polygon.mean(axis=0)
    grown = centre + (polygon - centre) * (1.0 + 6.0 / max(8.0, sticker.diameter_px / 2))
    cv2.polylines(crop, [np.round(grown).astype(np.int32).reshape(-1, 1, 2)], True, (255, 0, 255),
                  max(2, int(sticker.diameter_px / 40)), cv2.LINE_AA)
    return crop


def verify_stickers(vlm: VLM, image: np.ndarray, stickers: list, palette, fixed: dict[str, str] | None = None,
                    flagged_only: bool = True) -> int:
    """Second opinion on doubtful stickers; the answer is attached, never silently applied.

    ``fixed`` maps shapes that come in one colour only to it ({"star": "gold"}):
    such a sticker's colour is never measured, so a VLM that sees another
    colour there is worth a look.
    """
    names = {c.id: c.label for c in palette.classes}
    colour_list = ", ".join(names)
    confident = {}
    for sticker in stickers:
        if not sticker.flags and sticker.colour and sticker.colour_confidence > 0.95:
            confident.setdefault(sticker.colour, sticker)
    asked = 0
    for sticker in stickers:
        if flagged_only and not sticker.flags:
            continue
        images, notes = [_outlined_crop(image, sticker, 2.4 * sticker.diameter_px)], []
        candidates = [a["colour"] for a in sticker.colour_alternatives[:2]]
        for colour in candidates:
            example = confident.get(colour)
            if example is not None and example is not sticker:
                images.append(_crop(image, example.x, example.y, 1.6 * example.diameter_px))
                notes.append(f"image {len(images)} shows a {colour} sticker from the same photo")
        prompt = (
            "Image 1 is a close-up of a printed street map with stickers stuck on it. ONE sticker is outlined "
            "with a thin magenta line. The map's own printed symbols (icons, small stars, letters) are not "
            "stickers. Describe the outlined sticker: its shape (circle, triangle or star) and its colour, chosen "
            f"from: {colour_list}. Also say how many separate stickers touch or overlap the outlined one, "
            "including itself."
            + (" For comparison, " + "; ".join(notes) + "." if notes else "")
            + " Answer \"unclear\" rather than guess."
        )
        schema = {"type": "object", "properties": {
            "shape": {"type": "string", "enum": ["circle", "triangle", "star", UNCLEAR]},
            "colour": {"type": "string", "enum": list(names) + [UNCLEAR]},
            "count": {"type": "integer"}}, "required": ["shape", "colour", "count"]}
        answer = vlm.ask(images, prompt, schema=schema, max_new_tokens=60, max_pixels=400_000)
        if isinstance(answer, dict):
            sticker.vlm = {k: answer.get(k) for k in ("shape", "colour")}
            if answer.get("shape") == sticker.shape and "shape-uncertain" in sticker.flags:
                sticker.flags.remove("shape-uncertain")
            elif answer.get("shape") not in (sticker.shape, UNCLEAR):
                sticker.flags.append("vlm-shape-disagrees")
            # Measured on 21 stickers: the model named 20 colours right but
            # called a pink sticker red, with a same-photo pink and red shown
            # beside it. The palette measurement beats it on close colours, so
            # its colour only counts where the measurement itself is unsure.
            colour_doubt = any(f.startswith("colour-") for f in sticker.flags) or sticker.shape in (fixed or {})
            if colour_doubt and answer.get("colour") not in (sticker.colour, UNCLEAR, None):
                sticker.flags.append("vlm-colour-disagrees")
        asked += 1
    return asked
