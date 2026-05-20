/**
 * byteTracker.js — ByteTrack multi-object tracker
 *
 * Assigns stable IDs to detections across frames using IoU-based matching
 * and Hungarian assignment. Detections become "confirmed" after MIN_HITS
 * consecutive matches. Tracks expire after MAX_AGE missed frames.
 *
 * Detection format (YOLO output): [x1, y1, x2, y2, label, score]
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const MIN_HITS      = 2;    // frames before a track is confirmed
const MAX_AGE       = 10;   // frames before a lost track is removed
const HIGH_THRESH   = 0.5;  // high-confidence gate
const LOW_THRESH    = 0.1;  // low-confidence gate (ByteTrack second association)
const IOU_THRESH    = 0.25; // minimum IoU to accept a match

// ── IoU ───────────────────────────────────────────────────────────────────────
function iou(a, b) {
  const xi1 = Math.max(a[0], b[0]);
  const yi1 = Math.max(a[1], b[1]);
  const xi2 = Math.min(a[2], b[2]);
  const yi2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, xi2 - xi1) * Math.max(0, yi2 - yi1);
  const aA = (a[2] - a[0]) * (a[3] - a[1]);
  const bA = (b[2] - b[0]) * (b[3] - b[1]);
  const union = aA + bA - inter;
  return union > 0 ? inter / union : 0;
}

// ── Hungarian assignment (minimise cost, O(n³)) ───────────────────────────────
// Returns array of [row, col] pairs for the optimal assignment.
function hungarian(cost) {
  const rows = cost.length;
  if (rows === 0) return [];
  const cols = cost[0].length;
  if (cols === 0) return [];

  const INF = 1e9;
  const n   = Math.max(rows, cols);

  // Pad to square
  const C = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      i < rows && j < cols ? cost[i][j] : INF
    )
  );

  const u   = new Array(n + 1).fill(0);
  const v   = new Array(n + 1).fill(0);
  const p   = new Array(n + 1).fill(0); // p[j] = row assigned to col j (1-indexed)
  const way = new Array(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minDist = new Array(n + 1).fill(INF);
    const used    = new Array(n + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;

      for (let j = 1; j <= n; j++) {
        if (!used[j]) {
          const cur = C[i0 - 1][j - 1] - u[i0] - v[j];
          if (cur < minDist[j]) { minDist[j] = cur; way[j] = j0; }
          if (minDist[j] < delta) { delta = minDist[j]; j1 = j; }
        }
      }

      if (j1 === -1) break; // all columns exhausted
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else          { minDist[j] -= delta; }
      }

      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const result = [];
  for (let j = 1; j <= cols; j++) {
    if (p[j] > 0 && p[j] <= rows) result.push([p[j] - 1, j - 1]);
  }
  return result;
}

// ── Track ─────────────────────────────────────────────────────────────────────
let _nextId = 1;

class Track {
  constructor(det, opts) {
    this.id             = _nextId++;
    this.box            = det.box;   // [x1, y1, x2, y2]
    this.score          = det.score;
    this.label          = det.label;
    this.hitStreak      = 1;
    this.timeSinceUpdate = 0;
    this.state          = "tentative"; // tentative | confirmed | lost
    this._minHits       = opts.minHits;
    this._maxAge        = opts.maxAge;
  }

  update(det) {
    this.box            = det.box;
    this.score          = det.score;
    this.label          = det.label;
    this.hitStreak++;
    this.timeSinceUpdate = 0;
    if (this.hitStreak >= this._minHits) this.state = "confirmed";
  }

  markMissed() {
    this.timeSinceUpdate++;
    this.hitStreak = 0;
    if (this.state === "tentative" || this.timeSinceUpdate > this._maxAge) {
      this.state = "lost";
    }
  }

  isLost()      { return this.state === "lost"; }
  isConfirmed() { return this.state === "confirmed"; }
}

// ── ByteTracker ───────────────────────────────────────────────────────────────
export class ByteTracker {
  constructor(opts = {}) {
    this.tracks     = [];
    this.minHits    = opts.minHits    ?? MIN_HITS;
    this.maxAge     = opts.maxAge     ?? MAX_AGE;
    this.iouThresh  = opts.iouThresh  ?? IOU_THRESH;
    this.highThresh = opts.highThresh ?? HIGH_THRESH;
    this.lowThresh  = opts.lowThresh  ?? LOW_THRESH;
  }

  /**
   * Feed one frame's YOLO detections into the tracker.
   * @param {Array} rawDets - array of [x1, y1, x2, y2, label, score]
   * @returns {Track[]} all active (non-lost) tracks after update
   */
  update(rawDets = []) {
    // Normalise to {box, score, label}
    const all  = rawDets.map(d => ({ box: [d[0], d[1], d[2], d[3]], label: d[4], score: d[5] }));
    const high = all.filter(d => d.score >= this.highThresh);
    const low  = all.filter(d => d.score >= this.lowThresh && d.score < this.highThresh);

    const active = this.tracks.filter(t => !t.isLost());

    // ── First association: high-confidence dets ↔ all active tracks ───────────
    const { matched: m1, unmatchedTracks: ut1, unmatchedDets: ud1 } =
      this._associate(active, high);

    for (const [ti, di] of m1) active[ti].update(high[di]);

    // ── Second association: remaining tracks ↔ low-confidence dets ────────────
    const remaining = ut1.map(i => active[i]);
    const { matched: m2, unmatchedTracks: ut2 } =
      this._associate(remaining, low);

    for (const [ti, di] of m2) remaining[ti].update(low[di]);
    for (const ti of ut2)       remaining[ti].markMissed();

    // Tracks that were fully unmatched in first pass but not in remaining:
    // mark them missed only if they weren't matched in m2
    const matchedRemainingIdx = new Set(m2.map(([ti]) => ti));
    for (let i = 0; i < remaining.length; i++) {
      if (!matchedRemainingIdx.has(i) && !ut2.includes(i)) {
        // already handled — skip (matched in m2 already called update)
      }
    }

    // ── Spawn new tracks from unmatched high-confidence dets ─────────────────
    for (const di of ud1) {
      this.tracks.push(new Track(high[di], { minHits: this.minHits, maxAge: this.maxAge }));
    }

    // ── Prune lost tracks ─────────────────────────────────────────────────────
    this.tracks = this.tracks.filter(t => !t.isLost());

    return this.tracks.filter(t => !t.isLost());
  }

  /** Return only tracks that have been confirmed (seen in ≥ minHits frames). */
  getConfirmedTracks() {
    return this.tracks.filter(t => t.isConfirmed());
  }

  /** Wipe all tracks (e.g. when a camera is removed). */
  reset() {
    this.tracks = [];
  }

  // ── Internal: IoU-based Hungarian matching ──────────────────────────────────
  _associate(tracks, dets) {
    if (tracks.length === 0 || dets.length === 0) {
      return {
        matched:        [],
        unmatchedTracks: tracks.map((_, i) => i),
        unmatchedDets:   dets.map(  (_, i) => i),
      };
    }

    // Cost matrix: 1 - IoU (so we minimise → maximise IoU)
    const cost = tracks.map(t => dets.map(d => 1 - iou(t.box, d.box)));
    const pairs = hungarian(cost);

    const matched = [];
    const usedT   = new Set();
    const usedD   = new Set();

    for (const [ti, di] of pairs) {
      if (cost[ti][di] > 1 - this.iouThresh) continue; // IoU too low
      matched.push([ti, di]);
      usedT.add(ti);
      usedD.add(di);
    }

    return {
      matched,
      unmatchedTracks: tracks.map((_, i) => i).filter(i => !usedT.has(i)),
      unmatchedDets:   dets.map(  (_, i) => i).filter(i => !usedD.has(i)),
    };
  }
}
