"""Colour -> class, learned from examples you can add to at any time.

Each colour class (a sticker colour or a pen) is a set of example colours in
the pipeline's corrected Lab space -- not a single hard-coded hex value. One
class may have several looks: the green triangles and green circles of the
2026-09 stock measure a bright and a dark green, and both are simply examples
of "green".

Classification of one sheet happens in three steps:

1. nearest example, with lightness down-weighted (lighting moves L far more
   than it moves hue);
2. a per-sheet colour shift, estimated from the stickers that were confident
   in step 1, removes what white balance left over;
3. the sheet's own confident stickers join the examples (transductive
   nearest-neighbour), so an ambiguous sticker is compared with *this photo's*
   pinks and reds, not only with the calibration photo's.

Human corrections are clamped: they are never re-labelled, they join the
examples of this sheet at once (so one fix re-labels its look-alikes), and
``SessionPalette.learn`` keeps them for every later sheet of the session.
"""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

L_WEIGHT = 0.5          # lightness counts half: shading moves it most
SIGMA = 9.0             # softness of the confidence, in weighted Lab units
UNCERTAIN_MARGIN = 9.0  # second-best closer than this -> ask a human
REJECT_DISTANCE = 38.0  # farther than this from every example -> unknown colour


@dataclass
class ColourClass:
    id: str
    label: str
    display: str
    examples: list[list[float]] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"id": self.id, "label": self.label, "display": self.display,
                "examples": [[round(float(v), 1) for v in e] for e in self.examples]}


def weighted_distance(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    delta = np.asarray(a, np.float64) - np.asarray(b, np.float64)
    delta = delta * np.asarray([L_WEIGHT, 1.0, 1.0])
    return np.sqrt((delta * delta).sum(axis=-1))


@dataclass
class Assignment:
    colour: str | None
    confidence: float
    distance: float
    margin: float
    alternatives: list[dict]
    flags: list[str]


class Palette:
    def __init__(self, classes: list[ColourClass]):
        self.classes = classes

    @classmethod
    def from_list(cls, items: list[dict]) -> "Palette":
        return cls([ColourClass(id=i["id"], label=i.get("label", i["id"]), display=i.get("display", "#888888"),
                                examples=[list(map(float, e)) for e in i.get("examples", [])]) for i in items])

    def ids(self) -> list[str]:
        return [c.id for c in self.classes]

    def get(self, colour_id: str) -> ColourClass | None:
        return next((c for c in self.classes if c.id == colour_id), None)

    def without(self, colour_ids) -> "Palette":
        """The same palette minus some classes (e.g. gold, which only a star can be)."""
        return Palette([c for c in self.classes if c.id not in set(colour_ids)])

    def distances_to(self, lab: list[float]) -> dict[str, float]:
        """Distance of one colour to each class's nearest example."""
        row = self._distances(np.asarray([lab], np.float64))[0]
        return {c.id: float(d) for c, d in zip(self.classes, row)}

    def _distances(self, labs: np.ndarray, extra: dict[str, list] | None = None) -> np.ndarray:
        """(n, classes) distance of each colour to each class's nearest example.

        ``extra`` holds this sheet's own examples as ``(lab, source index)``;
        a colour is never compared with the example it contributed itself
        (leave-one-out), or every sticker that joined the examples would match
        itself at distance 0.
        """
        out = np.full((len(labs), len(self.classes)), np.inf)
        rows = np.arange(len(labs))[:, None]
        for j, colour in enumerate(self.classes):
            examples = [(e, -1) for e in colour.examples] + list((extra or {}).get(colour.id, []))
            if not examples:
                continue
            values = np.asarray([e for e, _ in examples], np.float64)
            sources = np.asarray([s for _, s in examples])
            d = weighted_distance(labs[:, None, :], values[None, :, :])
            d[rows == sources[None, :]] = np.inf
            out[:, j] = d.min(axis=1)
        return out

    def classify(self, labs: list[list[float]], clamp: dict[int, str] | None = None,
                 adapt: bool = True) -> tuple[list[Assignment], dict]:
        """Classify one sheet's colours. ``clamp`` maps index -> colour fixed by a human."""
        clamp = clamp or {}
        info: dict = {"shift": [0.0, 0.0, 0.0], "transductive": 0}
        if not labs:
            return [], info
        labs_arr = np.asarray(labs, np.float64)
        extra: dict[str, list] = {}
        for index, colour_id in clamp.items():
            extra.setdefault(colour_id, []).append((labs_arr[index].tolist(), index))

        distances = self._distances(labs_arr, extra)
        if adapt and len(labs_arr) >= 3:
            # step 2: per-sheet shift from confident stickers
            order = np.sort(distances, axis=1)
            best = distances.argmin(axis=1)
            confident = (order[:, 0] < 22.0) & (order[:, 1] - order[:, 0] > 14.0)
            residuals = []
            for i in np.flatnonzero(confident):
                colour = self.classes[best[i]]
                examples = np.asarray(colour.examples + [e for e, s in extra.get(colour.id, []) if s != i])
                if len(examples):
                    nearest = examples[weighted_distance(labs_arr[i][None], examples).argmin()]
                    residuals.append(labs_arr[i] - nearest)
            if len(residuals) >= 3:
                shift = np.clip(np.median(np.asarray(residuals), axis=0), -15.0, 15.0)
                labs_arr = labs_arr - shift
                info["shift"] = [round(float(v), 2) for v in shift]
                extra = {k: [(list(np.asarray(e) - shift), s) for e, s in v] for k, v in extra.items()}
                distances = self._distances(labs_arr, extra)
            # step 3: this sheet's confident stickers become examples too
            order = np.sort(distances, axis=1)
            best = distances.argmin(axis=1)
            confident = (order[:, 0] < 20.0) & (order[:, 1] - order[:, 0] > 16.0)
            for i in np.flatnonzero(confident):
                if int(i) in clamp:
                    continue
                extra.setdefault(self.classes[best[i]].id, []).append((labs_arr[i].tolist(), int(i)))
                info["transductive"] += 1
            if info["transductive"]:
                distances = self._distances(labs_arr, extra)

        assignments = []
        for i in range(len(labs_arr)):
            row = distances[i]
            order = np.argsort(row)
            best_d = float(row[order[0]])
            second_d = float(row[order[1]]) if len(order) > 1 else math.inf
            weights = np.exp(-0.5 * (np.nan_to_num(row, posinf=1e6) / SIGMA) ** 2)
            total = float(weights.sum())
            alternatives = [{"colour": self.classes[j].id, "distance": round(float(row[j]), 1),
                             "p": round(float(weights[j] / total), 3) if total > 0 else 0.0}
                            for j in order[:3] if math.isfinite(row[j])]
            flags = []
            if i in clamp:
                assignments.append(Assignment(clamp[i], 1.0, 0.0, math.inf, alternatives, ["human"]))
                continue
            colour = self.classes[order[0]].id
            confidence = float(weights[order[0]] / total) if total > 0 else 0.0
            if best_d > REJECT_DISTANCE:
                # the nearest class wins the softmax even when nothing is near
                flags.append("colour-unknown")
                colour, confidence = None, 0.0
            elif second_d - best_d < UNCERTAIN_MARGIN:
                flags.append("colour-uncertain")
            assignments.append(Assignment(colour, confidence, best_d,
                                          second_d - best_d if math.isfinite(second_d) else 99.0,
                                          alternatives, flags))
        return assignments, info


# ------------------------------------------------------------------ session

class SessionPalette:
    """The legend's palettes plus every example learned from corrections.

    Stored as ``<session dir>/palette.json``; ``corrections.jsonl`` keeps the
    raw history (who corrected what, on which sheet) for later retraining.
    """

    def __init__(self, legend: dict, directory: Path):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "palette.json"
        stored = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        self.stickers = Palette.from_list(self._merge(legend["stickers"]["colours"], stored.get("stickers")))
        self.pens = Palette.from_list(self._merge(legend["pens"], stored.get("pens")))

    @staticmethod
    def _merge(base: list[dict], learned: list[dict] | None) -> list[dict]:
        merged = {item["id"]: {**item, "examples": list(item.get("examples", []))} for item in base}
        for item in learned or []:
            if item["id"] in merged:
                known = merged[item["id"]]["examples"]
                merged[item["id"]]["examples"] = known + [e for e in item.get("examples", []) if e not in known]
            else:
                merged[item["id"]] = item   # a colour class created during review
        return list(merged.values())

    def save(self) -> None:
        data = {"stickers": [c.to_dict() for c in self.stickers.classes],
                "pens": [c.to_dict() for c in self.pens.classes], "updated": time.strftime("%Y-%m-%dT%H:%M:%S")}
        self.path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    def learn(self, kind: str, colour_id: str, lab: list[float], label: str | None = None,
              display: str | None = None, source: dict | None = None, max_examples: int = 40) -> None:
        palette = self.stickers if kind == "sticker" else self.pens
        colour = palette.get(colour_id)
        if colour is None:
            colour = ColourClass(id=colour_id, label=label or colour_id, display=display or "#888888")
            palette.classes.append(colour)
        example = [round(float(v), 1) for v in lab]
        # skip near-duplicates; keep the list bounded (oldest learned go first)
        if not colour.examples or weighted_distance(np.asarray(colour.examples), np.asarray(example)).min() > 2.0:
            colour.examples.append(example)
            if len(colour.examples) > max_examples:
                colour.examples.pop(0)
        with (self.directory / "corrections.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"time": time.strftime("%Y-%m-%dT%H:%M:%S"), "kind": kind,
                                     "colour": colour_id, "lab": example, **(source or {})},
                                    ensure_ascii=False) + "\n")
        self.save()
