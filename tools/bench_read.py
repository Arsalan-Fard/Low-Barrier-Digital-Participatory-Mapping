"""Measure the raw frame-delivery rate of the camera source — nothing but
cap.read() in a tight loop. No detection, no threads, no Flask. This is the
hard ceiling on frames/sec; the app can never exceed it.

Also reports how many consecutive reads returned the SAME frame buffer (a sign
the backend is handing us duplicates faster than the device produces them).

Run: py -3.13 bench_read.py [source]
"""
import sys
import time

import cv2

SOURCE = sys.argv[1] if len(sys.argv) > 1 else "http://10.209.109.18:8080/video"
try:
    SOURCE = int(SOURCE)
except ValueError:
    pass
SECONDS = 8.0


def main():
    print(f"OpenCV {cv2.__version__}  source={SOURCE}", flush=True)
    cap = cv2.VideoCapture(SOURCE)
    try:
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    except Exception:
        pass
    if not cap.isOpened():
        print("Could not open source"); return

    ok, prev = cap.read()
    if not ok:
        print("Could not read a frame"); return
    print(f"frame size: {prev.shape[1]}x{prev.shape[0]}", flush=True)

    reads = 0
    dups = 0
    read_ms = []
    prev_sum = int(prev[::37, ::37, 0].sum())  # cheap fingerprint
    t_end = time.perf_counter() + SECONDS
    while time.perf_counter() < t_end:
        t0 = time.perf_counter()
        ok, frame = cap.read()
        dt = (time.perf_counter() - t0) * 1000.0
        if not ok or frame is None:
            continue
        read_ms.append(dt)
        reads += 1
        cur_sum = int(frame[::37, ::37, 0].sum())
        if cur_sum == prev_sum:
            dups += 1
        prev_sum = cur_sum

    cap.release()
    if not read_ms:
        print("No reads"); return
    read_ms.sort()
    avg = sum(read_ms) / len(read_ms)
    print(f"\nreads={reads} in {SECONDS:.0f}s")
    print(f"  raw read() rate:     {reads / SECONDS:5.1f} fps")
    print(f"  unique-frame rate:   {(reads - dups) / SECONDS:5.1f} fps   "
          f"(duplicates: {dups} = {100*dups/reads:.0f}%)")
    print(f"  read() avg={avg:.1f}ms  median={read_ms[len(read_ms)//2]:.1f}ms  "
          f"max={read_ms[-1]:.1f}ms")


if __name__ == "__main__":
    main()
