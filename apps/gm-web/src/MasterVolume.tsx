/**
 * MasterVolume — the GM's live master effects volume, sitting directly under the
 * Stage so it's at hand while watching the table. Persists across reloads and
 * re-applies to present players on mount (a reload restores the level rather than
 * snapping to full). Emits mixer:set; the server fans it to present players as
 * mixer:apply, scaling everything they hear.
 */
import { useEffect } from "react";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";
import { usePersistentState } from "./usePersistentState";

export function MasterVolume() {
  const [vol, setVol] = usePersistentState("mi.gm.sound.effectsVol", 1);

  function change(v: number) {
    setVol(v);
    socket.emit("mixer:set", { gain: v });
  }

  // Re-apply the saved level to present players when the panel (re)mounts.
  useEffect(() => {
    socket.emit("mixer:set", { gain: vol });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: space(3) }}>
        <label style={{ ...labelStyle, whiteSpace: "nowrap", minWidth: 110 }}>
          Effects volume {Math.round(vol * 100)}%
        </label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={vol}
          onChange={(e) => change(Number(e.target.value))}
          style={{ flex: 1, accentColor: palette.ember, cursor: "pointer" }}
          aria-label="Master effects volume"
        />
      </div>
    </section>
  );
}

const cardStyle: React.CSSProperties = {
  padding: `${space(4)} ${space(5)}`,
  background: "var(--surface)",
  borderRadius: radius.md,
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  fontVariantNumeric: "tabular-nums",
};
