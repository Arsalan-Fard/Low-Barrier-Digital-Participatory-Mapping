"""What did the participant add? Colour-fit the clean print, then diff.

The clean reference render is a colour chart we get for free: every printed
pixel's true colour is known. Fitting the photo to it gives two things:

* ``predicted`` -- the reference as this camera, under this light, would see it,
  used to find what differs (the "added" score);
* ``corrected`` -- the photo mapped back into the reference's colour space, so
  a pink sticker measures the same pink under a warm lamp and in daylight.

The added score is ported from the old digitiser's ``_extract_map_sheet_drawing``
(app.py until 2026-09-25; archived in data/_archive/2026-09-25-old-digitize-panel): a pixel
scores by how far its colour falls outside the range of colours the reference
shows *nearby*, not against the single pixel beneath it. Printed edges blur
differently in a photo than in the render, but the halo is always a blend of
colours already present around it, so it scores zero; ink brings a colour that
simply is not there.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from .register import refine_ecc, refine_tiles

# A misregistered printed label differs from the reference mostly in lightness;
# ink differs in chroma (app.py's measured weights).
LUMINANCE_WEIGHT = 0.42
CHROMA_WEIGHT = 1.25


@dataclass
class MapImages:
    observed: np.ndarray      # aligned rectified photo, BGR uint8
    predicted: np.ndarray     # reference as the camera would see it, float32 BGR
    normalized: np.ndarray    # observed with slow lighting removed, uint8
    corrected: np.ndarray     # photo mapped into reference colours, uint8 (colour-constant)
    score: np.ndarray         # 0..255 added-ink strength, uint8
    valid: np.ndarray         # 255 where the map can be analysed
    covered: np.ndarray       # True where printed detail has vanished under something opaque
    clean: np.ndarray         # reference at this size, uint8
    px_per_mm: float
    info: dict = field(default_factory=dict)

    @property
    def shape(self) -> tuple[int, int]:
        return self.score.shape[:2]


def exclusion_mask(width: int, height: int, normalized_rects: list, edge_mm: float, px_per_mm: float) -> np.ndarray:
    """255 where the map may carry ink: not on a tag cell, not at the very edge."""
    valid = np.full((height, width), 255, dtype=np.uint8)
    for rect in normalized_rects or []:
        try:
            x0, y0, x1, y1 = (float(v) for v in rect)
        except (TypeError, ValueError):
            continue
        x0, x1 = int(math.floor(x0 * width)), int(math.ceil(x1 * width))
        y0, y1 = int(math.floor(y0 * height)), int(math.ceil(y1 * height))
        valid[max(0, y0):min(height, y1), max(0, x0):min(width, x1)] = 0
    edge = max(2, int(round(edge_mm * px_per_mm)))
    valid[:edge, :] = 0
    valid[-edge:, :] = 0
    valid[:, :edge] = 0
    valid[:, -edge:] = 0
    return valid


def fit_reference_colors(reference: np.ndarray, observed: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Robust affine map clean BGR -> photographed BGR (fitted inside the print's gamut)."""
    sample = valid[::5, ::5] > 0
    ref_sample = reference[::5, ::5][sample].astype(np.float32)
    obs_sample = observed[::5, ::5][sample].astype(np.float32)
    if len(ref_sample) < 100:
        return reference.astype(np.float32)
    design = np.column_stack([ref_sample, np.ones(len(ref_sample), dtype=np.float32)])
    keep = np.ones(len(ref_sample), dtype=bool)
    coefficients = None
    for _ in range(4):
        coefficients, *_ = np.linalg.lstsq(design[keep], obs_sample[keep], rcond=None)
        residual = np.linalg.norm(design @ coefficients - obs_sample, axis=1)
        keep = residual <= max(4.0, float(np.quantile(residual, 0.82)))
    full = np.concatenate([reference.astype(np.float32), np.ones((*reference.shape[:2], 1), np.float32)], axis=2)
    return np.clip(full @ coefficients, 0, 255).astype(np.float32)


def fit_channel_gains(reference: np.ndarray, observed: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Per-channel gain through the origin, photo = gain * reference.

    Used to map the photo *back* into reference colours. A gain extrapolates
    safely to saturated ink far outside the printed map's pale gamut, where the
    full affine fit above would overshoot (app.py's _fit_channel_response).
    """
    sample = valid[::5, ::5] > 0
    ref_sample = reference[::5, ::5][sample].astype(np.float32)
    obs_sample = observed[::5, ::5][sample].astype(np.float32)
    gains = np.ones(3, dtype=np.float32)
    if len(ref_sample) < 100:
        return gains
    for channel in range(3):
        source, target = ref_sample[:, channel], obs_sample[:, channel]
        keep = source > 8.0
        for _ in range(4):
            if int(np.count_nonzero(keep)) < 50:
                break
            gain = float(np.dot(source[keep], target[keep]) / max(1e-6, np.dot(source[keep], source[keep])))
            residual = np.abs(source * gain - target)
            keep = (source > 8.0) & (residual <= max(3.0, float(np.quantile(residual[keep], 0.82))))
            gains[channel] = gain
    return np.clip(gains, 0.35, 2.8)


def added_score(normalized: np.ndarray, predicted: np.ndarray, valid: np.ndarray, radius_px: int) -> np.ndarray:
    """Float map: how far each pixel's Lab falls outside the nearby reference range."""
    observed_lab = cv2.cvtColor(cv2.GaussianBlur(normalized, (3, 3), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    predicted_lab = cv2.cvtColor(
        cv2.GaussianBlur(np.clip(predicted, 0, 255).astype(np.uint8), (3, 3), 0), cv2.COLOR_BGR2LAB
    ).astype(np.float32)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (radius_px * 2 + 1, radius_px * 2 + 1))
    lowest = cv2.erode(predicted_lab, kernel)
    highest = cv2.dilate(predicted_lab, kernel)
    outside = (np.maximum(observed_lab - highest, 0.0) + np.maximum(lowest - observed_lab, 0.0)) * np.asarray(
        [LUMINANCE_WEIGHT, CHROMA_WEIGHT, CHROMA_WEIGHT], dtype=np.float32)
    distance = np.sqrt(np.einsum("ijk,ijk->ij", outside, outside))
    distance[valid == 0] = 0
    return distance


def analyse_map(rectified: np.ndarray, reference: np.ndarray, mask_rects: list, px_per_mm: float,
                coverage: np.ndarray | None = None, dense: bool = True) -> MapImages:
    height, width = rectified.shape[:2]
    clean = reference if reference.shape[:2] == (height, width) else cv2.resize(
        reference, (width, height), interpolation=cv2.INTER_AREA)
    valid = exclusion_mask(width, height, mask_rects, edge_mm=3.5, px_per_mm=px_per_mm)
    info: dict = {}
    if coverage is not None:
        # Stay a few millimetres clear of where the photo ends.
        margin = max(3, int(round(4.0 * px_per_mm)))
        inside = cv2.erode(coverage, cv2.getStructuringElement(cv2.MORPH_RECT, (2 * margin + 1, 2 * margin + 1)))
        info["outsidePhotoPct"] = round(100.0 * float(np.mean(inside == 0)), 2)
        valid[inside == 0] = 0

    predicted = fit_reference_colors(clean, rectified, valid)
    observed, ecc_ok = refine_ecc(rectified, predicted, valid)
    info["ecc"] = ecc_ok
    if dense:
        observed, info["dense"] = refine_tiles(
            observed, fit_reference_colors(clean, observed, valid), valid,
            max_shift_px=8.0 * px_per_mm)
    predicted = fit_reference_colors(clean, observed, valid)

    # Remove slow lighting and shadow while keeping narrow strokes.
    observed_f = observed.astype(np.float32)
    residual = observed_f - predicted
    sigma = 8.0 * px_per_mm
    illumination = cv2.GaussianBlur(residual, (0, 0), sigma)
    normalized = np.clip(observed_f - illumination, 0, 255).astype(np.uint8)

    refined = ecc_ok or bool((info.get("dense") or {}).get("applied"))
    radius = int(min(8, max(2, round((0.6 if refined else 1.0) * px_per_mm))))
    distance = added_score(normalized, predicted, valid, radius)

    # Second pass with the ink left out of the lighting estimate. A sticker is
    # a big dark patch the reference lacks; blurred into the "lighting" it
    # leaves a halo of false ink around itself that swallows thin strokes
    # running past it.
    grow = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (int(3 * px_per_mm) | 1, int(3 * px_per_mm) | 1))
    ink = cv2.dilate((distance >= 14).astype(np.uint8), grow)
    weight = ((ink == 0) & (valid > 0)).astype(np.float32)
    support = cv2.GaussianBlur(weight, (0, 0), sigma)
    masked = cv2.GaussianBlur(residual * weight[:, :, None], (0, 0), sigma) / np.maximum(support, 1e-3)[:, :, None]
    trust = np.clip(support / 0.25, 0.0, 1.0)[:, :, None]  # little clean paper nearby: keep pass one
    illumination = trust * masked + (1.0 - trust) * illumination
    normalized = np.clip(observed_f - illumination, 0, 255).astype(np.uint8)
    distance = added_score(normalized, predicted, valid, radius)
    score = cv2.medianBlur(np.clip(distance, 0, 255).astype(np.uint8), 3 if px_per_mm < 5 else 5)

    gains = fit_channel_gains(clean, normalized, valid)
    corrected = np.clip(normalized.astype(np.float32) / gains, 0, 255).astype(np.uint8)
    covered = covered_detail(normalized, predicted, valid, px_per_mm)
    info.update({"searchRadiusPx": radius, "channelGains": [round(float(g), 3) for g in gains],
                 "coveredDetailPx": int(covered.sum())})
    return MapImages(observed=observed, predicted=predicted, normalized=normalized, corrected=corrected,
                     score=score, valid=valid, covered=covered, clean=clean, px_per_mm=px_per_mm, info=info)


def covered_detail(normalized: np.ndarray, predicted: np.ndarray, valid: np.ndarray, px_per_mm: float) -> np.ndarray:
    """Where the print has detail but the photo is flat: something opaque covers it.

    A black sticker over a dark printed icon (a park's tree roundel) barely
    differs from it in colour and scored as ink only where it overhung the
    icon. What gives it away is that the icon's white tree is gone. Ported
    from app.py's _opaque_disc_mask; the sticker pass only uses these pixels
    where they join clear ink, so on their own they cannot invent a sticker.
    """
    window = max(5, int(round(2.2 * px_per_mm)) | 1)
    observed_gray = cv2.cvtColor(normalized, cv2.COLOR_BGR2GRAY).astype(np.float32)
    predicted_gray = cv2.cvtColor(np.clip(predicted, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)

    def local_std(gray):
        mean = cv2.blur(gray, (window, window))
        return np.sqrt(np.clip(cv2.blur(gray * gray, (window, window)) - mean * mean, 0.0, None))

    predicted_std = local_std(predicted_gray)
    covered = (predicted_std >= 14.0) & (local_std(observed_gray) <= 0.42 * predicted_std) & (valid > 0)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (window, window))
    covered = cv2.morphologyEx(covered.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
    return cv2.morphologyEx(covered, cv2.MORPH_OPEN, kernel) > 0
