"""Stickers: find each one and its shape without knowing any colours.

Detection never looks at *which* colour a sticker is -- that is decided later,
against the session palette (``palette.py``), so a new stock, a pink that sits
close to red or an unexpected colour needs no change here.

1. Sticker evidence: added ink (``photometric.py``) that is *fat*. A morphological
   opening with a disc a quarter of a sticker wide removes every pen stroke but
   keeps sticker bodies, so a red circle on a red route is not swallowed by it.
2. Each fat blob -- one sticker or a cluster of touching/overlapping ones -- is
   split into colour clusters (k-means in Lab, then merged). Nothing is named.
3. Matching pursuit with known-size templates: circles, triangles and stars at a
   few scales and rotations are slid over each colour cluster; pixels of *other*
   clusters under a template count as neither for nor against it (they may be a
   sticker lying on top), bare paper counts against it. The best template is
   accepted, its pixels marked explained, and the search repeats until nothing
   sticker-sized is left. A sticker half hidden under another is still found,
   and two touching stickers of the same colour come out as two.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import cv2
import numpy as np

SHAPES = ("circle", "triangle", "star")
STAR_INNER_RATIO = 0.48          # inner / outer radius of the five-point star
MATCH_SCALE = 0.35               # coarse template search resolution; fits are then polished at full size


@dataclass
class Sticker:
    id: int
    shape: str
    x: float                      # centre, rectified-map pixels
    y: float
    angle: float                  # template rotation, degrees
    diameter_px: float            # circumscribed diameter of the fitted template
    fill: float                   # share of the template covered by its own evidence
    occluded: float               # share of the template covered by other stickers
    shape_score: float            # (gain - penalty) / area of the winning template
    shape_margin: float           # lead over the best other shape at the same spot
    lab: list[float]              # robust colour, corrected space, OpenCV Lab 0..255
    lab_spread: float
    pixels: int                   # own visible pixels the colour was measured on
    polygon: list[list[float]]
    colour: str | None = None
    colour_confidence: float = 0.0
    colour_alternatives: list = field(default_factory=list)
    category: str | None = None
    label: str | None = None
    flags: list[str] = field(default_factory=list)
    source: str = "auto"
    vlm: dict | None = None

    def to_dict(self) -> dict:
        data = asdict(self)
        for key in ("x", "y", "angle", "diameter_px", "fill", "occluded", "shape_score",
                    "shape_margin", "lab_spread", "colour_confidence"):
            data[key] = round(float(data[key]), 3)
        data["lab"] = [round(float(v), 1) for v in self.lab]
        data["polygon"] = [[round(float(a), 1), round(float(b), 1)] for a, b in self.polygon]
        return data


# ---------------------------------------------------------------- templates

def shape_polygon(shape: str, diameter: float, angle_deg: float, cx: float = 0.0, cy: float = 0.0) -> np.ndarray:
    """Outline of a shape whose circumscribed circle has ``diameter``."""
    radius = diameter / 2.0
    theta = math.radians(angle_deg)
    if shape == "circle":
        angles = np.linspace(0, 2 * math.pi, 40, endpoint=False)
        points = np.stack([np.cos(angles), np.sin(angles)], axis=1) * radius
    elif shape == "triangle":
        angles = theta - math.pi / 2 + np.arange(3) * 2 * math.pi / 3   # angle 0 = pointing up
        points = np.stack([np.cos(angles), np.sin(angles)], axis=1) * radius
    elif shape == "star":
        angles = theta - math.pi / 2 + np.arange(10) * math.pi / 5
        radii = np.where(np.arange(10) % 2 == 0, radius, radius * STAR_INNER_RATIO)
        points = np.stack([np.cos(angles) * radii, np.sin(angles) * radii], axis=1)
    else:
        raise ValueError(shape)
    return points + np.asarray([cx, cy])


# Die-cut stickers have rounded corners: a sharp template has to grow past
# the real tips to cover the body (measured: triangles fitted 17-18 mm against
# a 15 mm sticker). Corners are rounded with this radius, as a share of the
# circumscribed diameter.
CORNER_ROUNDING = {"triangle": 0.10, "star": 0.05}


def _round_corners(mask: np.ndarray, shape: str, diameter: float) -> np.ndarray:
    radius = int(round(CORNER_ROUNDING.get(shape, 0.0) * diameter))
    if radius < 1:
        return mask
    disc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    return cv2.morphologyEx(mask, cv2.MORPH_OPEN, disc)


def shape_template(shape: str, diameter: float, angle_deg: float) -> np.ndarray:
    size = int(math.ceil(diameter)) + 3
    size += 1 - size % 2
    centre = (size - 1) / 2.0
    template = np.zeros((size, size), np.uint8)
    polygon = shape_polygon(shape, diameter, angle_deg, centre, centre)
    cv2.fillPoly(template, [np.round(polygon * 4).astype(np.int32)], 1, lineType=cv2.LINE_8, shift=2)
    return _round_corners(template, shape, diameter)


def outline(shape: str, diameter: float, angle_deg: float, cx: float, cy: float) -> np.ndarray:
    """Display outline of a (corner-rounded) sticker, in image coordinates."""
    if shape == "circle":
        return shape_polygon(shape, diameter, angle_deg, cx, cy)
    template = shape_template(shape, diameter * 4.0, angle_deg)   # 4x for a smooth contour
    contours, _ = cv2.findContours(template, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return shape_polygon(shape, diameter, angle_deg, cx, cy)
    contour = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float64)
    contour = cv2.approxPolyDP(contour.astype(np.float32), 2.0, True).reshape(-1, 2).astype(np.float64)
    centre = (template.shape[0] - 1) / 2.0
    return (contour - centre) / 4.0 + [cx, cy]


def inradius(shape: str, diameter: float) -> float:
    radius = diameter / 2.0
    if shape == "circle":
        return radius
    if shape == "triangle":
        return radius / 2.0
    # star: distance from centre to the edge joining a tip to an inner vertex
    tip = np.asarray([0.0, radius])
    inner = STAR_INNER_RATIO * radius * np.asarray([math.sin(math.pi / 5), math.cos(math.pi / 5)])
    edge = inner - tip
    return float(abs(np.cross(edge, -tip)) / np.linalg.norm(edge))


@dataclass
class TemplateBank:
    entries: list[tuple[str, float, float, np.ndarray, float]]   # shape, diameter, angle, mask, area

    @classmethod
    def build(cls, sizes_px: dict[str, float], scales=(0.9, 1.02, 1.15),
              coarse_step: dict[str, float] | None = None) -> "TemplateBank":
        coarse_step = coarse_step or {"triangle": 10.0, "star": 9.0}
        period = {"circle": 360.0, "triangle": 120.0, "star": 72.0}
        entries = []
        for shape, nominal in sizes_px.items():
            if shape not in SHAPES or not nominal:
                continue
            angles = [0.0] if shape == "circle" else list(np.arange(0.0, period[shape], coarse_step[shape]))
            for scale in scales:
                diameter = nominal * scale
                for angle in angles:
                    mask = shape_template(shape, diameter, angle)
                    entries.append((shape, diameter, float(angle), mask, float(mask.sum())))
        return cls(entries)


# ---------------------------------------------------------------- detection

def _colour_clusters(lab: np.ndarray, blob: np.ndarray, max_k: int = 8, merge_distance: float = 16.0,
                     unit_area: float | None = None):
    """Label blob pixels by colour cluster (-1 = glare/outside). Nothing is named.

    As many clusters as the blob could hold stickers (``unit_area``: one small
    sticker), plus one, up to eight. A pile at a school held six colours in 16
    sticker areas, and with four clusters yellow circles, a cream foil star and
    pale pink were one "colour"; a stack of three stickers (3.8 areas) lost the
    tips of its buried triangle to blended-rim clusters at six.

    Lightness counts for a quarter: one sticker's lit and shaded halves, or a
    gold foil star's dull khaki and bright sheen, differ mostly in lightness
    and must stay one cluster; two stickers of different colours differ in hue.
    """
    labels = np.full(blob.shape, -1, np.int32)
    ys, xs = np.nonzero(blob)
    if len(ys) == 0:
        return labels, np.zeros((0, 3), np.float32)
    pixels = lab[ys, xs].astype(np.float32)
    lightness, chroma = pixels[:, 0], np.hypot(pixels[:, 1] - 128.0, pixels[:, 2] - 128.0)
    glare = (lightness > 232) & (chroma < 12)
    feature = np.stack([pixels[:, 0] * 0.25, pixels[:, 1], pixels[:, 2]], axis=1)
    usable = feature[~glare]
    if len(usable) < 20:
        labels[ys, xs] = 0
        return labels, pixels.mean(axis=0, keepdims=True)
    k = int(min(max_k, max(1, len(usable) // 400)))
    if unit_area:
        k = min(k, math.ceil(len(usable) / unit_area) + 1)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    sample = usable if len(usable) <= 20000 else usable[np.random.default_rng(0).choice(len(usable), 20000, replace=False)]
    _, _, centres = cv2.kmeans(sample, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    centres = [c for c in centres]
    # merge clusters closer than merge_distance, and drop slivers
    while True:
        if len(centres) < 2:
            break
        distances = [(np.linalg.norm(centres[i] - centres[j]), i, j)
                     for i in range(len(centres)) for j in range(i + 1, len(centres))]
        best, i, j = min(distances)
        if best >= merge_distance:
            break
        assign = np.argmin(np.linalg.norm(usable[:, None, :] - np.asarray(centres)[None], axis=2), axis=1)
        ni, nj = max(1, int((assign == i).sum())), max(1, int((assign == j).sum()))
        merged = (centres[i] * ni + centres[j] * nj) / (ni + nj)
        centres = [c for idx, c in enumerate(centres) if idx not in (i, j)] + [merged]
    centres = np.asarray(centres, np.float32)
    assign = np.argmin(np.linalg.norm(feature[:, None, :] - centres[None], axis=2), axis=1).astype(np.int32)
    counts = np.bincount(assign[~glare], minlength=len(centres))
    keep = counts >= max(30, 0.03 * len(usable))
    if not keep.all() and keep.any():
        centres = centres[keep]
        assign = np.argmin(np.linalg.norm(feature[:, None, :] - centres[None], axis=2), axis=1).astype(np.int32)
    assign[glare] = -1
    labels[ys, xs] = assign
    return labels, centres


def _filter(image: np.ndarray, kernel: np.ndarray) -> np.ndarray:
    return cv2.filter2D(image, cv2.CV_32F, kernel.astype(np.float32), borderType=cv2.BORDER_CONSTANT)


def _pursue(union: np.ndarray, labels: np.ndarray, n_clusters: int, background: np.ndarray,
            bank: TemplateBank, min_inradius_ratio: float, distance: np.ndarray,
            unseen: np.ndarray | None = None, cluster_shapes: list[set[str]] | None = None,
            penalty: float = 2.0, impurity: float = 1.0, max_items: int = 12):
    """Greedy template pursuit on one blob (all arrays at match resolution).

    A template's score is the evidence of ONE colour cluster it explains,
    minus ``penalty`` times the bare paper it would cover; other clusters'
    pixels under it count neither way (they may be a sticker lying on top).
    ``impurity`` below 1 would let a template gain from several clusters at a
    discount -- measured on a real sheet, even 0.5 fused a red triangle under a
    yellow one into a single "star". Shading and foil sheen are handled by the
    clustering instead, which merges same-hue pixels.

    ``cluster_shapes`` (one set per colour cluster) limits which shapes may be
    fitted to which cluster: stars only come in gold, so a pink cluster -- felt
    pen doubling back beside a pink triangle -- is never fitted as a star.
    """
    found = []
    explained = np.zeros(union.shape, bool)
    claimed_by = np.full(union.shape, -9, np.int32)   # colour cluster of the fit that explained a pixel
    background_f = background.astype(np.float32)
    solid = {}  # (shape, diameter) -> where a template's centre may sit
    smallest = min(d for s, d, *_ in bank.entries if s == "circle") if any(
        e[0] == "circle" for e in bank.entries) else min(e[1] for e in bank.entries)
    # A sticker's visible colour has a solid body; the blended rims between
    # stickers do not (loose core). Where a fit would be mostly hidden by a
    # sticker of its OWN colour, the evidence is ambiguous -- red felt-pen
    # strokes doubling back beside a red triangle were fitted as a hidden star
    # -- and a thick body is required (strict core).
    loose_px, strict_px = max(2.0, 0.12 * smallest), max(2.0, 0.2 * smallest)
    for _ in range(max_items):
        evidence_all = (union & ~explained).astype(np.float32)
        if evidence_all.sum() < 0.12 * min(e[4] for e in bank.entries):
            break
        per_cluster = ([((labels == k) & ~explained).astype(np.float32) for k in range(n_clusters)]
                       if n_clusters > 1 else [])
        # A sticker's own colour has a solid body; the thin rings of blended
        # pixels along the boundary between two stickers have none.
        distances = [cv2.distanceTransform(ev.astype(np.uint8), cv2.DIST_L2, 3) for ev in (per_cluster or [evidence_all])]
        cores = [(d >= loose_px).astype(np.float32) for d in distances]
        strict_cores = [(d >= strict_px).astype(np.float32) for d in distances]
        claimed = [(claimed_by == k).astype(np.float32) for k in range(max(1, n_clusters))]
        # hidden = under a sticker already found, or outside what can be seen
        # (a tag cell, the map's edge): neither for nor against a template
        covered = explained if unseen is None else (explained | unseen)
        explained_f = covered.astype(np.float32)
        best = None
        # best absolute score of each shape at every position, for the margin
        shape_maps: dict[str, np.ndarray] = {}
        for shape, diameter, angle, mask, area in bank.entries:
            if cluster_shapes is not None and not any(shape in s for s in cluster_shapes):
                continue
            pen = _filter(background_f, mask)
            hidden = _filter(explained_f, mask) if covered.any() else np.zeros_like(pen)
            gain_all = _filter(evidence_all, mask)
            if per_cluster:
                stacked = np.stack([_filter(ev, mask) for ev in per_cluster])
                pure_cluster = stacked.argmax(axis=0)
                pure_gain = np.take_along_axis(stacked, pure_cluster[None], axis=0)[0]
                pick = lambda maps: np.take_along_axis(np.stack([_filter(m, mask) for m in maps]),  # noqa: E731
                                                       pure_cluster[None], axis=0)[0]
                core, strict_core = pick(cores), pick(strict_cores)
                hidden_same = pick(claimed) if explained.any() else np.zeros_like(pen)
                mixed = gain_all - impurity * (gain_all - pure_gain)
                use_pure = pure_gain >= mixed
                gain = np.maximum(pure_gain, mixed)
            else:
                gain, use_pure, pure_cluster = gain_all, None, None
                core, strict_core = _filter(cores[0], mask), _filter(strict_cores[0], mask)
                hidden_same = _filter(explained.astype(np.float32), mask) if explained.any() else np.zeros_like(pen)
            # Other colours under a template are neutral: they may be stickers
            # lying on top, or the blended rim between two stickers.
            other = np.maximum(gain_all - gain, 0.0)
            # A sticker partly under stickers already found is judged on the part
            # that shows: of what is neither hidden nor another colour, most must
            # be its own colour, and at least a sixth of it must show (a red
            # circle stacked on a pink one and a green triangle left only a
            # crescent and two tips of those). A slight cost on the hidden area
            # pushes the fit out from under the occluder as far as the evidence
            # allows. But no more than three quarters hidden: "the visible part
            # fits" is trivially true of a speck, and dark flecks inside a foil
            # star were fitted as black circles lying entirely under it.
            visible = np.maximum(area - hidden - other, 1.0)
            acceptable = ((gain >= 0.6 * visible) & (gain >= 0.15 * area) & (pen <= 0.25 * visible)
                          & (hidden <= 0.75 * area) & (core >= 0.02 * area))
            strict_needed = hidden_same > 0.25 * area
            acceptable &= ~strict_needed | ((gain >= 0.8 * visible) & (strict_core >= 0.03 * area))
            score = gain - penalty * pen - 0.1 * hidden
            # a sticker is solid around its centre: rejects thick pen corners
            key = (shape, diameter)
            if key not in solid:
                solid[key] = distance >= min_inradius_ratio * inradius(shape, diameter)
            score[~solid[key]] = -1e9
            if cluster_shapes is not None and per_cluster:
                barred = [k for k in range(n_clusters) if shape not in cluster_shapes[k]]
                if barred:
                    score[np.isin(pure_cluster, barred)] = -1e9
            shape_maps[shape] = score if shape not in shape_maps else np.maximum(shape_maps[shape], score)
            score = np.where(acceptable, score, -1e9)
            index = int(np.argmax(score))
            y, x = divmod(index, score.shape[1])
            value = float(score[y, x])
            if best is None or value > best["score"]:
                cluster = None
                if per_cluster and bool(use_pure[y, x]):
                    cluster = int(pure_cluster[y, x])
                elif n_clusters == 1:
                    cluster = 0
                best = {
                    "score": value, "shape": shape, "diameter": diameter, "angle": angle,
                    "area": area, "x": x, "y": y, "gain": float(gain[y, x]), "pen": float(pen[y, x]),
                    "hidden": float(hidden[y, x]), "cluster": cluster,
                }
        if best is None or best["score"] <= -1e8:
            break   # nothing left that passes as a sticker, even a half-hidden one
        area = best["area"]
        placed = np.zeros(union.shape, np.uint8)
        polygon = shape_polygon(best["shape"], best["diameter"], best["angle"], best["x"], best["y"])
        cv2.fillPoly(placed, [np.round(polygon * 4).astype(np.int32)], 1, shift=2)
        # A sticker claims only its own colour (and glare) under its outline:
        # another colour there is a sticker lying on top of it, still to be
        # found (a green triangle sitting on a pink circle was swallowed whole).
        own = (labels == best["cluster"]) | (labels < 0) if best["cluster"] is not None else union
        newly = cv2.dilate(placed, np.ones((3, 3), np.uint8)).astype(bool) & union & own & ~explained
        explained |= newly
        claimed_by[newly] = best["cluster"] if best["cluster"] is not None else 0
        # lead over the best *other* shape placed at (nearly) the same spot
        reach = max(1, int(round(0.2 * best["diameter"])))
        ys = slice(max(0, best["y"] - reach), best["y"] + reach + 1)
        xs = slice(max(0, best["x"] - reach), best["x"] + reach + 1)
        rivals = [float(m[ys, xs].max()) for s, m in shape_maps.items() if s != best["shape"]]
        rival = max([r for r in rivals if r > -1e8], default=0.0)
        best["margin"] = float((best["score"] - rival) / area)
        found.append(best)
    return found


def _rasterise(shape: str, diameter: float, angle: float, cx: float, cy: float, size: tuple[int, int]) -> np.ndarray:
    mask = np.zeros(size, np.uint8)
    polygon = shape_polygon(shape, diameter, angle, cx, cy)
    cv2.fillPoly(mask, [np.round(polygon * 4).astype(np.int32)], 1, shift=2)
    if shape in CORNER_ROUNDING:
        # round only around the sticker, not the whole crop
        x0 = max(0, int(cx - diameter)); y0 = max(0, int(cy - diameter))
        x1 = min(size[1], int(cx + diameter) + 2); y1 = min(size[0], int(cy + diameter) + 2)
        if x1 > x0 and y1 > y0:
            mask[y0:y1, x0:x1] = _round_corners(mask[y0:y1, x0:x1], shape, diameter)
    return mask.astype(bool)


def _seed_fit(shape: str, diameter: float, cx: float, cy: float, evidence: np.ndarray,
              neutral: np.ndarray) -> tuple[float, float, float, float]:
    """Best (iou, angle, x, y) for another shape near a fit, over a wide grid.

    A shape re-check cannot start at the old fit's centre: a triangle whose
    top is hidden under another sticker has its centre well away from the
    visible wedge a small circle was fitted to.
    """
    # IoU for every position at once: with the evidence disjoint from the
    # neutral pixels, |(T | E) - N| = |T - N| + |E| - |T & E|, and both
    # counts are correlations of the template with a mask.
    period = {"circle": 360.0, "triangle": 120.0, "star": 72.0}[shape]
    angles = [0.0] if shape == "circle" else list(np.arange(0.0, period, 10.0))
    evidence_f = evidence.astype(np.float32)
    counted_f = (~neutral).astype(np.float32)
    total = float(evidence_f.sum())
    height, width = evidence.shape
    yy, xx = np.mgrid[0:height, 0:width]
    near = (xx - cx) ** 2 + (yy - cy) ** 2 <= (0.36 * diameter) ** 2
    best = (-1.0, 0.0, cx, cy)
    for angle in angles:
        template = shape_template(shape, diameter, angle).astype(np.float32)
        inter = _filter(evidence_f, template)
        iou = inter / np.maximum(_filter(counted_f, template) + total - inter, 1.0)
        iou[~near] = -1.0
        index = int(np.argmax(iou))
        y, x = divmod(index, width)
        if iou[y, x] > best[0]:
            best = (float(iou[y, x]), float(angle), float(x), float(y))
    return best


def _refine_fit(shape: str, diameter: float, angle: float, cx: float, cy: float,
                evidence: np.ndarray, neutral: np.ndarray) -> tuple[float, float, float, float, float]:
    """Polish a coarse fit at full resolution by maximising IoU with its own evidence.

    ``neutral`` pixels (other stickers) count neither way: this sticker may lie
    under them. Coordinate ascent over scale, rotation and position.
    """
    size = evidence.shape
    counted = ~neutral

    def iou(d, a, x, y):
        mask = _rasterise(shape, d, a, x, y, size)
        inter = np.count_nonzero(mask & evidence)
        union = np.count_nonzero((mask | evidence) & counted)
        return inter / max(1, union)

    best = (iou(diameter, angle, cx, cy), diameter, angle, cx, cy)
    for _ in range(2):
        _, d0, a0, x0, y0 = best
        for factor in (0.88, 0.92, 0.96, 1.04, 1.08, 1.12):
            value = iou(d0 * factor, a0, x0, y0)
            if value > best[0]:
                best = (value, d0 * factor, a0, x0, y0)
        if shape != "circle":
            _, d0, a0, x0, y0 = best
            for delta in (-6.0, -4.0, -2.0, 2.0, 4.0, 6.0):
                value = iou(d0, a0 + delta, x0, y0)
                if value > best[0]:
                    best = (value, d0, a0 + delta, x0, y0)
        _, d0, a0, x0, y0 = best
        for dx in (-3.0, -1.5, 0.0, 1.5, 3.0):
            for dy in (-3.0, -1.5, 0.0, 1.5, 3.0):
                if dx == 0.0 and dy == 0.0:
                    continue
                value = iou(d0, a0, x0 + dx, y0 + dy)
                if value > best[0]:
                    best = (value, d0, a0, x0 + dx, y0 + dy)
    return best


def detect_stickers(corrected: np.ndarray, score: np.ndarray, valid: np.ndarray, px_per_mm: float,
                    sizes_mm: dict[str, float], strong: float = 20.0, weak: float = 12.0,
                    covered: np.ndarray | None = None,
                    shape_gate=None) -> tuple[list[Sticker], np.ndarray]:
    """All stickers on the rectified map, colour left unassigned.

    ``shape_gate(lab) -> shapes`` may limit the shapes tried on a colour
    cluster (see ``pipeline.shape_gate``: a star only where it could be gold);
    no colour is named here.

    Returns the stickers and a label image (0 = none, i = sticker id) of the
    pixels they cover, which the stroke pass uses to leave them out.
    """
    height, width = score.shape
    sizes_px = {shape: mm * px_per_mm for shape, mm in sizes_mm.items() if shape in SHAPES}
    smallest = min(sizes_px.values())

    # hysteresis: weak pixels count when connected to strong ones (pale foil,
    # glare edges) -- and so does printed detail that vanished under something
    # opaque (a black sticker over a dark printed icon, see covered_detail)
    strong_mask = (score >= strong) & (valid > 0)
    weak = (score >= weak) & (valid > 0)
    if covered is not None:
        weak |= covered
    weak_mask = weak.astype(np.uint8)
    count, comp = cv2.connectedComponents(weak_mask, connectivity=8)
    keep = np.zeros(count, bool)
    keep[np.unique(comp[strong_mask])] = True
    keep[0] = False
    evidence = keep[comp]

    # fat parts only: an opening this size removes pen strokes up to ~2.5 mm
    # wide (felt tip measures 1.7 mm) but keeps every sticker body
    radius = max(2, int(round(0.14 * smallest)))
    disc = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    fat = cv2.morphologyEx(evidence.astype(np.uint8), cv2.MORPH_OPEN, disc)
    count, blobs, stats, _ = cv2.connectedComponentsWithStats(fat, 8)
    min_area = 0.2 * math.pi * (smallest / 2.0) ** 2

    lab = cv2.cvtColor(corrected, cv2.COLOR_BGR2LAB)
    bank = TemplateBank.build({s: d * MATCH_SCALE for s, d in sizes_px.items()})
    grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 7, 2 * radius + 7))
    stickers: list[Sticker] = []
    cover = np.zeros((height, width), np.int32)
    margin = int(max(sizes_px.values()))

    for index in range(1, count):
        if stats[index, cv2.CC_STAT_AREA] < min_area:
            continue
        x0 = max(0, stats[index, cv2.CC_STAT_LEFT] - margin)
        y0 = max(0, stats[index, cv2.CC_STAT_TOP] - margin)
        x1 = min(width, stats[index, cv2.CC_STAT_LEFT] + stats[index, cv2.CC_STAT_WIDTH] + margin)
        y1 = min(height, stats[index, cv2.CC_STAT_TOP] + stats[index, cv2.CC_STAT_HEIGHT] + margin)
        core = (blobs[y0:y1, x0:x1] == index).astype(np.uint8)
        # back to the full extent (corners the opening rounded off), holes filled
        union = (cv2.dilate(core, grow) > 0) & evidence[y0:y1, x0:x1]
        union = _fill_holes(union, max_hole=0.6 * math.pi * (smallest / 2.0) ** 2)
        local_valid = valid[y0:y1, x0:x1] > 0
        background = ~cv2.dilate(union.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & local_valid
        labels, centres = _colour_clusters(lab[y0:y1, x0:x1], union, unit_area=math.pi * (smallest / 2.0) ** 2)
        cluster_shapes = None
        if shape_gate is not None:
            crop_lab = lab[y0:y1, x0:x1]
            cluster_shapes = []
            for k in range(len(centres)):
                pixels = crop_lab[labels == k]
                cluster_shapes.append(set(shape_gate(np.median(pixels, axis=0).tolist())) if len(pixels)
                                      else set(SHAPES))

        small = (max(8, int(round((x1 - x0) * MATCH_SCALE))), max(8, int(round((y1 - y0) * MATCH_SCALE))))
        union_s = cv2.resize(union.astype(np.uint8), small, interpolation=cv2.INTER_NEAREST).astype(bool)
        labels_s = cv2.resize(labels, small, interpolation=cv2.INTER_NEAREST)
        background_s = cv2.resize(background.astype(np.uint8), small, interpolation=cv2.INTER_NEAREST).astype(bool)
        distance_s = cv2.distanceTransform(union_s.astype(np.uint8), cv2.DIST_L2, 5)
        unseen_s = cv2.resize((~local_valid).astype(np.uint8), small, interpolation=cv2.INTER_NEAREST).astype(bool)
        found = _pursue(union_s, labels_s, len(centres), background_s, bank, 0.55, distance_s, unseen_s,
                        cluster_shapes=cluster_shapes)

        crop_size = (y1 - y0, x1 - x0)
        fits = []
        for item in found:
            fits.append([item["shape"], item["diameter"] / MATCH_SCALE, item["angle"],
                         (item["x"] + 0.5) / MATCH_SCALE - 0.5, (item["y"] + 0.5) / MATCH_SCALE - 0.5])
        # Polish every fit at full resolution against its own colour: other
        # colours are neutral (a sticker may lie on top of it, or under it),
        # and so are other fits of the same colour and anything unseen. A fit
        # that is partly hidden, or whose shape was a close call, also gets the
        # other shapes tried: a green triangle sandwiched between two circles
        # showed only a wedge and a tip, and the coarse search fitted a circle.
        rasters = [_rasterise(f[0], f[1], f[2], f[3], f[4], crop_size) for f in fits]
        for position, fit in enumerate(fits):
            cluster = found[position]["cluster"]
            same = union if cluster is None else (union & (labels == cluster))
            others_same = np.zeros(crop_size, bool)
            for other_position, other in enumerate(fits):
                if other_position != position and found[other_position]["cluster"] == cluster:
                    others_same |= rasters[other_position]
            own_evidence = same & ~others_same
            neutral = (union & ~same) | others_same | ~local_valid
            candidates = [_refine_fit(fit[0], fit[1], fit[2], fit[3], fit[4], own_evidence, neutral) + (fit[0],)]
            doubtful = (found[position]["hidden"] > 0.25 * found[position]["area"] or found[position]["margin"] < 0.12
                        or found[position]["gain"] < 0.7 * found[position]["area"])
            if doubtful:
                for shape in SHAPES:
                    if shape == fit[0] or shape not in sizes_px:
                        continue
                    if cluster_shapes is not None and cluster is not None and shape not in cluster_shapes[cluster]:
                        continue
                    _, angle, sx, sy = _seed_fit(shape, sizes_px[shape], fit[3], fit[4], own_evidence, neutral)
                    candidates.append(_refine_fit(shape, sizes_px[shape], angle, sx, sy, own_evidence, neutral)
                                      + (shape,))
            _, fit[1], fit[2], fit[3], fit[4], fit[0] = max(candidates, key=lambda c: c[0])
            if fit[0] != found[position]["shape"]:
                found[position]["shape"] = fit[0]
                found[position]["margin"] = 0.0     # changed by the re-check: keep it flagged for a look
            rasters[position] = _rasterise(fit[0], fit[1], fit[2], fit[3], fit[4], crop_size)
        placed_full = []
        for item, (shape, diameter, angle, lx, ly) in zip(found, fits):
            item["angle"] = angle % {"circle": 360.0, "triangle": 120.0, "star": 72.0}[shape]
            polygon = outline(shape, diameter, item["angle"], lx + x0, ly + y0)
            placed_full.append((item, lx + x0, ly + y0, diameter, polygon,
                                _rasterise(shape, diameter, item["angle"], lx, ly, crop_size)))
        placed_full = _drop_buried(placed_full, union, labels)

        for position, (item, cx, cy, diameter, polygon, mask) in enumerate(placed_full):
            others = np.zeros_like(mask)
            for other_position, other in enumerate(placed_full):
                if other_position != position:
                    others |= other[5]
            # Its colour is measured on its own colour cluster: where its outline
            # overlaps another sticker's, that may well be where it shows (a
            # triangle lying on a circle), so other outlines are not excluded --
            # only other fits of the same colour.
            if item["cluster"] is not None:
                same_others = np.zeros_like(mask)
                for other_position, other in enumerate(placed_full):
                    if other_position != position and other[0]["cluster"] == item["cluster"]:
                        same_others |= other[5]
                own = mask & union & (labels == item["cluster"]) & ~same_others
            else:
                own = mask & union & ~others
            lab_value, spread, used = _robust_colour(lab[y0:y1, x0:x1], own)
            # hidden = covered by another colour, not merely overlapped by
            # another outline: the sticker on top of a stack hides nothing
            if item["cluster"] is not None:
                occluded = float((mask & union & (labels != item["cluster"]) & (labels >= 0)).sum()) / max(1.0, float(mask.sum()))
            else:
                occluded = float((mask & others).sum()) / max(1.0, float(mask.sum()))
            sticker = Sticker(
                id=len(stickers) + 1, shape=item["shape"], x=float(cx), y=float(cy), angle=item["angle"],
                diameter_px=float(diameter), fill=float(item["gain"] / item["area"]), occluded=occluded,
                shape_score=float(item["score"] / item["area"]), shape_margin=float(item["margin"]),
                lab=lab_value, lab_spread=spread, pixels=used, polygon=polygon.tolist(),
            )
            if sticker.shape_margin < 0.12:
                sticker.flags.append("shape-uncertain")
            if occluded > 0.35:
                sticker.flags.append("mostly-hidden")
            stickers.append(sticker)
            region = cover[y0:y1, x0:x1]
            region[mask & (region == 0)] = sticker.id
    return stickers, cover


def _drop_buried(placed: list, union: np.ndarray, labels: np.ndarray, minimum: float = 0.12) -> list:
    """Remove fits that show almost none of their own colour.

    Judged on what is *visible*, not on how outlines overlap: a sticker lying
    on top of another overlaps it heavily yet shows all of itself, while dark
    flecks inside a foil star, fitted as a black circle, show next to nothing.
    Of two fits on the same colour that nearly coincide, the weaker goes too.
    """
    def own(entry, pool):
        cluster = entry[0]["cluster"]
        colour = union if cluster is None else (union & (labels == cluster))
        others = np.zeros_like(entry[5])
        for other in pool:
            if other is not entry and other[0]["cluster"] == cluster:
                others |= other[5]
        return float((entry[5] & colour & ~others).sum()) / max(1.0, float(entry[5].sum()))

    kept = [entry for entry in placed if own(entry, placed) >= minimum]
    changed = True
    while changed:
        changed = False
        for a in kept:
            for b in kept:
                if a is b or a[0]["cluster"] != b[0]["cluster"]:
                    continue
                overlap = float((a[5] & b[5]).sum()) / max(1.0, float(min(a[5].sum(), b[5].sum())))
                if overlap > 0.8:
                    kept.remove(a if a[0]["gain"] < b[0]["gain"] else b)
                    changed = True
                    break
            if changed:
                break
    return kept


def _fill_holes(mask: np.ndarray, max_hole: float) -> np.ndarray:
    """Fill enclosed holes up to ``max_hole`` px: glare and foil sheen inside a sticker."""
    inverse = (~mask).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(inverse, 4)
    filled = mask.copy()
    height, width = mask.shape
    for index in range(1, count):
        x, y, w, h, area = stats[index]
        touches_edge = x == 0 or y == 0 or x + w == width or y + h == height
        if not touches_edge and area <= max_hole:
            filled[labels == index] = True
    return filled


def _robust_colour(lab: np.ndarray, own: np.ndarray) -> tuple[list[float], float, int]:
    """Median Lab of a sticker's own pixels, ignoring glare, pen marks and edges."""
    inner = cv2.erode(own.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    if inner.sum() < 30:
        inner = own
    pixels = lab[inner].astype(np.float32)
    if len(pixels) == 0:
        return [0.0, 128.0, 128.0], 0.0, 0
    chroma = np.hypot(pixels[:, 1] - 128.0, pixels[:, 2] - 128.0)
    pixels = pixels[~((pixels[:, 0] > 232) & (chroma < 12))] if len(pixels) > 60 else pixels
    median = np.median(pixels, axis=0)
    distance = np.linalg.norm((pixels - median) * [0.5, 1.0, 1.0], axis=1)
    cutoff = max(6.0, 2.5 * float(np.median(distance)))
    core = pixels[distance <= cutoff]
    median = np.median(core, axis=0) if len(core) else median
    return [float(v) for v in median], float(np.median(distance)), int(len(core))
