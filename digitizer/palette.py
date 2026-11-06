"""Colour -> class, from example colours.

Each colour class (a sticker colour or a pen) is a set of example colours in
the pipeline's corrected Lab space -- not a single hard-coded hex value. One
class may have several looks: the green triangles and green circles of the
2026-09 stock measure a bright and a dark green, and both are simply examples
of "green". Where the examples come from is ``workshop.py``.

Classification of one sheet happens in three steps:

1. nearest example, with lightness down-weighted (lighting moves L far more
   than it moves hue);
2. a per-sheet colour shift, estimated from the stickers that were confident
   in step 1, removes what white balance left over;
3. the sheet's own confident stickers join the examples (transductive
   nearest-neighbour), so an ambiguous sticker is compared with *this photo's*
   pinks and reds, not only with the calibration photo's.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

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

    def classify(self, labs: list[list[float]], adapt: bool = True) -> tuple[list[Assignment], dict]:
        """Classify one sheet's colours."""
        info: dict = {"shift": [0.0, 0.0, 0.0], "transductive": 0}
        if not labs:
            return [], info
        labs_arr = np.asarray(labs, np.float64)
        extra: dict[str, list] = {}
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


# ------------------------------------------------------------------ one photo

@dataclass
class Palettes:
    """The sticker colours and the pens one photo is digitised with (``Workshop.photo_legend``)."""
    stickers: Palette
    pens: Palette

    @classmethod
    def of(cls, legend: dict) -> "Palettes":
        return cls(Palette.from_list(legend["stickers"]["colours"]), Palette.from_list(legend["pens"]))
