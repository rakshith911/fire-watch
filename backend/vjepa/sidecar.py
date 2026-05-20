"""
V-JEPA + CLIP sidecar — runs as a child process of the Node.js backend.
Loads VideoMAE-B (fire/smoke temporal), VideoMAE-L (V-JEPA ViT-H proxy, anomaly),
and CLIP ViT-L/14 (zero-shot semantic labels).
Communicates via stdin/stdout JSON lines.

Protocol (stdin → stdout):
  {"cmd": "ping"}
  {"cmd": "infer",         "frames_b64": [...], "model": "B"|"H"}
  {"cmd": "clip_classify", "image_b64": "...",  "prompts": [...]}   # optional prompts
  {"cmd": "anomaly_score", "frames_b64": [...], "camera_id": "...", "is_threat": false}
  {"cmd": "benchmark"}
"""

import sys, json, time, base64, io, os, traceback
import numpy as np
import psutil
import torch
import torch.nn.functional as F
from PIL import Image
from transformers import VideoMAEModel, AutoImageProcessor

# ── Device ──────────────────────────────────────────────────────────────────────
def get_device():
    if torch.backends.mps.is_available(): return torch.device("mps")
    if torch.cuda.is_available():         return torch.device("cuda")
    return torch.device("cpu")

_device = get_device()

# ── VideoMAE model registry ───────────────────────────────────────────────────
MODEL_IDS = {
    "B": "MCG-NJU/videomae-base",   # ViT-B  — fire/smoke tier-2
    "H": "MCG-NJU/videomae-large",  # ViT-L  — used as V-JEPA ViT-H proxy for anomaly
}

THREAT_CLASSES = ["no_fire", "smoke", "fire", "large_fire"]
NUM_FRAMES     = 16
IMAGENET_MEAN  = [0.485, 0.456, 0.406]
IMAGENET_STD   = [0.229, 0.224, 0.225]

_videomae_models = {}  # size -> (processor, encoder, head)

# ── CLIP registry ─────────────────────────────────────────────────────────────
_clip_model     = None
_clip_processor = None
CLIP_MODEL_ID   = "openai/clip-vit-large-patch14"

# Default zero-shot behavior prompts (used when caller doesn't supply prompts)
DEFAULT_PROMPTS = [
    # Mask / face covering
    "a person wearing a face mask, balaclava, ski mask, or any covering that hides their face and identity",
    # Knife / weapon
    "a person visibly holding, gripping, or carrying a knife, blade, or sharp weapon in their hand",
    # Dancing
    "a person dancing, with arms raised or moving, body swaying or stepping rhythmically to music",
    # Entering room
    "a person walking through a doorway, gate, or entrance, stepping into a room or building",
    # Suspicious / nervous
    "a person acting suspiciously — pacing, looking around nervously, hiding something, or behaving erratically",
    # Camera moved / scene change — no person required
    "the camera view was moved, rotated, or redirected, now showing a completely different area or scene",
    # Normal — always the last entry; label = None so no alert fires
    "a person sitting, standing, or walking normally with no unusual items or behavior",
]

DEFAULT_LABELS = [
    "Suspicious — person covering their face",
    "Someone carrying a knife or bladed weapon",
    "Someone appears to be dancing",
    "Someone entering the room",
    "Suspicious behavior detected",
    "Camera redirected to a different area",
    None,   # normal → no alert
]

CLIP_ALERT_THRESHOLD = 0.50  # ViT-L/14 is confident on real events; low scores (~0.4) are noise

# ── V-JEPA anomaly baselines (per camera) ────────────────────────────────────
_anomaly_baselines = {}  # camera_id -> {"mean": Tensor, "count": int}
BASELINE_MIN_SAMPLES = 10   # require N normal clips before scoring
BASELINE_ALPHA       = 0.02 # EMA update rate for normal-cycle baseline drift
ANOMALY_TRIGGER      = 0.28 # cosine distance above this = anomalous

# ── Utilities ─────────────────────────────────────────────────────────────────
def log(msg):
    print(f"[vjepa-sidecar] {msg}", file=sys.stderr, flush=True)

def respond(obj):
    print(json.dumps(obj), flush=True)

def _mem_mb():
    return psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024

# ── VideoMAE loader ───────────────────────────────────────────────────────────
def load_videomae(size: str):
    if size in _videomae_models:
        return _videomae_models[size]
    if size not in MODEL_IDS:
        raise ValueError(f"Unknown model size: {size}")

    log(f"Loading VideoMAE-{size} ({MODEL_IDS[size]})…")
    t0 = time.time(); m0 = _mem_mb()

    processor = AutoImageProcessor.from_pretrained(MODEL_IDS[size])
    encoder   = VideoMAEModel.from_pretrained(MODEL_IDS[size])
    encoder.eval().to(_device)
    hidden = encoder.config.hidden_size

    # Classification head (random weights — used for fire/smoke tier-2 only)
    head = torch.nn.Linear(hidden, len(THREAT_CLASSES))
    head.eval().to(_device)

    log(f"VideoMAE-{size} ready in {time.time()-t0:.1f}s | "
        f"RAM Δ {_mem_mb()-m0:.0f} MB | hidden={hidden}")

    _videomae_models[size] = (processor, encoder, head)
    return _videomae_models[size]

# ── CLIP loader ───────────────────────────────────────────────────────────────
def load_clip():
    global _clip_model, _clip_processor
    if _clip_model is not None:
        return
    from transformers import CLIPModel, CLIPProcessor
    log(f"Loading CLIP ViT-L/14 ({CLIP_MODEL_ID})…")
    t0 = time.time(); m0 = _mem_mb()
    _clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_ID)
    _clip_model     = CLIPModel.from_pretrained(CLIP_MODEL_ID)
    _clip_model.eval().to(_device)
    log(f"CLIP ViT-L/14 ready in {time.time()-t0:.1f}s | RAM Δ {_mem_mb()-m0:.0f} MB")

# ── Frame preprocessing ───────────────────────────────────────────────────────
def decode_frames(frames_b64: list) -> list:
    out = []
    for b64 in frames_b64:
        out.append(Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB"))
    return out

def sample_frames(images: list, n: int = NUM_FRAMES) -> list:
    if len(images) < n:
        return images + [images[-1]] * (n - len(images))
    if len(images) > n:
        idx = np.linspace(0, len(images) - 1, n, dtype=int)
        return [images[i] for i in idx]
    return images

# ── VideoMAE inference ────────────────────────────────────────────────────────
def _get_embedding(frames_b64: list, size: str) -> torch.Tensor:
    processor, encoder, _ = load_videomae(size)
    images = sample_frames(decode_frames(frames_b64))
    with torch.no_grad():
        pv = processor(images, return_tensors="pt")["pixel_values"].to(_device)
        out = encoder(pixel_values=pv)
        return out.last_hidden_state.mean(dim=1)[0]  # (hidden,)

def infer_clip_tier2(frames_b64: list, size: str) -> dict:
    """Fire/smoke classification using VideoMAE + random head (tier-2 temporal)."""
    processor, encoder, head = load_videomae(size)
    images = sample_frames(decode_frames(frames_b64))

    t0 = time.time()
    with torch.no_grad():
        pv   = processor(images, return_tensors="pt")["pixel_values"].to(_device)
        feat = encoder(pixel_values=pv).last_hidden_state.mean(dim=1)
        probs = torch.softmax(head(feat), dim=-1)[0].cpu().tolist()

    elapsed_ms = (time.time() - t0) * 1000
    pred_idx   = int(np.argmax(probs))

    return {
        "prediction":   THREAT_CLASSES[pred_idx],
        "confidence":   round(probs[pred_idx], 4),
        "probs":        {c: round(p, 4) for c, p in zip(THREAT_CLASSES, probs)},
        "inference_ms": round(elapsed_ms, 1),
        "device":       str(_device),
        "model":        size,
    }

# ── V-JEPA anomaly scoring ────────────────────────────────────────────────────
def compute_anomaly(camera_id: str, frames_b64: list, is_threat: bool = False) -> dict:
    """
    Compute cosine distance of current clip from camera's rolling baseline.
    Uses VideoMAE-B (ViT-B) — fast, CPU-friendly, ~86M params.
    Baseline is updated only during non-threat cycles, giving a per-camera
    'normal scene' reference. Distance > ANOMALY_TRIGGER = unusual activity.
    """
    t0 = time.time()
    embedding = _get_embedding(frames_b64, "H")
    elapsed_ms = (time.time() - t0) * 1000

    state = _anomaly_baselines.get(camera_id)

    if state is None:
        _anomaly_baselines[camera_id] = {"mean": embedding.detach().clone(), "count": 1}
        log(f"[anomaly] camera={camera_id} first sample — baseline initialised | {elapsed_ms:.0f}ms")
        return {
            "anomaly_score":    0.0,
            "anomaly_trigger":  False,
            "baseline_ready":   False,
            "baseline_samples": 1,
            "inference_ms":     round(elapsed_ms, 1),
        }

    baseline = state["mean"]
    count    = state["count"]

    cos_sim       = F.cosine_similarity(embedding.unsqueeze(0), baseline.unsqueeze(0)).item()
    anomaly_score = max(0.0, 1.0 - cos_sim)
    triggered     = anomaly_score > ANOMALY_TRIGGER
    baseline_ready = count >= BASELINE_MIN_SAMPLES

    log(f"[anomaly] camera={camera_id} score={anomaly_score:.4f} "
        f"threshold={ANOMALY_TRIGGER} trigger={'YES' if triggered else 'no'} "
        f"baseline_ready={baseline_ready} samples={count} "
        f"is_threat={is_threat} {elapsed_ms:.0f}ms")

    # Update baseline during normal cycles only
    if not is_threat:
        new_mean = (1.0 - BASELINE_ALPHA) * baseline + BASELINE_ALPHA * embedding.detach()
        _anomaly_baselines[camera_id] = {"mean": new_mean, "count": min(count + 1, 9999)}

    return {
        "anomaly_score":    round(anomaly_score, 4),
        "anomaly_trigger":  triggered,
        "baseline_ready":   baseline_ready,
        "baseline_samples": count,
        "inference_ms":     round(elapsed_ms, 1),
    }

# ── CLIP zero-shot classification ─────────────────────────────────────────────
def clip_classify(image_b64: str, prompts: list) -> dict:
    """Classify a single frame against text prompts."""
    load_clip()
    image = Image.open(io.BytesIO(base64.b64decode(image_b64))).convert("RGB")

    t0 = time.time()
    with torch.no_grad():
        inputs = _clip_processor(text=prompts, images=image, return_tensors="pt", padding=True)
        inputs = {k: v.to(_device) for k, v in inputs.items()}
        probs  = _clip_model(**inputs).logits_per_image.softmax(dim=-1)[0].cpu().tolist()

    elapsed_ms = (time.time() - t0) * 1000
    top_idx    = int(np.argmax(probs))
    return {
        "top_idx":      top_idx,
        "top_prompt":   prompts[top_idx],
        "top_prob":     round(probs[top_idx], 4),
        "probs":        [round(p, 4) for p in probs],
        "inference_ms": round(elapsed_ms, 1),
    }


def clip_classify_sequence(frames_b64: list, prompts: list) -> dict:
    """
    Classify a clip (multiple frames) by building a temporal composite image.
    Picks 3 evenly-spaced frames, tiles them side-by-side at 224px height,
    then runs a single CLIP forward pass on the composite.
    This gives CLIP visibility into motion and temporal change — critical for
    actions like dancing, entering, or carrying something across frames.
    """
    load_clip()

    # Sample 3 representative frames: start, middle, end
    n = len(frames_b64)
    indices = [0, n // 2, n - 1] if n >= 3 else list(range(n))
    images  = [Image.open(io.BytesIO(base64.b64decode(frames_b64[i]))).convert("RGB") for i in indices]

    # Resize all to the same height, then tile horizontally
    target_h = 224
    resized  = []
    for img in images:
        w, h  = img.size
        new_w = max(1, int(w * target_h / h))
        resized.append(img.resize((new_w, target_h), Image.LANCZOS))

    total_w   = sum(img.width for img in resized)
    composite = Image.new("RGB", (total_w, target_h))
    x = 0
    for img in resized:
        composite.paste(img, (x, 0))
        x += img.width

    t0 = time.time()
    with torch.no_grad():
        inputs = _clip_processor(text=prompts, images=composite, return_tensors="pt", padding=True)
        inputs = {k: v.to(_device) for k, v in inputs.items()}
        probs  = _clip_model(**inputs).logits_per_image.softmax(dim=-1)[0].cpu().tolist()

    elapsed_ms = (time.time() - t0) * 1000
    top_idx    = int(np.argmax(probs))
    log(f"[clip_seq] top={prompts[top_idx][:60]!r} prob={probs[top_idx]:.3f} "
        f"frames={len(indices)} {elapsed_ms:.0f}ms")
    return {
        "top_idx":      top_idx,
        "top_prompt":   prompts[top_idx],
        "top_prob":     round(probs[top_idx], 4),
        "probs":        [round(p, 4) for p in probs],
        "inference_ms": round(elapsed_ms, 1),
        "frame_count":  len(indices),
    }

# ── Benchmark ─────────────────────────────────────────────────────────────────
def benchmark() -> dict:
    dummy_img = Image.fromarray(np.random.randint(0, 255, (224, 224, 3), dtype=np.uint8))
    buf = io.BytesIO()
    dummy_img.save(buf, format="JPEG", quality=85)
    b64 = base64.b64encode(buf.getvalue()).decode()
    frames = [b64] * NUM_FRAMES

    results = {}
    for size in ["B", "H"]:
        m0 = _mem_mb(); load_videomae(size); m1 = _mem_mb()
        infer_clip_tier2(frames, size)  # warm-up
        times = [infer_clip_tier2(frames, size)["inference_ms"] for _ in range(3)]
        results[size] = {
            "model_id":          MODEL_IDS[size],
            "ram_delta_mb":      round(m1 - m0, 1),
            "inference_ms_avg":  round(sum(times) / len(times), 1),
            "inference_ms_min":  round(min(times), 1),
            "inference_ms_max":  round(max(times), 1),
        }

    # CLIP benchmark
    load_clip()
    res = clip_classify(b64, DEFAULT_PROMPTS)
    results["clip"] = {
        "model_id":         CLIP_MODEL_ID,
        "inference_ms_avg": res["inference_ms"],
    }

    return results

# ── Main loop ──────────────────────────────────────────────────────────────────
def main():
    log(f"Starting on device: {_device} | Python {sys.version.split()[0]}")

    for size in ["B", "H"]:
        try:
            load_videomae(size)
        except Exception as e:
            log(f"Failed to pre-load VideoMAE-{size}: {e}")

    try:
        load_clip()
    except Exception as e:
        log(f"Failed to pre-load CLIP: {e}")

    respond({"ok": True, "event": "ready", "device": str(_device)})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
            cmd = msg.get("cmd")

            if cmd == "ping":
                respond({"ok": True, "pong": True})

            elif cmd == "infer":
                size       = msg.get("model", "B").upper()
                frames_b64 = msg.get("frames_b64", [])
                if not frames_b64:
                    respond({"ok": False, "error": "No frames provided"}); continue
                result = infer_clip_tier2(frames_b64, size)
                respond({"ok": True, **result})

            elif cmd == "clip_classify":
                image_b64 = msg.get("image_b64")
                if not image_b64:
                    respond({"ok": False, "error": "No image provided"}); continue
                prompts = msg.get("prompts") or DEFAULT_PROMPTS
                labels  = msg.get("labels")  or DEFAULT_LABELS
                result  = clip_classify(image_b64, prompts)
                top_label = labels[result["top_idx"]] if labels and result["top_idx"] < len(labels) else None
                if result["top_prob"] < CLIP_ALERT_THRESHOLD:
                    top_label = None
                respond({"ok": True, "label": top_label, **result})

            elif cmd == "clip_classify_sequence":
                frames_b64 = msg.get("frames_b64", [])
                if not frames_b64:
                    respond({"ok": False, "error": "No frames provided"}); continue
                prompts = msg.get("prompts") or DEFAULT_PROMPTS
                labels  = msg.get("labels")  or DEFAULT_LABELS
                result  = clip_classify_sequence(frames_b64, prompts)
                top_label = labels[result["top_idx"]] if labels and result["top_idx"] < len(labels) else None
                if result["top_prob"] < CLIP_ALERT_THRESHOLD:
                    top_label = None
                respond({"ok": True, "label": top_label, **result})

            elif cmd == "anomaly_score":
                camera_id  = str(msg.get("camera_id", "default"))
                frames_b64 = msg.get("frames_b64", [])
                is_threat  = bool(msg.get("is_threat", False))
                if not frames_b64:
                    respond({"ok": False, "error": "No frames provided"}); continue
                result = compute_anomaly(camera_id, frames_b64, is_threat)
                respond({"ok": True, **result})

            elif cmd == "benchmark":
                respond({"ok": True, "benchmark": benchmark()})

            else:
                respond({"ok": False, "error": f"Unknown cmd: {cmd}"})

        except Exception as e:
            respond({"ok": False, "error": str(e), "trace": traceback.format_exc()})

if __name__ == "__main__":
    main()
