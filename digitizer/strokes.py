"""Drawn routes: from added ink to georeferenced polylines, thin pens included.

1. Ink = the added-ink score, with hysteresis (faint pixels count when they
   connect to clear ones) plus a multi-scale ridge filter: a 0.5 mm ballpoint
   line is barely above the noise pixel by pixel, but it is *long and thin*,
   and a ridge detector sees exactly that. Stickers are masked out.
2. Skeleton -> graph. Junction pixels are grouped into nodes; short spurs (the
   whiskers a thick felt-tip corner grows) are pruned and node degrees
   recomputed, so a corner that sprouted a whisker is an ordinary bend again.
3. Each chain gets a pen colour from its *core* pixels (the strongest ink along
   it; a thin line's edges are mostly paper), matched against the session's pen
   examples -- so a blue pen that photographs neutral grey is just an example.
   A faint line whose colour matches no pen is matched by the *direction* its
   ink moves the paper's colour in (``classify_pen``).
4. Chains are merged where exactly two meet, paired by straightness at real
   junctions (a red and a blue route crossing stay apart), then bridged across
   gaps: under a sticker or over dark print, between dashes, where the pen
   skipped. A gap is only bridged between two substantial pieces whose ends
   point at each other.
5. Long enough -> route. Ink lying almost entirely on printed features is
   flagged as a probable print mismatch rather than a drawing.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import asdict, dataclass, field

import cv2
import numpy as np

from .palette import Palette


@dataclass
class Route:
    id: int
    pen: str | None
    points: list[list[float]]          # rectified-map pixels, simplified
    length_px: float                   # along the simplified line, bridged stretches included
    width_px: float
    colour_lab: list[float]
    pen_confidence: float = 0.0
    pen_alternatives: list = field(default_factory=list)
    kind: str = "route"                # route | mark
    bridged_gaps: int = 0
    printed_share: float = 0.0         # share of its length lying on printed features
    flags: list[str] = field(default_factory=list)
    source: str = "auto"

    def to_dict(self) -> dict:
        data = asdict(self)
        data["points"] = [[round(float(x), 1), round(float(y), 1)] for x, y in self.points]
        data["colour_lab"] = [round(float(v), 1) for v in self.colour_lab]
        for key in ("length_px", "width_px", "pen_confidence", "printed_share"):
            data[key] = round(float(data[key]), 3)
        return data


# ------------------------------------------------------------------- ink mask

def ridge_strength(image: np.ndarray, sigmas: list[float]) -> np.ndarray:
    """Scale-normalised bright-ridge strength (largest negative Hessian eigenvalue)."""
    best = np.zeros(image.shape, np.float32)
    for sigma in sigmas:
        smooth = cv2.GaussianBlur(image, (0, 0), sigma)
        dxx = cv2.Sobel(smooth, cv2.CV_32F, 2, 0, ksize=3)
        dyy = cv2.Sobel(smooth, cv2.CV_32F, 0, 2, ksize=3)
        dxy = cv2.Sobel(smooth, cv2.CV_32F, 1, 1, ksize=3)
        root = np.sqrt((dxx - dyy) ** 2 + 4.0 * dxy * dxy)
        lowest = 0.5 * (dxx + dyy - root)
        np.maximum(best, sigma * sigma * np.maximum(0.0, -lowest), out=best)
    return best


def _hysteresis(weak: np.ndarray, strong: np.ndarray) -> np.ndarray:
    count, labels = cv2.connectedComponents(weak.astype(np.uint8), connectivity=8)
    keep = np.zeros(count, bool)
    keep[np.unique(labels[strong & weak])] = True
    keep[0] = False
    return keep[labels]


def ink_mask(score: np.ndarray, valid: np.ndarray, sticker_cover: np.ndarray, px_per_mm: float,
             strong: float = 16.0, weak: float = 8.0) -> tuple[np.ndarray, dict]:
    """Pixels that belong to drawn lines (not stickers)."""
    score_f = score.astype(np.float32)
    ink = _hysteresis(score_f >= weak, score_f >= strong)

    # thin-line channel: ridges of the score map, thresholded relative to the
    # ridge noise measured on this sheet's blank paper
    sigmas = [s * px_per_mm for s in (0.12, 0.2, 0.32)]
    ridge = ridge_strength(score_f, sigmas)
    paper = (score_f < 4) & (valid > 0)
    noise = float(np.percentile(ridge[paper], 99.5)) if paper.any() else 1.0
    ridges = _hysteresis(ridge >= 2.0 * noise, ridge >= 4.0 * noise) & (score_f >= 5)
    info = {"ridgeNoise": round(noise, 3), "ridgePixels": int(ridges.sum()), "hysteresisPixels": int(ink.sum())}
    mask = (ink | ridges) & (valid > 0)

    # leave the stickers out (slightly grown, their rims blur into the paper)
    grow = max(1, int(round(0.3 * px_per_mm)))
    stickers = cv2.dilate((sticker_cover > 0).astype(np.uint8), np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)) > 0
    mask &= ~stickers
    # close pinholes along a stroke without merging neighbouring strokes
    mask = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    small = np.flatnonzero(stats[1:, cv2.CC_STAT_AREA] < max(12, int(1.2 * px_per_mm * px_per_mm))) + 1
    mask[np.isin(labels, small)] = False
    return mask, info


# --------------------------------------------------------------- skeleton graph

_NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def _skeleton(mask: np.ndarray) -> np.ndarray:
    binary = mask.astype(np.uint8) * 255
    try:
        return cv2.ximgproc.thinning(binary, thinningType=cv2.ximgproc.THINNING_GUOHALL) > 0
    except AttributeError:  # opencv without contrib
        from skimage.morphology import skeletonize
        return skeletonize(mask)


@dataclass
class _Chain:
    points: np.ndarray                 # (n, 2) as x, y; points[0] at node a, points[-1] at node b
    a: int
    b: int
    lab: np.ndarray | None = None      # core colour
    bg: np.ndarray | None = None       # the clean print's colour under it
    trust: float = 0.0                 # how much that colour counts when chains merge
    width: float = 1.0
    pen: str | None = None
    inked: float = 0.0                 # inked length (excludes bridged gaps)
    gaps: int = 0
    alive: bool = True


def _skeleton_graph(skeleton: np.ndarray) -> list[_Chain]:
    """Pixel chains between nodes (end points and junction clusters)."""
    sk = skeleton.astype(np.uint8)
    kernel = np.ones((3, 3), np.float32)
    kernel[1, 1] = 0
    neighbour_count = cv2.filter2D(sk, cv2.CV_16S, kernel, borderType=cv2.BORDER_CONSTANT)
    is_node = (sk > 0) & (neighbour_count != 2)
    _, node_label = cv2.connectedComponents(is_node.astype(np.uint8), connectivity=8)
    next_node = int(node_label.max()) + 1
    height, width = sk.shape
    visited = np.zeros(sk.shape, bool)

    def around(y: int, x: int):
        for dy, dx in _NEIGHBOURS:
            yy, xx = y + dy, x + dx
            if 0 <= yy < height and 0 <= xx < width and sk[yy, xx]:
                yield yy, xx

    chains: list[_Chain] = []
    for y, x in np.argwhere(is_node):
        a = int(node_label[y, x])
        for yy, xx in around(y, x):
            if is_node[yy, xx] or visited[yy, xx]:
                continue
            path = [(x, y), (xx, yy)]
            visited[yy, xx] = True
            previous, current = (y, x), (yy, xx)
            end = None
            while True:
                options = [q for q in around(*current) if q != previous]
                nodes = [q for q in options if is_node[q] and (node_label[q] != a or len(path) > 3)]
                if nodes:
                    path.append((nodes[0][1], nodes[0][0]))
                    end = int(node_label[nodes[0]])
                    break
                free = [q for q in options if not is_node[q] and not visited[q]]
                if not free:
                    break
                step = free[0]
                visited[step] = True
                path.append((step[1], step[0]))
                previous, current = current, step
            if end is None:
                end, next_node = next_node, next_node + 1
            chains.append(_Chain(points=np.asarray(path, np.float64), a=a, b=end))
    # closed loops that touch no node (a circle drawn around a place)
    for y, x in np.argwhere((sk > 0) & ~is_node & ~visited):
        if visited[y, x]:
            continue
        path, current, previous = [(x, y)], (y, x), None
        visited[y, x] = True
        while True:
            free = [q for q in around(*current) if q != previous and not visited[q]]
            if not free:
                break
            previous, current = current, free[0]
            visited[current] = True
            path.append((current[1], current[0]))
        if len(path) > 3:
            node = next_node
            next_node += 1
            path.append(path[0])
            chains.append(_Chain(points=np.asarray(path, np.float64), a=node, b=node))
    return chains


def _length(points: np.ndarray) -> float:
    return float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum()) if len(points) > 1 else 0.0


def _outward(points: np.ndarray, at_start: bool, reach: float) -> np.ndarray:
    """Unit vector pointing *out of* the chain at one end (away from its body).

    A line fitted to the stretch between a fifth of ``reach`` and ``reach``
    behind the end: skeleton ends hook sideways over their last pixels, and
    the hook alone would point the end the wrong way.
    """
    seq = points if at_start else points[::-1]
    distance = np.cumsum(np.r_[0.0, np.linalg.norm(np.diff(seq, axis=0), axis=1)])
    window = seq[(distance >= 0.2 * reach) & (distance <= reach)]
    if len(window) < 3:
        index = min(max(int(np.searchsorted(distance, reach)), 1), len(seq) - 1)
        vector = seq[0] - seq[index]
    else:
        centred = window - window.mean(axis=0)
        axis = np.linalg.svd(centred, full_matrices=False)[2][0]
        vector = axis if np.dot(axis, window[0] - window[-1]) >= 0 else -axis
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 0 else np.zeros(2)


def _simplify(points: np.ndarray, epsilon: float) -> np.ndarray:
    if len(points) < 3:
        return points
    return cv2.approxPolyDP(points.astype(np.float32).reshape(-1, 1, 2), epsilon, False).reshape(-1, 2).astype(np.float64)


def _core_colour(points: np.ndarray, lab: np.ndarray, score: np.ndarray, radius: int) -> np.ndarray:
    """Median Lab of the strongest ink around the chain (its core)."""
    h, w = score.shape
    samples = []
    for x, y in points[:: max(1, len(points) // 60)]:
        xi, yi = int(round(x)), int(round(y))
        x0, x1 = max(0, xi - radius), min(w, xi + radius + 1)
        y0, y1 = max(0, yi - radius), min(h, yi + radius + 1)
        patch = score[y0:y1, x0:x1]
        if patch.size == 0:
            continue
        k = int(np.argmax(patch))
        py, px = divmod(k, patch.shape[1])
        samples.append(lab[y0 + py, x0 + px])
    if not samples:
        return np.asarray([0.0, 128.0, 128.0])
    return np.median(np.asarray(samples, np.float64), axis=0)


def _pens_compatible(p: str | None, q: str | None) -> bool:
    return p is None or q is None or p == q


PAPER_LAB = np.asarray([245.0, 128.0, 128.0])


def classify_pen(lab: np.ndarray, background: np.ndarray | None, pens: Palette) -> dict:
    """Which pen drew a line: by its colour, or failing that by its colour *change*.

    A thin or lightly pressed line is mostly paper at its core, so its colour
    matches no pen's example (a 0.3 mm red ballpoint measured pale pink). But
    ink over paper moves the colour along the line from the paper to the pen:
    the direction of that move is the pen's even when its length is small.
    A neutral pen (the navy pen photographs grey) must darken the paper by at
    least half its full strength, because faint grey is what misprinted street
    edges look like too.
    """
    assignment = pens.classify([lab.tolist()], adapt=False)[0][0]
    result = {"pen": assignment.colour, "confidence": assignment.confidence,
              "alternatives": assignment.alternatives, "flags": list(assignment.flags), "method": "colour"}
    if assignment.colour is not None and assignment.distance <= 20.0:
        return result
    if background is None:
        return result
    weights = np.asarray([0.5, 1.0, 1.0])
    change = (lab - background) * weights
    change_norm = float(np.linalg.norm(change))
    if change_norm < 8.0:
        return result
    best = None
    for colour in pens.classes:
        for example in colour.examples:
            full = (np.asarray(example) - PAPER_LAB) * weights
            full_norm = float(np.linalg.norm(full))
            if full_norm < 1e-6:
                continue
            cosine = float(np.dot(change, full)) / (change_norm * full_norm)
            strength = float(np.dot(change, full)) / (full_norm * full_norm)
            chroma = float(np.hypot(example[1] - 128.0, example[2] - 128.0))
            minimum = 0.5 if chroma < 10.0 else 0.2
            if cosine >= 0.93 and minimum <= strength <= 1.4 and (best is None or cosine > best[0]):
                best = (cosine, colour.id, strength)
    if best is not None:
        result.update({"pen": best[1], "confidence": round(best[0], 3), "method": "colour-change",
                       "flags": [f for f in result["flags"] if not f.startswith("colour-")] + ["faint"]})
    return result


class _Graph:
    """Chains plus node adjacency, with the merge operations routes need."""

    def __init__(self, chains: list[_Chain]):
        self.chains = chains
        self.ends: dict[int, set[tuple[int, int]]] = defaultdict(set)   # node -> {(chain, 0|1)}
        for index, chain in enumerate(chains):
            self._attach(index)

    def _attach(self, index: int) -> None:
        chain = self.chains[index]
        self.ends[chain.a].add((index, 0))
        self.ends[chain.b].add((index, 1))

    def _detach(self, index: int) -> None:
        chain = self.chains[index]
        self.ends[chain.a].discard((index, 0))
        self.ends[chain.b].discard((index, 1))

    def degree(self, node: int) -> int:
        return len(self.ends[node])

    def kill(self, index: int) -> None:
        self._detach(index)
        self.chains[index].alive = False

    def merge(self, i: int, end_i: int, j: int, end_j: int, gap: bool = False) -> int:
        """Join chain i's end ``end_i`` to chain j's end ``end_j``; returns the new chain."""
        ci, cj = self.chains[i], self.chains[j]
        first = ci.points if end_i == 1 else ci.points[::-1]          # runs *into* the joint
        second = cj.points if end_j == 0 else cj.points[::-1]         # runs *out of* it
        points = np.vstack([first, second[1:] if not gap else second])
        start_node = ci.a if end_i == 1 else ci.b
        end_node = cj.b if end_j == 0 else cj.a
        total = max(1e-6, ci.inked + cj.inked)
        lab = ci.lab if cj.lab is None else cj.lab if ci.lab is None else (
            (ci.lab * ci.trust + cj.lab * cj.trust) / max(1e-6, ci.trust + cj.trust))
        bg = ci.bg if cj.bg is None else cj.bg if ci.bg is None else (
            (ci.bg * ci.trust + cj.bg * cj.trust) / max(1e-6, ci.trust + cj.trust))
        merged = _Chain(
            points=points, a=start_node, b=end_node, lab=lab, bg=bg,
            trust=ci.trust + cj.trust, width=(ci.width * ci.inked + cj.width * cj.inked) / total,
            pen=ci.pen if ci.pen is not None else cj.pen, inked=ci.inked + cj.inked,
            gaps=ci.gaps + cj.gaps + (1 if gap else 0),
        )
        self.kill(i)
        self.kill(j)
        self.chains.append(merged)
        self._attach(len(self.chains) - 1)
        return len(self.chains) - 1

    def alive(self) -> list[int]:
        return [i for i, c in enumerate(self.chains) if c.alive]


def _assemble(graph: _Graph, px_per_mm: float, hiders: np.ndarray, sticker_diameter_px: float) -> None:
    reach = 2.5 * px_per_mm

    # 1. prune whiskers, recomputing degrees as we go
    changed = True
    while changed:
        changed = False
        for index in graph.alive():
            chain = graph.chains[index]
            if chain.a == chain.b:
                continue
            da, db = graph.degree(chain.a), graph.degree(chain.b)
            spur = max(2.0 * chain.width, 1.2 * px_per_mm)
            if ((da == 1 and db >= 3) or (db == 1 and da >= 3)) and chain.inked < spur:
                graph.kill(index)
                changed = True
            elif da == 1 and db == 1 and chain.inked < 1.5 * px_per_mm:
                graph.kill(index)
                changed = True

    # 2. where exactly two chains meet, they are one line (any angle: a corner)
    changed = True
    while changed:
        changed = False
        for node in list(graph.ends):
            attached = list(graph.ends[node])
            if len(attached) != 2:
                continue
            (i, end_i), (j, end_j) = attached
            if i == j or not _pens_compatible(graph.chains[i].pen, graph.chains[j].pen):
                continue
            graph.merge(i, end_i, j, end_j)
            changed = True

    # 3. at real junctions, continue the straightest pairs of the same pen.
    # _outward at the node end is the direction of travel arriving there, so a
    # straight continuation has the two outward vectors opposed.
    for node in list(graph.ends):
        while len(graph.ends[node]) >= 3:
            attached = list(graph.ends[node])
            best = None
            for x in range(len(attached)):
                for y in range(x + 1, len(attached)):
                    (i, ei), (j, ej) = attached[x], attached[y]
                    if i == j or not _pens_compatible(graph.chains[i].pen, graph.chains[j].pen):
                        continue
                    straight = -float(np.dot(_outward(graph.chains[i].points, ei == 0, reach),
                                             _outward(graph.chains[j].points, ej == 0, reach)))
                    if straight > math.cos(math.radians(60)) and (best is None or straight > best[0]):
                        best = (straight, i, ei, j, ej)
            if best is None:
                break
            _, i, ei, j, ej = best
            graph.merge(i, ei, j, ej)   # passes through; other branches keep the node

    # 4. bridge gaps between free ends of substantial pieces, until none is left
    while _bridge_once(graph, reach, px_per_mm, hiders, sticker_diameter_px):
        pass


def _bridge_once(graph: _Graph, reach: float, px_per_mm: float, hiders: np.ndarray,
                 sticker_diameter_px: float) -> bool:
    """Make the best non-conflicting gap joins; True if anything was joined.

    An end counts as free when nothing substantial continues from it: a route
    crossing a printed metro roundel often ends in a tuft of the roundel's
    misprint ghost, which must not pin it down.
    """
    substantial = 2.5 * px_per_mm

    def effective_degree(node: int) -> int:
        return sum(1 for i, _ in graph.ends[node] if graph.chains[i].inked >= substantial)

    free = []
    for index in graph.alive():
        chain = graph.chains[index]
        if chain.a == chain.b or chain.inked < substantial:
            continue
        for end, node in ((0, chain.a), (1, chain.b)):
            if effective_degree(node) == 1:
                free.append((index, end))
    candidates = []
    # A line's last millimetres before a sticker often curl along its rim, so
    # judge where an end points over a longer stretch than at junctions.
    reach = 1.6 * reach
    for x in range(len(free)):
        i, ei = free[x]
        ci = graph.chains[i]
        pi = ci.points[0] if ei == 0 else ci.points[-1]
        di = _outward(ci.points, ei == 0, reach)
        for y in range(x + 1, len(free)):
            j, ej = free[y]
            if i == j:
                continue
            cj = graph.chains[j]
            if not _pens_compatible(ci.pen, cj.pen):
                continue
            pj = cj.points[0] if ej == 0 else cj.points[-1]
            gap = pj - pi
            distance = float(np.linalg.norm(gap))
            # a route may vanish under a row of stickers, but not for ever
            if distance < 1.0 or distance > 5.0 * sticker_diameter_px:
                continue
            dj = _outward(cj.points, ej == 0, reach)
            # Two ends side by side, pointing at each other along one line: the
            # skeleton wandered where the line crossed something dark (a metro
            # roundel) and overshot. The gap vector is sideways, so the test
            # below would refuse it; the directions settle it instead.
            if distance <= 4.0 * px_per_mm and -float(np.dot(di, dj)) > math.cos(math.radians(30)):
                candidates.append((distance, i, ei, j, ej))
                continue
            # a long jump needs both sides to be trusted ink of one pen, not a
            # colourless scrap (misprint ghosts are colourless)
            if distance > 3.0 * px_per_mm and (ci.pen is None or cj.pen is None):
                continue
            direction = gap / distance
            align_i, align_j = float(np.dot(di, direction)), float(np.dot(dj, -direction))
            # what counts is the stretch nothing explains: a gap hidden under
            # stickers is believable at any length, open paper only briefly
            uncovered = _uncovered_length(pi, pj, hiders)
            if uncovered > 6.0 * px_per_mm:
                continue
            # the route may turn where a sticker hides it; on open paper the
            # two ends must point at each other
            hidden = uncovered < 0.5 * distance
            if min(align_i, align_j) < math.cos(math.radians(65 if hidden else 38)):
                continue
            candidates.append((distance * (2.2 - align_i - align_j), i, ei, j, ej))
    candidates.sort()
    joined = False
    for _, i, ei, j, ej in candidates:
        if not (graph.chains[i].alive and graph.chains[j].alive):
            continue   # already joined this round; the next round sees the new line
        graph.merge(i, ei, j, ej, gap=True)
        joined = True
    return joined


def _uncovered_length(a: np.ndarray, b: np.ndarray, hiders: np.ndarray) -> float:
    """Length (px) of the straight gap between two ends that nothing hides.

    ``hiders`` marks what can hide a line: stickers, and dark print.
    """
    length = float(np.linalg.norm(b - a))
    steps = max(2, int(length))
    xs = np.clip(np.linspace(a[0], b[0], steps).round().astype(int), 0, hiders.shape[1] - 1)
    ys = np.clip(np.linspace(a[1], b[1], steps).round().astype(int), 0, hiders.shape[0] - 1)
    return length * float(np.mean(hiders[ys, xs] == 0))


def _printed_features(clean: np.ndarray, px_per_mm: float) -> np.ndarray:
    """Where the clean print carries dark detail (labels, icons, outlines)."""
    gray = cv2.cvtColor(clean, cv2.COLOR_BGR2GRAY)
    paper = float(np.percentile(gray, 60))
    printed = (gray < paper - 45).astype(np.uint8)
    grow = max(1, int(round(0.6 * px_per_mm)))
    return cv2.dilate(printed, np.ones((2 * grow + 1, 2 * grow + 1), np.uint8)) > 0


def extract_routes(images, sticker_cover: np.ndarray, pens: Palette, px_per_mm: float,
                   sticker_diameter_px: float, min_route_mm: float = 25.0) -> tuple[list[Route], np.ndarray, dict]:
    """All drawn lines on the map square. Returns routes (and marks), the ink mask, and info."""
    mask, info = ink_mask(images.score, images.valid, sticker_cover, px_per_mm)
    chains = _skeleton_graph(_skeleton(mask))
    distance = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 3)
    lab = cv2.cvtColor(images.corrected, cv2.COLOR_BGR2LAB).astype(np.float32)
    score = images.score.astype(np.float32)

    printed = _printed_features(images.clean, px_per_mm)
    clean_lab = cv2.cvtColor(images.clean, cv2.COLOR_BGR2LAB).astype(np.float32)
    on_print = []
    for chain in chains:
        xs = np.clip(chain.points[:, 0].astype(int), 0, mask.shape[1] - 1)
        ys = np.clip(chain.points[:, 1].astype(int), 0, mask.shape[0] - 1)
        chain.width = max(1.0, float(np.median(distance[ys, xs])) * 2.0)
        chain.inked = _length(chain.points)
        chain.lab = _core_colour(chain.points, lab, score, max(1, int(round(chain.width / 2))))
        chain.bg = np.median(clean_lab[ys, xs], axis=0).astype(np.float64)
        on_print.append(float(np.mean(printed[ys, xs])))
    for chain, share in zip(chains, on_print):
        # Only a stretch long enough, and mostly on bare paper, votes on the
        # pen: red ink crossing a dark-blue metro roundel measures blue.
        trustworthy = chain.inked >= 4.0 * px_per_mm and share < 0.5
        chain.pen = classify_pen(chain.lab, chain.bg, pens)["pen"] if trustworthy else None
        chain.trust = chain.inked * (1.0 if trustworthy else 0.02)
    # Short pieces lying on print are the misprint rings of icons and labels.
    # Left in, one touching a route's end is merged into it (a line ending by a
    # bus icon grew the icon's ring). A route that really crosses an icon is
    # rejoined by gap bridging, which treats dark print as hiding ink.
    is_ghost = [c.inked < 6.0 * px_per_mm and share >= 0.7 for c, share in zip(chains, on_print)]
    chains = [c for c, ghost in zip(chains, is_ghost) if not ghost]
    info["iconGhosts"] = int(sum(is_ghost))

    graph = _Graph(chains)
    # dark print hides ink as a sticker does: a line crossing a metro roundel
    # vanishes over it just as it does under a sticker
    hiders = ((sticker_cover > 0) | printed).astype(np.int32)
    _assemble(graph, px_per_mm, hiders, sticker_diameter_px)
    routes: list[Route] = []
    for index in graph.alive():
        chain = graph.chains[index]
        if chain.inked < 2.0 * px_per_mm:
            continue
        pen = classify_pen(chain.lab, chain.bg, pens)
        xs = np.clip(chain.points[:, 0].astype(int), 0, mask.shape[1] - 1)
        ys = np.clip(chain.points[:, 1].astype(int), 0, mask.shape[0] - 1)
        printed_share = float(np.mean(printed[ys, xs]))
        flags = list(pen["flags"])
        kind = "route" if chain.inked >= min_route_mm * px_per_mm else "mark"
        if printed_share > 0.6 and chain.inked < 3 * min_route_mm * px_per_mm:
            # a drawing crosses the print; a misprint ghost sits on it
            kind = "mark"
            flags.append("on-print")
        # Length along the simplified line: the raw pixel skeleton's staircase
        # overstates it by 5-15%. Bridged stretches count -- the route ran
        # there, under a sticker. (Route-or-mark was decided on inked length.)
        simplified = _simplify(chain.points, 0.35 * px_per_mm)
        routes.append(Route(
            id=len(routes) + 1, pen=pen["pen"], points=simplified.tolist(),
            length_px=_length(simplified), width_px=chain.width, colour_lab=chain.lab.tolist(),
            pen_confidence=pen["confidence"], pen_alternatives=pen["alternatives"],
            kind=kind, bridged_gaps=chain.gaps, printed_share=printed_share, flags=flags,
        ))
    _promote_branches(routes, px_per_mm)
    # A mark worth a reviewer's look is trusted ink of a known pen on bare
    # paper; the rest (misprint ghosts, crumbs) only goes into the counts.
    # A faint line is only believed when it is long: short faint fragments are
    # the misprint ghosts of grey street edges (the colour-change rule would
    # otherwise rescue them as "blue pen").
    dropped = [r for r in routes if (r.kind == "mark" and (
        r.pen is None or "on-print" in r.flags or r.length_px < 5.0 * px_per_mm or "faint" in r.flags
        or (r.pen_alternatives and r.pen_alternatives[0]["distance"] > 20.0)))
        # a pale grey line matching no pen, even by its colour change, is a
        # street edge's misprint ghost (measured L 170-190; the navy pen's core
        # measures L ~97)
        or (r.pen is None and r.colour_lab[0] > 165.0)]
    routes = [r for r in routes if r not in dropped]
    routes.sort(key=lambda r: (r.kind != "route", -r.length_px))
    for number, route in enumerate(routes, start=1):
        route.id = number
    info.update({"chains": len(chains), "routes": sum(r.kind == "route" for r in routes),
                 "marks": sum(r.kind == "mark" for r in routes), "droppedFragments": len(dropped)})
    return routes, mask, info


def _distance_to_polyline(point: np.ndarray, polyline: np.ndarray) -> float:
    """Distance from a point to the nearest *segment* of a polyline."""
    if len(polyline) == 1:
        return float(np.linalg.norm(point - polyline[0]))
    starts, ends = polyline[:-1], polyline[1:]
    segment = ends - starts
    length2 = np.maximum((segment * segment).sum(axis=1), 1e-9)
    t = np.clip(((point - starts) * segment).sum(axis=1) / length2, 0.0, 1.0)
    nearest = starts + segment * t[:, None]
    return float(np.min(np.linalg.norm(nearest - point, axis=1)))


def _promote_branches(routes: list[Route], px_per_mm: float) -> None:
    """A short line starting on a route, in its pen, is a branch of it, not a mark."""
    changed = True
    while changed:
        changed = False
        anchors = [np.asarray(r.points) for r in routes if r.kind == "route"]
        pens = [r.pen for r in routes if r.kind == "route"]
        for mark in routes:
            if mark.kind != "mark" or mark.length_px < 5.0 * px_per_mm or "on-print" in mark.flags:
                continue
            if "faint" not in mark.flags and (not mark.pen_alternatives
                                              or mark.pen_alternatives[0]["distance"] > 20.0):
                continue   # a sticker rim's shadow touches routes too; it is not ink
            ends = np.asarray([mark.points[0], mark.points[-1]])
            for anchor, pen in zip(anchors, pens):
                if not _pens_compatible(mark.pen, pen):
                    continue
                if min(_distance_to_polyline(end, anchor) for end in ends) <= 2.0 * px_per_mm:
                    mark.kind = "route"
                    mark.flags.append("branch")
                    changed = True
                    break
