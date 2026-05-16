import React from "react";

const WEAPON_LABELS = ["Knife"];

export default function FireStatusButton({ isFire, alertType }) {
  const isWeapon = alertType && WEAPON_LABELS.includes(alertType);
  const statusClass = isFire
    ? isWeapon
      ? "weapon"
      : "fire"
    : "clear";
  const label = isFire
    ? isWeapon
      ? alertType.toUpperCase()
      : "FIRE"
    : "";

  return (
    <div className={`fire-status-btn ${statusClass}`}>
      {label}
    </div>
  );
}
