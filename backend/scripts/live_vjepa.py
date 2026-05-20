"""
Live stream trial: pull frames from an RTSP/local stream and run V-JEPA ViT-B on them.

Usage:
    python3 scripts/live_vjepa.py [stream_url]

Default stream: rtsp://127.0.0.1:8554/iphone
Press Ctrl+C to stop.
"""

import sys, os, base64, io, time, subprocess, threading, queue
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../vjepa"))

FFMPEG = os.path.join(os.path.dirname(__file__), "../../backend/node_modules/ffmpeg-static/ffmpeg")
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"

STREAM_URL = sys.argv[1] if len(sys.argv) > 1 else "rtsp://127.0.0.1:8554/iphone"
NUM_FRAMES = 16       # VideoMAE expects exactly 16
FRAME_RATE = 2        # fps to extract from stream (low enough to stay real-time)
CLIP_INTERVAL = 4.0   # seconds between inference runs

THREAT_CLASSES = ["no_fire", "smoke", "fire", "large_fire"]

THREAT_COLOR = {
    "no_fire":   "\033[32m",   # green
    "smoke":     "\033[33m",   # yellow
    "fire":      "\033[91m",   # bright red
    "large_fire":"\033[31m",   # red
}
RESET = "\033[0m"
BOLD  = "\033[1m"

frame_queue = queue.Queue(maxsize=64)


def frame_reader(stream_url: str):
    """Spawn ffmpeg to decode the stream at FRAME_RATE fps, push raw RGB24 frames into queue."""
    cmd = [
        FFMPEG,
        "-rtsp_transport", "tcp",
        "-i", stream_url,
        "-vf", f"fps={FRAME_RATE},scale=224:224",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-",
        "-loglevel", "error",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_size = 224 * 224 * 3
    print(f"[reader] Connected to {stream_url} at {FRAME_RATE} fps", flush=True)

    while True:
        raw = proc.stdout.read(frame_size)
        if len(raw) < frame_size:
            stderr_out = proc.stderr.read().decode(errors="replace")
            print(f"[reader] Stream ended or error: {stderr_out[:200]}", flush=True)
            break
        arr = np.frombuffer(raw, dtype=np.uint8).reshape((224, 224, 3))
        img = Image.fromarray(arr)
        try:
            frame_queue.put_nowait(img)
        except queue.Full:
            frame_queue.get_nowait()  # drop oldest
            frame_queue.put_nowait(img)

    proc.terminate()


def collect_clip() -> list:
    """Block until we have NUM_FRAMES, return as list of PIL Images."""
    frames = []
    while len(frames) < NUM_FRAMES:
        try:
            img = frame_queue.get(timeout=5.0)
            frames.append(img)
        except queue.Empty:
            if not reader_thread.is_alive():
                raise RuntimeError("Frame reader died — is the stream running?")
    return frames


def frames_to_b64(images: list) -> list:
    result = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        result.append(base64.b64encode(buf.getvalue()).decode())
    return result


def bar(prob: float, width: int = 20) -> str:
    filled = int(prob * width)
    return "█" * filled + "░" * (width - filled)


def run_live():
    from sidecar import load_model, infer, _device

    print(f"\n{'='*60}")
    print(f"  V-JEPA ViT-B  |  Live Stream Trial  |  Device: {_device}")
    print(f"  Stream: {STREAM_URL}")
    print(f"  Clip: {NUM_FRAMES} frames @ {FRAME_RATE} fps every ~{CLIP_INTERVAL}s")
    print(f"{'='*60}")
    print("  Loading ViT-B model (first run downloads ~350 MB)…", flush=True)

    load_model("B")
    print("  ✅ Model ready. Starting stream…\n")

    global reader_thread
    reader_thread = threading.Thread(target=frame_reader, args=(STREAM_URL,), daemon=True)
    reader_thread.start()

    clip_num = 0
    try:
        while True:
            t_start = time.time()

            # Wait until we have enough frames buffered
            while frame_queue.qsize() < NUM_FRAMES:
                if not reader_thread.is_alive():
                    print("Stream reader stopped. Exiting.")
                    return
                time.sleep(0.1)

            frames = collect_clip()
            frames_b64 = frames_to_b64(frames)

            res = infer("B", frames_b64)
            elapsed = time.time() - t_start

            pred  = res["prediction"]
            conf  = res["confidence"]
            ms    = res["inference_ms"]
            probs = res["probs"]
            color = THREAT_COLOR.get(pred, "")
            clip_num += 1

            print(f"  Clip #{clip_num:03d}  {color}{BOLD}{pred.upper():12}{RESET}  "
                  f"conf={conf*100:5.1f}%  infer={ms:.0f}ms  wall={elapsed:.1f}s")

            # Compact prob bar
            prob_parts = []
            for cls in THREAT_CLASSES:
                p = probs[cls]
                c = THREAT_COLOR.get(cls, "")
                prob_parts.append(f"{c}{cls}:{p*100:.0f}%{RESET}")
            print("           " + "  ".join(prob_parts))
            print()

            # Pace to CLIP_INTERVAL (drain queue if infer was fast)
            wait = CLIP_INTERVAL - (time.time() - t_start)
            if wait > 0:
                time.sleep(wait)
            else:
                # Drain stale frames so we always infer on fresh data
                drained = 0
                while not frame_queue.empty() and drained < NUM_FRAMES:
                    frame_queue.get_nowait()
                    drained += 1

    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    run_live()
