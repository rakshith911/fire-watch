"""
Trial run: extract frames from each video and run V-JEPA S + B on them.
Usage: python3 scripts/trial_vjepa.py
"""

import sys, os, base64, io, json, time
import numpy as np
from PIL import Image

# Add vjepa dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../vjepa"))

FFMPEG = os.path.join(os.path.dirname(__file__), "../../backend/node_modules/ffmpeg-static/ffmpeg")
if not os.path.exists(FFMPEG):
    FFMPEG = "ffmpeg"  # fall back to system ffmpeg

VIDEOS = {
    "fireVideo.mp4": "/Users/rakshith911/fire-watch/vids/fireVideo.mp4",
    "fire2.mp4":     "/Users/rakshith911/fire-watch/vids/fire2.mp4",
    "fire3.mp4":     "/Users/rakshith911/fire-watch/vids/fire3.mp4",
    "no-fire.mp4":   "/Users/rakshith911/fire-watch/vids/no-fire.mp4",
}

NUM_FRAMES = 16

def extract_frames(video_path: str, num_frames: int = NUM_FRAMES) -> list:
    """Extract evenly-spaced frames from a video using ffmpeg, return as PIL Images."""
    import subprocess, tempfile, glob

    with tempfile.TemporaryDirectory() as tmpdir:
        out_pattern = os.path.join(tmpdir, "frame_%04d.jpg")
        cmd = [
            FFMPEG, "-i", video_path,
            "-vf", f"select=not(mod(n\\,3)),setpts=N/FRAME_RATE/TB",
            "-vsync", "vfr",
            "-q:v", "3",
            out_pattern, "-y", "-loglevel", "error"
        ]
        subprocess.run(cmd, check=True)
        frames_paths = sorted(glob.glob(os.path.join(tmpdir, "*.jpg")))

        if not frames_paths:
            raise RuntimeError(f"No frames extracted from {video_path}")

        # Sample evenly to get exactly num_frames
        indices = np.linspace(0, len(frames_paths) - 1, num_frames, dtype=int)
        images = [Image.open(frames_paths[i]).convert("RGB") for i in indices]
        return images

def frames_to_b64(images: list) -> list:
    result = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        result.append(base64.b64encode(buf.getvalue()).decode())
    return result

def run_trial():
    # Import sidecar internals directly (no subprocess needed for trial)
    import torch
    from sidecar import load_model, infer, THREAT_CLASSES, _device

    print(f"\n{'='*60}")
    print(f"  V-JEPA Trial Run  |  Device: {_device}")
    print(f"{'='*60}\n")

    # Pre-load both models
    print("Loading models...")
    for size in ["S", "B"]:
        load_model(size)
    print("✅ Both models loaded\n")

    results = {}

    for video_name, video_path in VIDEOS.items():
        print(f"📹 {video_name}")
        print(f"   Extracting {NUM_FRAMES} frames...")
        try:
            images = extract_frames(video_path)
            frames_b64 = frames_to_b64(images)

            print(f"   Running V-JEPA S...", end=" ", flush=True)
            res_s = infer("S", frames_b64)
            print(f"{res_s['inference_ms']}ms")

            print(f"   Running V-JEPA B...", end=" ", flush=True)
            res_b = infer("B", frames_b64)
            print(f"{res_b['inference_ms']}ms")

            results[video_name] = {"S": res_s, "B": res_b}

            print(f"\n   ┌─────────────────────────────────────────────┐")
            print(f"   │  {video_name:<43}│")
            print(f"   ├──────────┬──────────────┬──────────┬─────────┤")
            print(f"   │  Model   │  Prediction  │  Conf    │   ms    │")
            print(f"   ├──────────┼──────────────┼──────────┼─────────┤")
            for size, res in [("S", res_s), ("B", res_b)]:
                pred = res["prediction"]
                conf = f"{res['confidence']*100:.1f}%"
                ms   = f"{res['inference_ms']}"
                pt   = "" if res["pretrained"] else "*"
                print(f"   │  ViT-{size}{pt}   │ {pred:<12} │ {conf:<8} │ {ms:<7} │")
            print(f"   ├──────────┴──────────────┴──────────┴─────────┤")
            # Show full prob breakdown for ViT-B
            print(f"   │  ViT-B class probabilities:                   │")
            for cls, prob in res_b["probs"].items():
                bar = "█" * int(prob * 20)
                print(f"   │    {cls:<12} {prob*100:5.1f}%  {bar:<20}│")
            print(f"   └─────────────────────────────────────────────┘\n")

        except Exception as e:
            print(f"   ❌ Error: {e}\n")

    print("\n* ViT-S uses random weights (architecture benchmark only)")
    print("  ViT-B uses pretrained VideoMAE weights")
    print("\nNote: predictions are from an UNTRAINED classification head.")
    print("Once fine-tuned on fire/smoke data, these will be accurate.\n")

if __name__ == "__main__":
    run_trial()
