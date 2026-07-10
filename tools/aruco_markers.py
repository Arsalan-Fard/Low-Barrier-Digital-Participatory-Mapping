import argparse
from pathlib import Path

import cv2


DEFAULT_DICTIONARY = cv2.aruco.DICT_4X4_50


def get_dictionary(dictionary_name: str):
    dictionary_map = {
        "DICT_4X4_50": cv2.aruco.DICT_4X4_50,
        "DICT_4X4_100": cv2.aruco.DICT_4X4_100,
        "DICT_4X4_250": cv2.aruco.DICT_4X4_250,
        "DICT_4X4_1000": cv2.aruco.DICT_4X4_1000,
    }
    if dictionary_name not in dictionary_map:
        names = ", ".join(dictionary_map)
        raise ValueError(f"Unsupported dictionary '{dictionary_name}'. Choose from: {names}")
    return cv2.aruco.getPredefinedDictionary(dictionary_map[dictionary_name])


def generate_markers(output_dir: Path, marker_ids, marker_size: int, dictionary_name: str):
    output_dir.mkdir(parents=True, exist_ok=True)
    dictionary = get_dictionary(dictionary_name)

    for marker_id in marker_ids:
        marker_image = cv2.aruco.generateImageMarker(dictionary, marker_id, marker_size)
        padding = max(1, marker_size // 4)
        canvas = cv2.copyMakeBorder(
            marker_image,
            padding,
            padding,
            padding,
            padding,
            borderType=cv2.BORDER_CONSTANT,
            value=255,
        )
        output_path = output_dir / f"aruco_{marker_id}.png"
        cv2.imwrite(str(output_path), canvas)
        print(f"Saved marker {marker_id} to {output_path}")


def create_detector():
    parameters = cv2.aruco.DetectorParameters()
    return parameters


def detect_in_frame(frame, dictionary_name: str):
    dictionary = get_dictionary(dictionary_name)
    parameters = create_detector()

    if hasattr(cv2.aruco, "ArucoDetector"):
        detector = cv2.aruco.ArucoDetector(dictionary, parameters)
        corners, ids, rejected = detector.detectMarkers(frame)
    else:
        corners, ids, rejected = cv2.aruco.detectMarkers(frame, dictionary, parameters=parameters)

    output = frame.copy()
    if ids is not None and len(ids) > 0:
        cv2.aruco.drawDetectedMarkers(output, corners, ids)
        detected_ids = [int(value) for value in ids.flatten()]
        print(f"Detected marker ids: {detected_ids}")
    else:
        print("No markers detected.")

    return output, corners, ids, rejected


def detect_in_image(image_path: Path, dictionary_name: str, output_path: Path | None):
    frame = cv2.imread(str(image_path))
    if frame is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    detected_frame, _, _, _ = detect_in_frame(frame, dictionary_name)

    if output_path is not None:
        cv2.imwrite(str(output_path), detected_frame)
        print(f"Saved detection result to {output_path}")

    cv2.imshow("ArUco Detection", detected_frame)
    cv2.waitKey(0)
    cv2.destroyAllWindows()


def detect_in_camera(camera_index: int, dictionary_name: str):
    capture = cv2.VideoCapture(camera_index)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open camera index {camera_index}")

    print("Press 'q' to quit the live detector window.")
    while True:
        ok, frame = capture.read()
        if not ok:
            print("Failed to read a frame from the camera.")
            break

        detected_frame, _, _, _ = detect_in_frame(frame, dictionary_name)
        cv2.imshow("ArUco Live Detection", detected_frame)

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    capture.release()
    cv2.destroyAllWindows()


def parse_marker_ids(raw_ids: str):
    return [int(part.strip()) for part in raw_ids.split(",") if part.strip()]


def build_parser():
    parser = argparse.ArgumentParser(
        description="Generate and detect 4x4 ArUco markers with OpenCV."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    generate_parser = subparsers.add_parser("generate", help="Generate ArUco marker images.")
    generate_parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("aruco_output"),
        help="Folder where marker images will be written.",
    )
    generate_parser.add_argument(
        "--ids",
        default="0,1,2,3",
        help="Comma-separated marker ids to generate.",
    )
    generate_parser.add_argument(
        "--size",
        type=int,
        default=400,
        help="Marker image size in pixels.",
    )
    generate_parser.add_argument(
        "--dictionary",
        default="DICT_4X4_50",
        help="ArUco dictionary name.",
    )

    detect_parser = subparsers.add_parser("detect", help="Detect ArUco markers in an image.")
    detect_parser.add_argument("--image", type=Path, required=True, help="Input image path.")
    detect_parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Optional path for the annotated output image.",
    )
    detect_parser.add_argument(
        "--dictionary",
        default="DICT_4X4_50",
        help="ArUco dictionary name.",
    )

    live_parser = subparsers.add_parser("live", help="Detect ArUco markers from a webcam.")
    live_parser.add_argument(
        "--camera",
        type=int,
        default=0,
        help="Camera index to open.",
    )
    live_parser.add_argument(
        "--dictionary",
        default="DICT_4X4_50",
        help="ArUco dictionary name.",
    )

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "generate":
        marker_ids = parse_marker_ids(args.ids)
        generate_markers(args.output_dir, marker_ids, args.size, args.dictionary)
        return

    if args.command == "detect":
        detect_in_image(args.image, args.dictionary, args.output)
        return

    if args.command == "live":
        detect_in_camera(args.camera, args.dictionary)
        return

    parser.error("Unknown command")


if __name__ == "__main__":
    main()
