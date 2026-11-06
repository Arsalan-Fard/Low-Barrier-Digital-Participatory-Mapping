"""Pen drawings on a map view sheet, from camera frames. The sheet's inside is straightened from its
border tags and compared with the same page's reference: the blank sheet with the page's map
projected on it (paper_watch.py takes both, with no hand over the sheet). The projection is in both
and cancels out, so what is left is the ink drawn since. That is traced into lines and points (a
dot, an X or a small circle) and placed on the map by the view the sheet was showing."""
import math

import cv2
import numpy as np

PX_PER_MM = 4.0           # resolution of the straightened inside
EDGE_MARGIN_MM = 3.0      # the inside's rim is skipped: a small registration error shows the border there
CELL_MARGIN_MM = 2.0      # and so is a band round each tag cell standing into the inside
BACKGROUND_MM = 6.0       # wider than any pen line: the paper's own shade is measured over this
MAX_LINE_MM = 8.0         # anything thicker is a hand, a shadow or an object, not a pen line
MIN_BLOB_MM2 = 2.0        # specks smaller than this are noise
MIN_STROKE_MM = 2.5       # traced pieces shorter than this are thinning spurs
SIMPLIFY_MM = 0.4
# Ink against the paper: darkness is 1 - lightness relative to the paper, chroma is Lab a/b distance.
DARK_STRONG, DARK_WEAK = 0.30, 0.15
CHROMA_STRONG, CHROMA_WEAK = 30.0, 16.0
# The projection follows the sheet with a small error, so the reference is first aligned to the frame
# (affine, ECC on a blurred copy at ALIGN_PX_PER_MM) and then each pixel is compared with the darkest
# reference pixel within SHIFT_TOLERANCE_MM: a projected label a little off is not taken for ink.
ALIGN_PX_PER_MM = 2.0
MAX_ALIGN_SHIFT_MM = 6.0
SHIFT_TOLERANCE_MM = 0.75
# Something lying on the sheet: changed against the reference (darker, lighter or another colour),
# thicker than a pen line and larger than OCCLUDER_MM2 -- an arm, a phone, a cup. A pen is smaller.
OCCLUDER_CHANGE = 0.25    # |log| of the brightness ratio counted as changed
OCCLUDER_MM2 = 2500.0
# Points: a place marked with a small circle, a dot or an X, on its own or on a line (a route with
# its start circled). Told by shape, up to POINT_MAX_MM across; anything else is a line, however
# small: a dash, a tick, an arrow, a large ring round an area.
#  * circle / dot: what the ink encloses is filled in (gaps up to CLOSE_GAP_MM closed first) and
#    everything thinner than BODY_MM opened away, which leaves the discs: round (ROUNDNESS) and
#    full (SOLIDITY) ones are points, a circle when most of the disc was enclosed paper.
#    A dot is solid: thinned, it leaves a short stub (DOT_SKELETON of its size at most), where a
#    small arrow head, which the camera sees filled in, leaves its two strokes. A dot on a line has
#    the line going in and out of it; more lines leaving (MAX_DOT_LINES) make a crossing or junction.
#  * dot: also any mark no larger than DOT_MAX_MM.
#  * X: four short arms (SPUR_MM to ARM_MAX_MM, ending free, none much shorter than the longest:
#    ARM_BALANCE) meeting at one crossing and pointing all ways (no gap between them wider than
#    MAX_ARM_GAP_DEG); a line may run through it. A small arrow head, filled in by the camera's blur,
#    thins to three: its two strokes and a stub at the tip.
POINT_MAX_MM = 30.0
DOT_MAX_MM = 4.0
CLOSE_GAP_MM = 1.5
BODY_MM = 2.5             # wider than a pen line
ROUNDNESS = 0.5           # a disc's short side over its long side
SOLIDITY = 0.75           # a disc's area over its convex hull's
CIRCLE_HOLE_SHARE = 0.3   # enclosed paper, as a share of the disc, that makes it a circle
SPUR_MM = 1.5             # skeleton branches shorter than this are thinning noise, not arms
ARM_MAX_MM = 20.0
CROSSING_MM = 3.0         # junctions this close together are one crossing (a hand-drawn X has two)
MIN_X_ARMS = 4
ARM_BALANCE = 0.3
MAX_ARM_GAP_DEG = 200.0
MAX_DOT_LINES = 2
DOT_SKELETON = 1.0
OWNED_SHARE = 0.7         # a traced piece mostly inside a point's disc is part of the mark, not a line


def sheet_homography(layout, found):
    """(homography from sheet mm to frame px or None, ids of the sheet's tags seen). found maps a tag
    id to its four corners in frame px, as OpenCV reports them."""
    src, dst, seen = [], [], []
    for tag in layout["tags"]:
        corners = found.get(tag["id"])
        if corners is None:
            continue
        seen.append(tag["id"])
        src.extend(tag["corners"])
        dst.extend(np.asarray(corners, np.float32).reshape(4, 2).tolist())
    if len(seen) < 2:
        return None, seen
    # RANSAC drops a tag read in the wrong place; 3 px is far beyond a good corner's error.
    homography, _ = cv2.findHomography(np.float32(src), np.float32(dst), cv2.RANSAC, 3.0)
    return homography, seen


def sheet_quad(homography, layout, margin_mm=0.0):
    """The page's outline grown by margin_mm, in frame px: 4 x 2 float32."""
    width, height = layout["pageMm"]
    m = float(margin_mm)
    corners = np.float32([[-m, -m], [width + m, -m], [width + m, height + m], [-m, height + m]])
    return cv2.perspectiveTransform(corners.reshape(-1, 1, 2), homography).reshape(4, 2)


def straighten(frame, homography, layout, px_per_mm=PX_PER_MM):
    """The sheet's inside as a top-down image, px_per_mm pixels per millimetre."""
    x0, y0, x1, y1 = layout["interiorMm"]
    width = int(round((x1 - x0) * px_per_mm))
    height = int(round((y1 - y0) * px_per_mm))
    to_mm = np.array([[1.0 / px_per_mm, 0, x0], [0, 1.0 / px_per_mm, y0], [0, 0, 1]])
    return cv2.warpPerspective(frame, homography @ to_mm, (width, height),
                               flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)


def valid_mask(layout, shape, px_per_mm=PX_PER_MM, discs=()):
    """Where ink is looked for: the inside less its rim, the tag cells standing into it and the discs
    given ((x_mm, y_mm, r_mm) from the inside's top-left: the street view cone)."""
    height, width = shape[:2]
    x0, y0 = layout["interiorMm"][:2]
    mask = np.zeros((height, width), np.uint8)
    rim = int(round(EDGE_MARGIN_MM * px_per_mm))
    mask[rim:height - rim, rim:width - rim] = 1
    half = layout["cellMm"] / 2.0 + CELL_MARGIN_MM
    for tag in layout["tags"]:
        left = int(math.floor((tag["cx"] - half - x0) * px_per_mm))
        top = int(math.floor((tag["cy"] - half - y0) * px_per_mm))
        right = int(math.ceil((tag["cx"] + half - x0) * px_per_mm))
        bottom = int(math.ceil((tag["cy"] + half - y0) * px_per_mm))
        mask[max(0, top):max(0, bottom), max(0, left):max(0, right)] = 0
    for x, y, r in discs:
        cv2.circle(mask, (int(round(x * px_per_mm)), int(round(y * px_per_mm))), int(round(r * px_per_mm)), 0, -1)
    return mask.astype(bool)


def _odd(n):
    n = max(3, int(round(n)))
    return n if n % 2 else n + 1


def _disc(radius_px):
    size = 2 * max(1, int(round(radius_px))) + 1
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))


def _gray(image):
    return cv2.cvtColor(image.astype(np.float32), cv2.COLOR_BGR2GRAY)


def align_reference(reference, current, valid, px_per_mm=PX_PER_MM):
    """The reference moved onto the current image: the affine map ECC finds between blurred small
    copies, or the reference as it is when ECC fails or finds something implausible."""
    scale = ALIGN_PX_PER_MM / px_per_mm

    def small(image):
        shrunk = cv2.resize(_gray(image), None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        return cv2.GaussianBlur(shrunk, (0, 0), 1.0)

    template, moving = small(current), small(reference)
    mask = cv2.resize(valid.astype(np.uint8), (template.shape[1], template.shape[0]), interpolation=cv2.INTER_NEAREST)
    warp = np.eye(2, 3, dtype=np.float32)
    try:
        criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-5)
        _, warp = cv2.findTransformECC(template, moving, warp, cv2.MOTION_AFFINE, criteria, mask, 5)
    except cv2.error:
        return reference
    warp[:, 2] /= scale
    if np.abs(warp[:, :2] - np.eye(2)).max() > 0.02 or np.abs(warp[:, 2]).max() > MAX_ALIGN_SHIFT_MM * px_per_mm:
        return reference
    height, width = current.shape[:2]
    return cv2.warpAffine(reference, warp, (width, height), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                          borderMode=cv2.BORDER_REPLICATE)


def _flatten(ratio, valid, px_per_mm):
    """The ratio divided by its own local level, so unchanged paper is 1.0 however the light drifted."""
    pixels = cv2.GaussianBlur(ratio, (0, 0), 0.7)
    size = _odd(BACKGROUND_MM * px_per_mm)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
    level = cv2.morphologyEx(pixels, cv2.MORPH_CLOSE, kernel)  # fills in anything dark and thinner than the kernel
    level[~valid] = np.median(level[valid], axis=0)
    level = cv2.GaussianBlur(level, (0, 0), size)
    return np.clip(pixels / np.maximum(level, 0.05), 0.0, 1.5)


def compare(current, reference, valid, px_per_mm=PX_PER_MM):
    """(relative, change) of the current image against the page's reference, both straightened alike.

    relative: per channel, how much light the paper sends back now against then, 1.0 where nothing
    was added and lower where ink was; the projection cancels out, so ink keeps the colour it has
    on white paper. Never above 1: something lighter than the paper was is not ink.
    change: how far each pixel is from the reference in either direction (|log ratio|, the largest
    channel), for telling an arm or a phone on the sheet."""
    current = current.astype(np.float32)
    reference = align_reference(reference.astype(np.float32), current, valid, px_per_mm)
    gain = np.median(current[valid], axis=0) / np.maximum(np.median(reference[valid], axis=0), 1.0)
    reference = np.maximum(reference * gain, 4.0)
    change = np.abs(np.log(np.maximum(current, 1.0) / reference)).max(axis=2)
    darkest = cv2.erode(reference, _disc(SHIFT_TOLERANCE_MM * px_per_mm))
    ratio = np.minimum(current / darkest, 1.0)
    return _flatten(ratio, valid, px_per_mm), change


def covered_mm2(change, valid, px_per_mm=PX_PER_MM):
    """The area, in mm2, of the largest thing on the sheet thicker than a pen line: changed against
    the reference, and still there once everything thinner than MAX_LINE_MM is opened away."""
    changed = ((change > OCCLUDER_CHANGE) & valid).astype(np.uint8)
    thick = cv2.morphologyEx(changed, cv2.MORPH_OPEN, _disc(MAX_LINE_MM / 2.0 * px_per_mm))
    count, _labels, stats, _ = cv2.connectedComponentsWithStats(thick, connectivity=8)
    if count <= 1:
        return 0.0
    return float(stats[1:, cv2.CC_STAT_AREA].max()) / (px_per_mm * px_per_mm)


def ink_mask(relative, valid, px_per_mm=PX_PER_MM):
    """Pen lines: pixels clearly darker or more coloured than the paper, grown into the fainter
    pixels round them, less specks and anything too thick to be a pen line."""
    b, g, r = relative[..., 0], relative[..., 1], relative[..., 2]
    darkness = 1.0 - (0.114 * b + 0.587 * g + 0.299 * r)
    lab = cv2.cvtColor(np.clip(relative * 255.0, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    chroma = np.hypot(lab[..., 1] - 128.0, lab[..., 2] - 128.0)
    strong = ((darkness > DARK_STRONG) | (chroma > CHROMA_STRONG)) & valid
    weak = ((darkness > DARK_WEAK) | (chroma > CHROMA_WEAK)) & valid
    count, labels, stats, _ = cv2.connectedComponentsWithStats(weak.astype(np.uint8), connectivity=8)
    if count <= 1:
        return np.zeros_like(valid)
    keep = np.zeros(count, bool)
    keep[np.unique(labels[strong])] = True
    keep[0] = False
    keep &= stats[:, cv2.CC_STAT_AREA] >= MIN_BLOB_MM2 * px_per_mm * px_per_mm
    radius = cv2.distanceTransform(weak.astype(np.uint8), cv2.DIST_L2, 3)
    thickest = np.zeros(count, np.float32)
    np.maximum.at(thickest, labels.ravel(), radius.ravel())
    keep &= thickest <= MAX_LINE_MM / 2.0 * px_per_mm
    return keep[labels]


def added_ink_image(relative, valid, px_per_mm=PX_PER_MM):
    """What was drawn, on white: the ink in its own colour, everything else white. The kind of image
    the handwriting reader (digitizer/handwriting.py) is given, with no projection or print left in it."""
    ink = cv2.dilate(ink_mask(relative, valid, px_per_mm).astype(np.uint8), _disc(1)) > 0
    out = np.full(relative.shape, 255, np.uint8)
    out[ink] = np.clip(relative[ink] * 255.0, 0, 255).astype(np.uint8)
    return out


def _skeleton(mask):
    # opencv-contrib-python's thinning is the faster one. Plain opencv-python has none, and the two
    # installed side by side leave a cv2.ximgproc without it, so scikit-image does it then.
    thinning = getattr(getattr(cv2, "ximgproc", None), "thinning", None)
    if thinning is not None:
        binary = mask.astype(np.uint8) * 255
        return thinning(binary, thinningType=cv2.ximgproc.THINNING_GUOHALL) > 0
    from skimage.morphology import skeletonize
    return skeletonize(mask)


_SIDES = ((-1, 0), (1, 0), (0, -1), (0, 1))
_DIAGONALS = ((-1, -1), (-1, 1), (1, -1), (1, 1))


def _neighbours(on, p):
    """A pixel's skeleton neighbours. A diagonal step counts only where no side step reaches it,
    so a staircase is one line rather than a chain of tiny junctions."""
    y, x = p
    out = [(y + dy, x + dx) for dy, dx in _SIDES if (y + dy, x + dx) in on]
    for dy, dx in _DIAGONALS:
        q = (y + dy, x + dx)
        if q in on and (y + dy, x) not in on and (y, x + dx) not in on:
            out.append(q)
    return out


def _trace_links(links):
    """Pixel chains, each running from an end or junction to the next; closed loops come out whole.
    Points are (y, x)."""
    nodes = {p for p, near in links.items() if len(near) != 2}
    walked = set()
    chains = []

    def walk(start, step):
        chain = [start, step]
        walked.update({(start, step), (step, start)})
        previous, current = start, step
        while current not in nodes:
            ahead = [q for q in links[current] if q != previous and (current, q) not in walked]
            if not ahead:
                break
            walked.update({(current, ahead[0]), (ahead[0], current)})
            chain.append(ahead[0])
            previous, current = current, ahead[0]
        return chain

    for node in nodes:
        for step in links[node]:
            if (node, step) not in walked:
                chains.append(walk(node, step))
    for p in links:  # loops have no ends or junctions to start from
        for step in links[p]:
            if (p, step) not in walked:
                nodes.add(p)
                chains.append(walk(p, step))
                nodes.discard(p)
    return chains


def _links(skeleton):
    ys, xs = np.nonzero(skeleton)
    on = set(zip(ys.tolist(), xs.tolist()))
    return {p: _neighbours(on, p) for p in on}


def trace(skeleton):
    """The skeleton as pixel chains, each running from an end or junction to the next; closed
    loops come out whole. Points are (x, y)."""
    return [[(x, y) for y, x in chain] for chain in _trace_links(_links(skeleton))]


def _hex(bgr):
    b, g, r = (int(round(min(255.0, max(0.0, v * 255.0)))) for v in bgr)
    return "#%02x%02x%02x" % (r, g, b)


def _enclosed(ink, px_per_mm):
    """The paper the ink closes round, once gaps up to CLOSE_GAP_MM are closed."""
    closed = cv2.morphologyEx(ink.astype(np.uint8), cv2.MORPH_CLOSE, _disc(CLOSE_GAP_MM / 2.0 * px_per_mm))
    padded = cv2.copyMakeBorder(closed, 1, 1, 1, 1, cv2.BORDER_CONSTANT, value=0)
    cv2.floodFill(padded, None, (0, 0), 2)
    return padded[1:-1, 1:-1] == 0


def _disc_marks(ink, px_per_mm):
    """Small circles and dots, on their own or on a line: [(kind, (x, y) px, size px, blob, box)],
    blob being the disc's mask cut to its box (x, y, w, h)."""
    enclosed = _enclosed(ink, px_per_mm)
    body = cv2.morphologyEx((ink | enclosed).astype(np.uint8), cv2.MORPH_OPEN, _disc(BODY_MM / 2.0 * px_per_mm))
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(body, connectivity=8)
    found = []
    for label in range(1, count):
        x, y, w, h, area = (int(v) for v in stats[label])
        if max(w, h) > POINT_MAX_MM * px_per_mm:
            continue
        blob = labels[y:y + h, x:x + w] == label
        contours, _ = cv2.findContours(blob.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        contour = max(contours, key=cv2.contourArea)
        _centre, (side_a, side_b), _angle = cv2.minAreaRect(contour)
        hull = cv2.contourArea(cv2.convexHull(contour))
        if min(side_a, side_b) < ROUNDNESS * max(side_a, side_b) or hull <= 0 or area / hull < SOLIDITY:
            continue
        hole = enclosed[y:y + h, x:x + w][blob].sum() / float(area)
        kind = "circle" if hole >= CIRCLE_HOLE_SHARE else "dot"
        found.append((kind, (float(centroids[label][0]), float(centroids[label][1])), max(w, h), blob, (x, y, w, h)))
    return found


def _crossings(links, chains, lengths, px_per_mm):
    """X marks, on their own or on a line: [((x, y) px, size px, indexes of the chains that are the
    X's arms or lie between its junctions)]. A crossing is skeleton junctions within CROSSING_MM
    of each other; it is an X when MIN_X_ARMS short arms leave it and end free."""
    junctions = [p for p, near in links.items() if len(near) >= 3]
    if not junctions:
        return []
    reach = CROSSING_MM * px_per_mm
    groups = []  # junctions are few: a plain scan will do
    for p in junctions:
        near = [g for g in groups if any(abs(q[0] - p[0]) <= reach and abs(q[1] - p[1]) <= reach for q in g)]
        merged = {p}.union(*near)
        groups = [g for g in groups if all(g is not n for n in near)] + [merged]
    shortest, longest = SPUR_MM * px_per_mm, ARM_MAX_MM * px_per_mm
    found = []
    for members in groups:
        arms, inner = [], []
        for index, chain in enumerate(chains):
            first, last = chain[0] in members, chain[-1] in members
            if first and last:
                inner.append(index)
            elif first or last:
                free = chain[-1] if first else chain[0]
                if len(links[free]) == 1 and shortest <= lengths[index] <= longest:
                    arms.append(index)
        if arms:
            longest_arm = max(lengths[i] for i in arms)
            arms = [i for i in arms if lengths[i] >= ARM_BALANCE * longest_arm]
        if len(arms) < MIN_X_ARMS:
            continue
        y, x = np.mean(np.float32(sorted(members)), axis=0)
        ends = [chains[i][-1] if chains[i][0] in members else chains[i][0] for i in arms]
        turns = sorted(math.degrees(math.atan2(ey - y, ex - x)) % 360.0 for ey, ex in ends)
        gaps = [b - a for a, b in zip(turns, turns[1:])] + [turns[0] + 360.0 - turns[-1]]
        if max(gaps) <= MAX_ARM_GAP_DEG:
            found.append(((float(x), float(y)), 2.0 * max(lengths[i] for i in arms), arms + inner))
    return found


def extract_marks(relative, valid, px_per_mm=PX_PER_MM, ink=None):
    """(strokes, points) on the straightened inside, millimetres from the inside's top-left.
    strokes: [{"points": [(x_mm, y_mm), ...], "color": "#rrggbb"}]; points: [{"point": (x_mm, y_mm),
    "kind": "dot" | "x" | "circle", "color": "#rrggbb"}]. The colour is the ink as on white paper.
    What makes a point is told above POINT_MAX_MM; the traced pieces of a point's mark are left
    out of the strokes, so a route with its start circled is a line and a point."""
    if ink is None:
        ink = ink_mask(relative, valid, px_per_mm)
    links = _links(_skeleton(ink))
    chains = _trace_links(links)
    curves = [np.float32([(px, py) for py, px in chain]).reshape(-1, 1, 2) for chain in chains]
    lengths = [cv2.arcLength(curve, False) for curve in curves]
    owner = [None] * len(chains)  # the point each traced piece belongs to
    points = []
    arrays = [np.int32(chain) for chain in chains]
    boxes = np.int32([[a[:, 0].min(), a[:, 0].max(), a[:, 1].min(), a[:, 1].max()] for a in arrays]).reshape(-1, 4)

    def add(kind, at, size, pixels):
        colour = _hex(np.median(pixels, axis=0)) if len(pixels) else "#000000"
        points.append({"point": (at[0] / px_per_mm, at[1] / px_per_mm), "kind": kind, "color": colour,
                       "sizeMm": size / px_per_mm})
        return len(points) - 1

    def within(region, y0, x0):
        """{chain: which of its pixels are in region (a mask placed at y0, x0)} for the chains reaching it."""
        y1, x1 = y0 + region.shape[0], x0 + region.shape[1]
        near = (boxes[:, 0] < y1) & (boxes[:, 1] >= y0) & (boxes[:, 2] < x1) & (boxes[:, 3] >= x0)
        out = {}
        for i in np.nonzero(near)[0]:
            ys, xs = arrays[i][:, 0] - y0, arrays[i][:, 1] - x0
            on = (ys >= 0) & (ys < region.shape[0]) & (xs >= 0) & (xs < region.shape[1])
            inside = np.zeros(len(ys), bool)
            inside[on] = region[ys[on], xs[on]]
            out[int(i)] = inside
        return out

    def claim(index, pieces):
        for i, inside in pieces.items():
            if owner[i] is None and inside.mean() >= OWNED_SHARE:
                owner[i] = index

    # Circles and dots: the traced pieces mostly inside the disc, grown to take in its ring.
    height, width = ink.shape
    grow = int(math.ceil(1.5 * px_per_mm))
    for kind, at, size, blob, (x, y, w, h) in _disc_marks(ink, px_per_mm):
        x0, y0 = max(0, x - grow), max(0, y - grow)
        x1, y1 = min(width, x + w + grow), min(height, y + h + grow)
        region = np.zeros((y1 - y0, x1 - x0), np.uint8)
        region[y - y0:y - y0 + h, x - x0:x - x0 + w] = blob
        region = cv2.dilate(region, _disc(grow)) > 0
        pieces = within(region, y0, x0)
        if kind == "dot":
            stub = sum(lengths[i] for i, inside in pieces.items() if inside.mean() >= OWNED_SHARE)
            leaving = sum(1 for i, inside in pieces.items() if inside.mean() < OWNED_SHARE
                          and (inside[0] or inside[-1]) and lengths[i] >= SPUR_MM * px_per_mm)
            if stub > DOT_SKELETON * size or leaving > MAX_DOT_LINES:
                continue
        index = add(kind, at, size, relative[y0:y1, x0:x1][region & ink[y0:y1, x0:x1]])
        claim(index, pieces)
    # X marks: their arms and the bits between the junctions of their crossing.
    for at, size, pieces in _crossings(links, chains, lengths, px_per_mm):
        pixels = np.float32([relative[py, px] for i in pieces for py, px in chains[i]])
        index = add("x", at, size, pixels)
        for i in pieces:
            if owner[i] is None:
                owner[i] = index
    # Marks too small to have a shape: dots.
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(ink.astype(np.uint8), connectivity=8)
    for label in range(1, count):
        x, y, w, h = (int(v) for v in stats[label, :4])
        if max(w, h) > DOT_MAX_MM * px_per_mm:
            continue
        index = add("dot", (float(centroids[label][0]), float(centroids[label][1])), max(w, h),
                    relative[y:y + h, x:x + w][labels[y:y + h, x:x + w] == label])
        claim(index, within(labels[y:y + h, x:x + w] == label, y, x))
    strokes = []
    for i, curve in enumerate(curves):
        if owner[i] is not None or lengths[i] < MIN_STROKE_MM * px_per_mm:
            continue
        xs, ys = curve[:, 0, 0].astype(int), curve[:, 0, 1].astype(int)
        simple = cv2.approxPolyDP(curve, SIMPLIFY_MM * px_per_mm, False).reshape(-1, 2)
        strokes.append({"points": [(float(px) / px_per_mm, float(py) / px_per_mm) for px, py in simple],
                        "color": _hex(np.median(relative[ys, xs], axis=0))})
    # One place marked twice (a dot in a circle, a circled X) is one point: the larger mark's.
    points.sort(key=lambda p: -p["sizeMm"])
    kept = []
    for p in points:
        if not any(math.dist(p["point"], q["point"]) <= max(q["sizeMm"] / 2.0, CROSSING_MM) for q in kept):
            kept.append(p)
    for p in kept:
        p.pop("sizeMm")
    return strokes, kept


def georeference(strokes, layout, view, points=()):
    """The strokes as GeoJSON LineStrings and the points as Points. view is what the sheet showed: its
    centre, zoom and bearing, and the width and height in CSS px the map was drawn at (MapLibre: 512 px
    tiles)."""
    x0, y0, x1, y1 = layout["interiorMm"]
    width, height = float(view["width"]), float(view["height"])
    world = 512.0 * 2.0 ** float(view["zoom"])
    sin_lat = math.sin(math.radians(float(view["lat"])))
    centre_x = (float(view["lng"]) + 180.0) / 360.0 * world
    centre_y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * world
    turn = math.radians(float(view.get("bearing") or 0.0))
    cos_t, sin_t = math.cos(turn), math.sin(turn)

    def lng_lat(x_mm, y_mm):
        dx = x_mm / (x1 - x0) * width - width / 2.0
        dy = y_mm / (y1 - y0) * height - height / 2.0
        wx = centre_x + dx * cos_t - dy * sin_t
        wy = centre_y + dx * sin_t + dy * cos_t
        lng = wx / world * 360.0 - 180.0
        lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * wy / world))))
        return [round(lng, 7), round(lat, 7)]

    features = []
    for stroke in strokes:
        features.append({
            "type": "Feature",
            "properties": {"color": stroke["color"]},
            "geometry": {"type": "LineString", "coordinates": [lng_lat(x, y) for x, y in stroke["points"]]},
        })
    for point in points:
        features.append({
            "type": "Feature",
            "properties": {"color": point["color"], "kind": point["kind"]},
            "geometry": {"type": "Point", "coordinates": lng_lat(*point["point"])},
        })
    return {"type": "FeatureCollection", "features": features}
