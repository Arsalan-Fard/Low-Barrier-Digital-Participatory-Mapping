"""Compress backend camera/audio recordings into single MP4 files.

The app records each session as:
  backend_recordings/<recording_name>/segment_0001_camera_feed.avi
  backend_recordings/<recording_name>/segment_0001_microphone.wav

Legacy camera_feed.avi/microphone.wav sessions are still supported. This script
combines each pair into one smaller H.264/AAC MP4 file. It needs FFmpeg installed
and available on PATH, or imageio-ffmpeg installed as a Python fallback.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent  # repo root (this script lives in tools/)
DEFAULT_RECORDINGS_DIR = ROOT / "backend_recordings"


@dataclass(frozen=True)
class Recording:
    directory: Path
    video: Path
    audio: Path | None
    output_name: str | None = None

    @property
    def output(self) -> Path:
        return self.directory / (self.output_name or f"{self.directory.name}.mp4")


def find_ffmpeg() -> str:
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg

    try:
        import imageio_ffmpeg  # type: ignore
    except ImportError:
        imageio_ffmpeg = None

    if imageio_ffmpeg is not None:
        return imageio_ffmpeg.get_ffmpeg_exe()

    raise RuntimeError(
        "FFmpeg was not found. Install FFmpeg and add it to PATH, or install "
        "the Python fallback with: python -m pip install imageio-ffmpeg"
    )


def iter_recordings(recordings_dir: Path) -> list[Recording]:
    recordings: list[Recording] = []
    for directory in sorted(path for path in recordings_dir.iterdir() if path.is_dir()):
        video = directory / "camera_feed.avi"
        audio = directory / "microphone.wav"
        if video.exists():
            recordings.append(
                Recording(
                    directory=directory,
                    video=video,
                    audio=audio if audio.exists() and audio.stat().st_size > 44 else None,
                )
            )

        for video in sorted(directory.glob("segment_*_camera_feed.avi")):
            segment_name = video.name.removesuffix("_camera_feed.avi")
            audio = directory / f"{segment_name}_microphone.wav"
            recordings.append(
                Recording(
                    directory=directory,
                    video=video,
                    audio=audio if audio.exists() and audio.stat().st_size > 44 else None,
                    output_name=f"{segment_name}.mp4",
                )
            )
    return recordings


def build_ffmpeg_command(
    ffmpeg: str,
    recording: Recording,
    output: Path,
    *,
    crf: int,
    preset: str,
    audio_bitrate: str,
    max_width: int,
    max_height: int,
    overwrite: bool,
) -> list[str]:
    command = [ffmpeg, "-hide_banner", "-y" if overwrite else "-n", "-i", str(recording.video)]

    if recording.audio is not None:
        command.extend(["-i", str(recording.audio), "-map", "0:v:0", "-map", "1:a:0", "-shortest"])
    else:
        command.extend(["-map", "0:v:0"])

    command.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            str(crf),
            "-pix_fmt",
            "yuv420p",
        ]
    )

    if max_width > 0 and max_height > 0:
        command.extend(
            [
                "-vf",
                f"scale={max_width}:{max_height}:force_original_aspect_ratio=decrease,setsar=1",
            ]
        )

    if recording.audio is not None:
        command.extend(["-c:a", "aac", "-b:a", audio_bitrate])

    command.extend(
        [
            "-movflags",
            "+faststart",
            "-metadata",
            f"title={recording.directory.name}",
            str(output),
        ]
    )
    return command


def convert_recording(
    ffmpeg: str,
    recording: Recording,
    *,
    crf: int,
    preset: str,
    audio_bitrate: str,
    max_width: int,
    max_height: int,
    overwrite: bool,
    dry_run: bool,
) -> bool:
    output = recording.output
    if output.exists() and not overwrite:
        print(f"Skipping existing file: {output}")
        return True

    command = build_ffmpeg_command(
        ffmpeg,
        recording,
        output,
        crf=crf,
        preset=preset,
        audio_bitrate=audio_bitrate,
        max_width=max_width,
        max_height=max_height,
        overwrite=overwrite,
    )

    print(f"Converting {recording.directory.name} -> {output.name}")
    if dry_run:
        print("  " + " ".join(command))
        return True

    result = subprocess.run(command, text=True)
    if result.returncode != 0:
        print(f"Failed: {recording.directory.name}", file=sys.stderr)
        return False

    original_size = recording.video.stat().st_size
    if recording.audio is not None:
        original_size += recording.audio.stat().st_size
    output_size = output.stat().st_size
    ratio = output_size / original_size if original_size else 0
    print(f"  Saved {output_size / 1024 / 1024:.1f} MB ({ratio:.0%} of original)")
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert backend_recordings AVI/WAV pairs into smaller MP4 files."
    )
    parser.add_argument(
        "recordings_dir",
        nargs="?",
        type=Path,
        default=DEFAULT_RECORDINGS_DIR,
        help="Directory containing recording_* folders. Defaults to ./backend_recordings.",
    )
    parser.add_argument("--crf", type=int, default=28, help="H.264 quality. Lower is higher quality/larger. Default: 28.")
    parser.add_argument("--preset", default="medium", help="FFmpeg x264 preset. Default: medium.")
    parser.add_argument("--audio-bitrate", default="96k", help="AAC audio bitrate. Default: 96k.")
    parser.add_argument("--max-width", type=int, default=1280, help="Output width limit. Use 0 with --max-height 0 to keep original size.")
    parser.add_argument("--max-height", type=int, default=720, help="Output height limit. Use 0 with --max-width 0 to keep original size.")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing MP4 outputs.")
    parser.add_argument("--dry-run", action="store_true", help="Print FFmpeg commands without converting.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    recordings_dir = args.recordings_dir.resolve()
    if not recordings_dir.exists():
        print(f"Recordings directory does not exist: {recordings_dir}", file=sys.stderr)
        return 2

    try:
        ffmpeg = find_ffmpeg()
    except RuntimeError as exc:
        if args.dry_run:
            print(f"{exc}\nShowing commands with placeholder executable: ffmpeg", file=sys.stderr)
            ffmpeg = "ffmpeg"
        else:
            print(str(exc), file=sys.stderr)
            return 2

    recordings = iter_recordings(recordings_dir)
    if not recordings:
        print(f"No camera_feed.avi files found under: {recordings_dir}")
        return 0

    failures = 0
    for recording in recordings:
        ok = convert_recording(
            ffmpeg,
            recording,
            crf=args.crf,
            preset=args.preset,
            audio_bitrate=args.audio_bitrate,
            max_width=args.max_width,
            max_height=args.max_height,
            overwrite=args.overwrite,
            dry_run=args.dry_run,
        )
        failures += 0 if ok else 1

    if failures:
        print(f"Completed with {failures} failed conversion(s).", file=sys.stderr)
        return 1

    print("All conversions completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
