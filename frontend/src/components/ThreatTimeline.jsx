import React, { useEffect, useRef, useState } from "react";

const WINDOW_MS = 5 * 60 * 1000; // 5-minute rolling window
const TICK_COUNT = 6; // time axis ticks (0:00 … 5:00)

const CATEGORIES = [
  { key: "fire",     label: "Fire/Smoke", threats: ["smoke", "small_fire", "large_fire", "fire"] },
  { key: "weapon",   label: "Weapon",     threats: ["weapon", "weapon_threat"] },
  { key: "behavior", label: "Behavior",   threats: ["face_covered", "loitering"] },
];

const THREAT_COLOR = {
  smoke:        "#ffb86c",
  small_fire:   "#f97316",
  large_fire:   "#ff5555",
  fire:         "#f97316",
  weapon:       "#8be9fd",
  weapon_threat:"#ff5555",
  face_covered: "#bd93f9",
  loitering:    "#8be9fd",
};

const THREAT_LABEL = {
  smoke:        "Smoke",
  small_fire:   "Fire",
  large_fire:   "Fire (Large)",
  fire:         "Fire",
  weapon:       "Weapon",
  weapon_threat:"Weapon (Threat)",
  face_covered: "Face Covered",
  loitering:    "Loitering",
};

function pct(ts, now) {
  return Math.max(0, Math.min(100, ((ts - (now - WINDOW_MS)) / WINDOW_MS) * 100));
}

function formatRelative(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `-${m}:${ss.toString().padStart(2, "0")}`;
}

export default function ThreatTimeline({ events }) {
  const [now, setNow] = useState(Date.now());
  const rafRef = useRef(null);

  // Tick every second to advance the sliding window
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      rafRef.current = setTimeout(tick, 1000);
    };
    rafRef.current = setTimeout(tick, 1000);
    return () => clearTimeout(rafRef.current);
  }, []);

  const windowStart = now - WINDOW_MS;
  const visibleEvents = events.filter(
    (e) => (e.endTime ?? now) >= windowStart
  );

  // Which category rows actually have data
  const activeCategories = CATEGORIES.filter((cat) =>
    visibleEvents.some((e) => cat.threats.includes(e.category))
  );

  const rows = activeCategories.length > 0 ? activeCategories : [CATEGORIES[0]];

  // Time axis ticks: evenly spaced from -5:00 to now
  const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
    const offset = (i / (TICK_COUNT - 1)) * WINDOW_MS;
    return { pct: (offset / WINDOW_MS) * 100, label: formatRelative(WINDOW_MS - offset) };
  });
  ticks[ticks.length - 1].label = "now";

  return (
    <div className="threat-timeline">
      <div className="tt-rows">
        {rows.map((cat) => {
          const rowEvents = visibleEvents.filter((e) =>
            cat.threats.includes(e.category)
          );
          return (
            <div className="tt-row" key={cat.key}>
              <div className="tt-row-label">{cat.label}</div>
              <div className="tt-track">
                {rowEvents.map((e) => {
                  const left = pct(Math.max(e.startTime, windowStart), now);
                  const right = 100 - pct(e.endTime ?? now, now);
                  const color = THREAT_COLOR[e.category] || "#6272a4";
                  const label = THREAT_LABEL[e.category] || e.alertType;
                  const conf = e.confidence != null
                    ? ` · ${Math.round(e.confidence * 100)}%`
                    : "";
                  const ongoing = e.endTime == null;
                  return (
                    <div
                      key={e.id}
                      className={`tt-segment${ongoing ? " tt-segment--live" : ""}`}
                      style={{ left: `${left}%`, right: `${right}%`, background: color }}
                      title={`${label}${conf}`}
                    >
                      <span className="tt-seg-label">{label}{conf}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="tt-axis">
        {ticks.map((t, i) => (
          <div
            key={i}
            className="tt-tick"
            style={{ left: `${t.pct}%` }}
          >
            <div className="tt-tick-line" />
            <span className="tt-tick-label">{t.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
