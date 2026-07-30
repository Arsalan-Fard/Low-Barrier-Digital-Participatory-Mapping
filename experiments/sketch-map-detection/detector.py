"""Standalone adaptation of the Sketch Map Tool marking detector.

The ML flow in this file follows GIScience/sketch-map-tool's
``upload_processing/detect_markings.py``.  See THIRD_PARTY_NOTICE.md.
"""

from __future__ import annotations

from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from threading import Lock

import cv2
import numpy as np
import torch
from numpy.typing import NDArray
from PIL import Image


@dataclass
class DetectionResult:
    aligned_bgr: NDArray
    raw_masks: list[NDArray]
    masks: list[NDArray]
    boxes: NDArray
    classes: list[int]
    alignment_matches: int
    alignment_inliers: int


class SketchMapDetector:
    """Lazy-loaded SMT-OSM/SMT-ESRI + SMT-CLS + SAM2 detector."""

    def __init__(self, weights_dir: Path):
        self.weights_dir = Path(weights_dir)
        self._models: dict[str, object] = {}
        self._lock = Lock()

    def required_weights(self, layer: str) -> list[Path]:
        object_model = "SMT-ESRI.pt" if layer == "esri" else "SMT-OSM.pt"
        return [
            self.weights_dir / object_model,
            self.weights_dir / "SMT-CLS.pt",
            self.weights_dir / "sam2_hiera_base_plus.pt",
        ]

    def missing_weights(self, layer: str) -> list[str]:
        return [str(path) for path in self.required_weights(layer) if not path.is_file()]

    def _load_models(self, layer: str):
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        from ultralytics import YOLO
        from ultralytics_MB import YOLO as YOLO_MB

        missing = self.missing_weights(layer)
        if missing:
            raise FileNotFoundError("Missing model weights: " + ", ".join(missing))

        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        if "sam" not in self._models:
            sam_model = build_sam2(
                config_file="configs/sam2/sam2_hiera_b+.yaml",
                ckpt_path=str(self.weights_dir / "sam2_hiera_base_plus.pt"),
                device=device,
            )
            self._models["sam"] = SAM2ImagePredictor(sam_model)
            self._models["classifier"] = YOLO(str(self.weights_dir / "SMT-CLS.pt"))

        object_key = f"object-{layer}"
        if object_key not in self._models:
            model_name = "SMT-ESRI.pt" if layer == "esri" else "SMT-OSM.pt"
            object_model = YOLO_MB(str(self.weights_dir / model_name))
            # The pinned multiband fork warms every predictor with a hard-coded
            # three-channel tensor. SMT object weights require six channels
            # (marked RGB + clean-reference RGB), so bypass that invalid warmup.
            predictor_args = {
                **object_model.overrides,
                "conf": 0.25,
                "save": False,
                "mode": "predict",
                "verbose": False,
            }
            object_model.predictor = object_model._smart_load("predictor")(
                overrides=predictor_args,
                _callbacks=object_model.callbacks,
            )
            object_model.predictor.setup_model(model=object_model.model, verbose=False)
            object_model.predictor.done_warmup = True
            self._models[object_key] = object_model
        return self._models[object_key], self._models["classifier"], self._models["sam"]

    @staticmethod
    def align_to_reference(photo_bgr: NDArray, reference_bgr: NDArray) -> tuple[NDArray, int, int]:
        """Use SMT's BRISK + FLANN + homography clipping approach."""
        brisk = cv2.BRISK_create()
        photo_gray = cv2.cvtColor(photo_bgr, cv2.COLOR_BGR2GRAY)
        reference_gray = cv2.cvtColor(reference_bgr, cv2.COLOR_BGR2GRAY)
        photo_points, photo_descriptors = brisk.detectAndCompute(photo_gray, None)
        ref_points, ref_descriptors = brisk.detectAndCompute(reference_gray, None)

        if photo_descriptors is None or ref_descriptors is None:
            raise ValueError("Not enough visual features to align the uploaded image")

        max_keypoints = 50_000
        if len(photo_points) > max_keypoints:
            order = np.argsort([-point.response for point in photo_points])[:max_keypoints]
            photo_points = [photo_points[index] for index in order]
            photo_descriptors = photo_descriptors[order]
        if len(ref_points) > max_keypoints:
            order = np.argsort([-point.response for point in ref_points])[:max_keypoints]
            ref_points = [ref_points[index] for index in order]
            ref_descriptors = ref_descriptors[order]

        matcher = cv2.FlannBasedMatcher(
            {
                "algorithm": 6,
                "table_number": 6,
                "key_size": 12,
                "multi_probe_level": 1,
            },
            {},
        )
        candidates = matcher.knnMatch(photo_descriptors, ref_descriptors, k=2)
        good = [pair[0] for pair in candidates if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance]
        if len(good) < 8:
            raise ValueError(f"Alignment found only {len(good)} reliable map matches")

        source = np.float32([photo_points[item.queryIdx].pt for item in good]).reshape(-1, 1, 2)
        target = np.float32([ref_points[item.trainIdx].pt for item in good]).reshape(-1, 1, 2)
        homography, inlier_mask = cv2.findHomography(source, target, cv2.RANSAC, 4.0)
        if homography is None:
            raise ValueError("Could not calculate the photo-to-map homography")

        inliers = int(inlier_mask.sum()) if inlier_mask is not None else 0
        if inliers < 6:
            raise ValueError(f"Alignment is unreliable ({inliers} inliers)")
        height, width = reference_bgr.shape[:2]
        aligned = cv2.warpPerspective(photo_bgr, homography, (width, height))
        return aligned, len(good), inliers

    def detect(self, photo_bgr: NDArray, reference_bgr: NDArray, layer: str = "osm") -> DetectionResult:
        aligned_bgr, match_count, inlier_count = self.align_to_reference(photo_bgr, reference_bgr)
        marked_rgb = cv2.cvtColor(aligned_bgr, cv2.COLOR_BGR2RGB)
        reference_rgb = cv2.cvtColor(reference_bgr, cv2.COLOR_BGR2RGB)

        with self._lock:
            object_model, classifier, sam = self._load_models(layer)
            combined = np.concatenate((marked_rgb, reference_rgb), axis=2)
            object_result = object_model.predict(combined, verbose=False)[0].boxes
            boxes = object_result.xyxy.detach().cpu().numpy()
            if not len(boxes):
                return DetectionResult(aligned_bgr, [], [], boxes, [], match_count, inlier_count)

            classes: list[int] = []
            for box in boxes:
                x1, y1, x2, y2 = [int(value) for value in box[:4]]
                crop = marked_rgb[max(0, y1):max(y1 + 1, y2), max(0, x1):max(x1 + 1, x2)]
                result = classifier(Image.fromarray(crop), verbose=False)
                classes.append(int(result[0].probs.top1) + 1)

            context = (
                torch.autocast("cuda", dtype=torch.bfloat16)
                if torch.cuda.is_available()
                else nullcontext()
            )
            with torch.inference_mode(), context:
                sam.set_image(marked_rgb)
                raw_masks = [
                    sam.predict(box=box, multimask_output=False)[0][0]
                    for box in boxes
                ]

        masks = self._post_process(raw_masks, boxes, classes)
        return DetectionResult(
            aligned_bgr,
            raw_masks,
            masks,
            boxes,
            classes,
            match_count,
            inlier_count,
        )

    @staticmethod
    def _post_process(raw_masks: list[NDArray], boxes: NDArray, classes: list[int]) -> list[NDArray]:
        processed: list[NDArray] = []
        for mask, box, class_index in zip(raw_masks, boxes, classes):
            width = max(1, int((box[2] - box[0]) * 0.05))
            height = max(1, int((box[3] - box[1]) * 0.05))
            kernel = np.ones((height, width), np.uint8)
            closed = cv2.morphologyEx(mask.astype(np.uint8), cv2.MORPH_CLOSE, kernel)
            contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            filled = np.zeros_like(closed, dtype=np.uint8)
            cv2.drawContours(filled, contours, -1, int(class_index), thickness=cv2.FILLED)
            processed.append(filled)
        return processed


def masks_to_rgba(masks: list[NDArray], shape: tuple[int, int]) -> NDArray:
    height, width = shape
    rgba = np.zeros((height, width, 4), dtype=np.uint8)
    if not masks:
        return rgba
    union = np.any(np.stack([mask > 0 for mask in masks]), axis=0)
    # OpenCV encodes four-channel arrays as BGRA.
    rgba[union] = (61, 48, 235, 220)
    return rgba


def masks_to_binary(masks: list[NDArray], shape: tuple[int, int]) -> NDArray:
    if not masks:
        return np.zeros(shape, dtype=np.uint8)
    return np.any(np.stack([mask > 0 for mask in masks]), axis=0).astype(np.uint8) * 255


def masks_to_geotiff(masks: list[NDArray], shape: tuple[int, int], corners: list[list[float]]) -> bytes:
    """Encode a single-band raw detection mask as an EPSG:4326 GeoTIFF."""
    from rasterio.io import MemoryFile
    from rasterio.transform import Affine

    height, width = shape
    tl, tr, _, bl = [np.asarray(corner, dtype=float) for corner in corners]
    transform = Affine(
        (tr[0] - tl[0]) / width,
        (bl[0] - tl[0]) / height,
        tl[0],
        (tr[1] - tl[1]) / width,
        (bl[1] - tl[1]) / height,
        tl[1],
    )
    mask = masks_to_binary(masks, shape)
    with MemoryFile() as memory:
        with memory.open(
            driver="GTiff",
            width=width,
            height=height,
            count=1,
            dtype="uint8",
            crs="EPSG:4326",
            transform=transform,
            nodata=0,
            compress="deflate",
        ) as dataset:
            dataset.write(mask, 1)
            dataset.set_band_description(1, "raw SAM2 drawing mask")
        return memory.read()


def masks_to_geojson(masks: list[NDArray], corners: list[list[float]]) -> dict:
    """Convert mask contours to geographic polygons using the stored four corners."""
    if not masks:
        return {"type": "FeatureCollection", "features": []}
    height, width = masks[0].shape
    tl, tr, br, bl = [np.asarray(corner, dtype=float) for corner in corners]

    def geographic(point) -> list[float]:
        x, y = point
        u = float(x) / max(1, width - 1)
        v = float(y) / max(1, height - 1)
        top = tl * (1.0 - u) + tr * u
        bottom = bl * (1.0 - u) + br * u
        return (top * (1.0 - v) + bottom * v).tolist()

    features = []
    for mask_index, mask in enumerate(masks):
        binary = (mask > 0).astype(np.uint8)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            if cv2.contourArea(contour) < 12:
                continue
            simplified = cv2.approxPolyDP(contour, 1.5, True).reshape(-1, 2)
            if len(simplified) < 3:
                continue
            ring = [geographic(point) for point in simplified]
            ring.append(ring[0])
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "source": "GIScience Sketch Map Tool detector",
                        "class": int(mask[mask > 0][0]),
                        "detection": mask_index,
                    },
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }
            )
    return {"type": "FeatureCollection", "features": features}
