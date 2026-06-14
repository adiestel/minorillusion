/**
 * PlayersPanel — the GM's "Players" tab: manage who's in the circle.
 * Each row shows a player's connection state and live viewport, lets the GM
 * rename them inline (player:rename), and remove them (player:remove, with a
 * one-tap confirm so it isn't accidental). Names sync from presence when not
 * being edited.
 *
 * Note: a rename sticks while the player is connected; if that player later
 * rejoins it re-asserts its own chosen name (identity is pinned per device).
 */
import { useEffect, useState } from "react";
import type {
  Player,
  RemovePlayerResult,
  RenamePlayerResult,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

export function PlayersPanel({ players }: { players: Player[] }) {
  const connected = players.filter((p) => p.connected).length;
  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space(4) }}>
        <h2 style={{ ...sectionHeadingStyle, margin: 0 }}>Players</h2>
        <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
          {connected}/{players.length} connected
        </span>
      </div>

      {players.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-dim)" }}>
          No players yet — share the join code.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: space(2) }}>
          {players.map((p) => (
            <PlayerManageRow key={p.id} player={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// One manageable player row
// ---------------------------------------------------------------------------

function PlayerManageRow({ player }: { player: Player }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(player.name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // Keep the field in sync with presence updates, unless mid-edit.
  useEffect(() => {
    if (!editing) setName(player.name);
  }, [player.name, editing]);

  function saveName() {
    const trimmed = name.trim();
    setEditing(false);
    if (trimmed.length === 0 || trimmed === player.name) {
      setName(player.name);
      return;
    }
    setBusy(true);
    socket.emit("player:rename", { playerId: player.id, name: trimmed }, (r: RenamePlayerResult) => {
      setBusy(false);
      if (!r.ok) setName(player.name); // revert on failure
    });
  }

  function remove() {
    setBusy(true);
    socket.emit("player:remove", { playerId: player.id }, (_r: RemovePlayerResult) => {
      setBusy(false);
      setConfirming(false);
    });
  }

  const vp = player.viewport;

  return (
    <li style={rowStyle}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: player.connected ? palette.ember : palette.ash,
          flexShrink: 0,
        }}
        title={player.connected ? "connected" : "disconnected"}
      />

      {editing ? (
        <input
          autoFocus
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveName();
            if (e.key === "Escape") {
              setName(player.name);
              setEditing(false);
            }
          }}
          style={nameInputStyle}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          style={nameButtonStyle}
          title="Click to rename"
        >
          {player.name}
        </button>
      )}

      {vp && (
        <span style={vpBadgeStyle} title="reported viewport (CSS px)">
          {vp.width}×{vp.height}
        </span>
      )}

      <div style={{ marginLeft: "auto", display: "flex", gap: space(2) }}>
        {!editing && (
          <button onClick={() => setEditing(true)} style={ghostButtonStyle} disabled={busy}>
            Rename
          </button>
        )}
        {confirming ? (
          <>
            <button onClick={remove} style={dangerButtonStyle} disabled={busy}>
              {busy ? "Removing…" : "Confirm"}
            </button>
            <button onClick={() => setConfirming(false)} style={ghostButtonStyle} disabled={busy}>
              Cancel
            </button>
          </>
        ) : (
          <button onClick={() => setConfirming(true)} style={ghostButtonStyle} disabled={busy}>
            Remove
          </button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Styles (match the other GM cards)
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: `${space(5)} ${space(5)}`,
  background: "var(--surface)",
  borderRadius: radius.md,
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(3),
  padding: `${space(3)} ${space(4)}`,
  background: "var(--bg)",
  borderRadius: radius.md,
};

const nameButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text)",
  fontWeight: 600,
  fontSize: "0.95rem",
  cursor: "pointer",
  padding: 0,
  textAlign: "left",
};

const nameInputStyle: React.CSSProperties = {
  background: "var(--surface)",
  color: "var(--text)",
  border: `1px solid ${palette.emberDim}`,
  borderRadius: radius.sm,
  padding: `${space(1)} ${space(2)}`,
  fontSize: "0.95rem",
  fontWeight: 600,
  outline: "none",
  minWidth: 0,
  width: 160,
};

const vpBadgeStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--text-dim)",
  fontVariantNumeric: "tabular-nums",
  padding: `1px ${space(2)}`,
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.pill,
};

const ghostButtonStyle: React.CSSProperties = {
  padding: `${space(1)} ${space(3)}`,
  background: "transparent",
  color: "var(--text-dim)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  fontWeight: 600,
  fontSize: "0.8rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const dangerButtonStyle: React.CSSProperties = {
  padding: `${space(1)} ${space(3)}`,
  background: palette.emberDim,
  color: palette.bone,
  border: `1px solid ${palette.ember}`,
  borderRadius: radius.md,
  fontWeight: 700,
  fontSize: "0.8rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};
