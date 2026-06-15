/**
 * Party — M5 GM D&D layer (the Party tab).
 *
 * Three stacked cards, each matching the existing console panels (card surface,
 * uppercase ember section headings, small toggle/select idioms):
 *
 *   1. Characters — the circle's character roster + an add/edit form for MANUAL
 *      entry (the guaranteed path, D6): name, level, the six ability scores (with
 *      derived modifiers), an optional proficiency-bonus override, skill- and
 *      save-proficiency checkboxes, optional HP/AC. Plus a small best-effort
 *      "Import from D&D Beyond" paste-a-link field (may fail — that's expected).
 *   2. Call a roll — pick a character + a roll (check/save/skill/raw), an
 *      advantage selector, a target player (its die visualises it), a public
 *      toggle. Fires `roll:call`; shows the result prominently and keeps a short
 *      roll log (newest first, crit green / fumble red).
 *   3. Initiative — add/edit combatants, a high→low list driven by the server's
 *      `initiative:update`, the current turn highlighted, Next turn (advance,
 *      shows the round) and Clear.
 *
 * App (CirclePanel) owns the live `characters`, `rollLog` and `initiative` state
 * + the socket listeners and passes them down; this panel renders + emits. Rolls
 * and initiative are resolved AUTHORITATIVELY on the server — we only ask.
 */
import { useEffect, useMemo, useState } from "react";
import type {
  Ability,
  AbilityScores,
  Character,
  ImportCharacterRequest,
  InitiativeEntry,
  InitiativeState,
  Player,
  RollMode,
  RollRequest,
  RollResult,
  RollSpec,
  SaveCharacterRequest,
  SaveCharacterResult,
  SetInitiativeRequest,
  Skill,
} from "@minorillusion/contract";
import {
  SKILL_ABILITY,
  abilityModifier,
  proficiencyForLevel,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";
import { usePersistentState } from "./usePersistentState";

// ---------------------------------------------------------------------------
// Vocabulary — labels + ordered lists. The contract owns the unions; we only
// give them human labels and a stable display order here.
// ---------------------------------------------------------------------------

const ABILITIES: Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

const ABILITY_LABEL: Record<Ability, string> = {
  str: "STR",
  dex: "DEX",
  con: "CON",
  int: "INT",
  wis: "WIS",
  cha: "CHA",
};

const SKILLS: Skill[] = [
  "acrobatics", "animal_handling", "arcana", "athletics", "deception",
  "history", "insight", "intimidation", "investigation", "medicine",
  "nature", "perception", "performance", "persuasion", "religion",
  "sleight_of_hand", "stealth", "survival",
];

/** "sleight_of_hand" → "Sleight of Hand" (small words kept lowercase). */
function skillLabel(s: Skill): string {
  const small = new Set(["of", "the", "and"]);
  return s
    .split("_")
    .map((w, i) =>
      i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1),
    )
    .join(" ");
}

/** Crit/fumble flair colours (the palette has no green; use literals). */
const CRIT_GREEN = "#3fb950";
const FUMBLE_RED = "#e5484d";

const DIE_SIDES = [4, 6, 8, 10, 12, 20, 100] as const;

/** A fresh, neutral statline for a new character (all 10s = +0). */
const DEFAULT_ABILITIES: AbilityScores = {
  str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
};

/** Show a modifier as a signed string, e.g. +3 / −1 / +0. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}

// ===========================================================================
// Main panel
// ===========================================================================

interface PartyProps {
  players: Player[];
  characters: Character[];
  rollLog: RollResult[];
  initiative: InitiativeState | null;
}

export function Party({ players, characters, rollLog, initiative }: PartyProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(6) }}>
      <CharactersCard characters={characters} />
      <RollCallerCard
        players={players}
        characters={characters}
        rollLog={rollLog}
      />
      <InitiativeCard characters={characters} initiative={initiative} />
    </div>
  );
}

// ===========================================================================
// 1. Characters — roster + manual-entry / edit form + DDB import
// ===========================================================================

function CharactersCard({ characters }: { characters: Character[] }) {
  // The id of the character being edited (null = the add form is fresh).
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = useMemo(
    () => characters.find((c) => c.id === editingId) ?? null,
    [characters, editingId],
  );

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Characters</h2>

      {characters.length === 0 ? (
        <p style={emptyStyle}>
          No characters yet — add one below, or import from D&amp;D Beyond.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space(2) }}>
          {characters.map((c) => (
            <CharacterRow
              key={c.id}
              character={c}
              editing={c.id === editingId}
              onEdit={() => setEditingId(c.id)}
            />
          ))}
        </div>
      )}

      {/* The add/edit form. A fresh key per editing target resets its internal
          state cleanly when the GM switches which character they're editing. */}
      <CharacterForm
        key={editing?.id ?? "new"}
        editing={editing}
        onDone={() => setEditingId(null)}
      />

      <ImportRow />
    </section>
  );
}

// ---------------------------------------------------------------------------
// CharacterRow — one roster entry + a quick summary + edit/delete
// ---------------------------------------------------------------------------

function CharacterRow({
  character,
  editing,
  onEdit,
}: {
  character: Character;
  editing: boolean;
  onEdit: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const prof = character.proficiencyBonus ?? proficiencyForLevel(character.level);

  function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    socket.emit("character:delete", { characterId: character.id }, () => {
      // The server re-pushes characters:list; the row vanishes from props.
      setDeleting(false);
    });
  }

  return (
    <div style={{ ...rowStyle, borderLeftColor: editing ? palette.ember : palette.emberDim }}>
      <div style={rowHeaderStyle}>
        <span style={{ display: "flex", alignItems: "baseline", gap: space(2), minWidth: 0 }}>
          <span style={{ fontWeight: 700, color: "var(--text)", fontSize: "0.95rem" }}>
            {character.name}
          </span>
          <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
            Lv {character.level} · prof {signed(prof)}
            {character.source === "ddb" ? " · DDB" : ""}
          </span>
        </span>
        <span style={{ display: "flex", gap: space(1), flexShrink: 0 }}>
          <button style={miniButtonStyle} onClick={onEdit}>
            {editing ? "Editing" : "Edit"}
          </button>
          <button style={miniDangerButtonStyle} onClick={handleDelete} disabled={deleting}>
            {deleting ? "…" : "Delete"}
          </button>
        </span>
      </div>

      {/* Ability line — score (modifier) for each of the six. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: space(3), marginTop: space(1) }}>
        {ABILITIES.map((a) => (
          <span key={a} style={{ fontSize: "0.78rem", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            <span style={{ color: palette.parchmentDim, fontWeight: 600 }}>{ABILITY_LABEL[a]}</span>{" "}
            {character.abilities[a]} ({signed(abilityModifier(character.abilities[a]))})
          </span>
        ))}
        {character.maxHp !== undefined && (
          <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>HP {character.maxHp}</span>
        )}
        {character.ac !== undefined && (
          <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>AC {character.ac}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CharacterForm — manual entry (add) or edit of an existing sheet
// ---------------------------------------------------------------------------

function CharacterForm({
  editing,
  onDone,
}: {
  editing: Character | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(editing?.name ?? "");
  const [level, setLevel] = useState(editing?.level ?? 1);
  const [abilities, setAbilities] = useState<AbilityScores>(
    editing?.abilities ?? DEFAULT_ABILITIES,
  );
  // Proficiency override: empty string = "use the level-derived default".
  const [profOverride, setProfOverride] = useState<string>(
    editing?.proficiencyBonus !== undefined ? String(editing.proficiencyBonus) : "",
  );
  const [skillProfs, setSkillProfs] = useState<Set<Skill>>(
    new Set(editing?.skillProficiencies ?? []),
  );
  const [saveProfs, setSaveProfs] = useState<Set<Ability>>(
    new Set(editing?.saveProficiencies ?? []),
  );
  const [hp, setHp] = useState<string>(
    editing?.maxHp !== undefined ? String(editing.maxHp) : "",
  );
  const [ac, setAc] = useState<string>(
    editing?.ac !== undefined ? String(editing.ac) : "",
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = editing !== null;
  const derivedProf = proficiencyForLevel(level);

  function setAbility(a: Ability, value: number) {
    setAbilities((prev) => ({ ...prev, [a]: value }));
  }

  function toggleSkill(s: Skill) {
    setSkillProfs((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function toggleSave(a: Ability) {
    setSaveProfs((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  }

  function clampAbility(v: number): number {
    if (Number.isNaN(v)) return 10;
    return Math.max(1, Math.min(30, Math.round(v)));
  }

  /** Parse an optional integer field; returns undefined when blank/invalid. */
  function optInt(raw: string, min: number, max: number): number | undefined {
    const t = raw.trim();
    if (t === "") return undefined;
    const n = Math.round(Number(t));
    if (Number.isNaN(n)) return undefined;
    return Math.max(min, Math.min(max, n));
  }

  function handleSave() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setSaving(true);

    const profValue = optInt(profOverride, 0, 10);

    const req: SaveCharacterRequest = {
      ...(isEdit ? { id: editing.id } : {}),
      name: trimmed.slice(0, 60),
      level: Math.max(1, Math.min(20, Math.round(level))),
      abilities,
      ...(profValue !== undefined ? { proficiencyBonus: profValue } : {}),
      skillProficiencies: Array.from(skillProfs),
      saveProficiencies: Array.from(saveProfs),
      ...(optInt(hp, 0, 1000) !== undefined ? { maxHp: optInt(hp, 0, 1000) } : {}),
      ...(optInt(ac, 0, 40) !== undefined ? { ac: optInt(ac, 0, 40) } : {}),
    };

    socket.emit("character:save", req, (res: SaveCharacterResult) => {
      setSaving(false);
      if (res.ok) {
        if (isEdit) {
          onDone();
        } else {
          // Reset the add form for the next character.
          setName("");
          setLevel(1);
          setAbilities(DEFAULT_ABILITIES);
          setProfOverride("");
          setSkillProfs(new Set());
          setSaveProfs(new Set());
          setHp("");
          setAc("");
        }
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div style={formWrapStyle}>
      <div style={formTitleRowStyle}>
        <span style={subHeadingStyle}>{isEdit ? `Edit ${editing.name}` : "Add a character"}</span>
        {isEdit && (
          <button style={miniButtonStyle} onClick={onDone}>
            Cancel
          </button>
        )}
      </div>

      {/* Name + level */}
      <div style={{ display: "flex", gap: space(2), flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 160px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Name</label>
          <input
            type="text"
            value={name}
            maxLength={60}
            placeholder="Character name"
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            style={textInputStyle}
          />
        </div>
        <div style={{ flex: "0 1 90px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Level</label>
          <input
            type="number"
            min={1}
            max={20}
            value={level}
            onChange={(e) => setLevel(Math.max(1, Math.min(20, Math.round(Number(e.target.value)) || 1)))}
            style={numberInputStyle}
          />
        </div>
        <div style={{ flex: "0 1 130px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle} title="Leave blank to use the level default">
            Prof. ({signed(derivedProf)})
          </label>
          <input
            type="number"
            min={0}
            max={10}
            value={profOverride}
            placeholder={String(derivedProf)}
            onChange={(e) => setProfOverride(e.target.value)}
            style={numberInputStyle}
          />
        </div>
      </div>

      {/* Ability scores — number input + derived modifier under each. */}
      <label style={{ ...labelStyle, marginTop: space(3) }}>Ability scores</label>
      <div style={abilityGridStyle}>
        {ABILITIES.map((a) => (
          <div key={a} style={abilityCellStyle}>
            <span style={{ fontSize: "0.72rem", fontWeight: 700, letterSpacing: "0.06em", color: palette.parchmentDim }}>
              {ABILITY_LABEL[a]}
            </span>
            <input
              type="number"
              min={1}
              max={30}
              value={abilities[a]}
              onChange={(e) => setAbility(a, clampAbility(Number(e.target.value)))}
              style={{ ...numberInputStyle, width: "100%", textAlign: "center" }}
            />
            <span style={{ fontSize: "0.74rem", color: palette.ember, fontVariantNumeric: "tabular-nums" }}>
              {signed(abilityModifier(abilities[a]))}
            </span>
          </div>
        ))}
      </div>

      {/* Saving-throw proficiencies — the six abilities. */}
      <label style={{ ...labelStyle, marginTop: space(3) }}>Save proficiencies</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: space(2), marginTop: space(1) }}>
        {ABILITIES.map((a) => (
          <CheckChip key={a} checked={saveProfs.has(a)} onClick={() => toggleSave(a)}>
            {ABILITY_LABEL[a]}
          </CheckChip>
        ))}
      </div>

      {/* Skill proficiencies — all 18. */}
      <label style={{ ...labelStyle, marginTop: space(3) }}>Skill proficiencies</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: space(2), marginTop: space(1) }}>
        {SKILLS.map((s) => (
          <CheckChip key={s} checked={skillProfs.has(s)} onClick={() => toggleSkill(s)}>
            {skillLabel(s)}
          </CheckChip>
        ))}
      </div>

      {/* Optional HP / AC. */}
      <div style={{ display: "flex", gap: space(3), marginTop: space(3), flexWrap: "wrap" }}>
        <div style={{ flex: "0 1 110px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Max HP</label>
          <input
            type="number"
            min={0}
            max={1000}
            value={hp}
            placeholder="—"
            onChange={(e) => setHp(e.target.value)}
            style={numberInputStyle}
          />
        </div>
        <div style={{ flex: "0 1 110px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>AC</label>
          <input
            type="number"
            min={0}
            max={40}
            value={ac}
            placeholder="—"
            onChange={(e) => setAc(e.target.value)}
            style={numberInputStyle}
          />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(4) }}>
        <button onClick={handleSave} disabled={saving} style={primaryButtonStyle(saving)}>
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add character"}
        </button>
        {error && <span style={{ color: FUMBLE_RED, fontSize: "0.82rem" }}>{error}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ImportRow — best-effort DDB public-link import (D6: never depend on it)
// ---------------------------------------------------------------------------

function ImportRow() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  function handleImport() {
    const t = url.trim();
    if (t.length === 0 || busy) return;
    setStatus(null);
    setBusy(true);
    const req: ImportCharacterRequest = { url: t.slice(0, 400) };
    socket.emit("character:import", req, (res: SaveCharacterResult) => {
      setBusy(false);
      if (res.ok) {
        setUrl("");
        setStatus({ ok: true, text: `Imported ${res.character.name}.` });
      } else {
        setStatus({ ok: false, text: res.error });
      }
    });
  }

  return (
    <div style={importWrapStyle}>
      <label style={labelStyle}>Import from D&amp;D Beyond</label>
      <p style={{ ...hintStyle, margin: `${space(1)} 0 ${space(2)}` }}>
        Paste a public character share link. Best-effort — it may fail (no official
        API); manual entry above always works.
      </p>
      <div style={{ display: "flex", gap: space(2) }}>
        <input
          type="text"
          placeholder="https://www.dndbeyond.com/characters/…"
          value={url}
          maxLength={400}
          onChange={(e) => {
            setUrl(e.target.value);
            if (status) setStatus(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleImport();
          }}
          style={{ ...textInputStyle, flex: 1, minWidth: 0 }}
        />
        <button
          onClick={handleImport}
          disabled={busy || url.trim().length === 0}
          style={secondaryButtonStyle(busy || url.trim().length === 0)}
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
      {status && (
        <p style={{ margin: `${space(2)} 0 0`, fontSize: "0.82rem", color: status.ok ? palette.ember : FUMBLE_RED }}>
          {status.text}
        </p>
      )}
    </div>
  );
}

// ===========================================================================
// 2. Call a roll
// ===========================================================================

type RollKind = "check" | "save" | "skill" | "raw";

function RollCallerCard({
  players,
  characters,
  rollLog,
}: {
  players: Player[];
  characters: Character[];
  rollLog: RollResult[];
}) {
  // GM preferences persist across reloads (the picked character/player don't —
  // their ids change per circle/session).
  const [kind, setKind] = usePersistentState<RollKind>("mi.gm.roll.kind", "check");
  const [mode, setMode] = usePersistentState<RollMode>("mi.gm.roll.mode", "normal");
  const [isPublic, setIsPublic] = usePersistentState("mi.gm.roll.public", false);

  const [characterId, setCharacterId] = useState<string>("");
  const [targetPlayerId, setTargetPlayerId] = useState<string>("");

  // Derived-roll selectors.
  const [ability, setAbility] = useState<Ability>("str");
  const [skill, setSkill] = useState<Skill>("perception");

  // Raw-roll fields.
  const [count, setCount] = useState(1);
  const [sides, setSides] = useState<(typeof DIE_SIDES)[number]>(20);
  const [modifier, setModifier] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the picked character valid as the roster changes (it may be deleted).
  useEffect(() => {
    if (characterId !== "" && !characters.some((c) => c.id === characterId)) {
      setCharacterId("");
    }
  }, [characters, characterId]);

  const connectedPlayers = players.filter((p) => p.connected);
  // Derived kinds need a character to pull the modifier from.
  const needsCharacter = kind !== "raw";
  const canFire = !busy && (!needsCharacter || characterId !== "");

  function buildSpec(): RollSpec {
    switch (kind) {
      case "check":
        return { kind: "check", ability };
      case "save":
        return { kind: "save", ability };
      case "skill":
        return { kind: "skill", skill };
      case "raw":
        return {
          kind: "raw",
          count: Math.max(1, Math.min(20, Math.round(count) || 1)),
          sides,
          modifier: Math.max(-50, Math.min(50, Math.round(modifier) || 0)),
        };
    }
  }

  function handleFire() {
    if (!canFire) return;
    setError(null);
    setBusy(true);

    const req: RollRequest = {
      spec: buildSpec(),
      mode,
      public: isPublic,
      ...(characterId !== "" ? { characterId } : {}),
      ...(targetPlayerId !== "" ? { targetPlayerId } : {}),
    };

    socket.emit("roll:call", req, (res) => {
      setBusy(false);
      if (!res.ok) setError(res.error);
      // On success the server fans roll:result back to App, which prepends it to
      // the log — no local handling needed.
    });
  }

  // The most-recent result is shown prominently above the log.
  const latest = rollLog[0];

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Call a roll</h2>

      {/* Character + roll kind */}
      <div style={{ display: "flex", gap: space(3), flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Character</label>
          <select value={characterId} onChange={(e) => setCharacterId(e.target.value)} style={selectStyle}>
            <option value="">None</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} (Lv {c.level})
              </option>
            ))}
          </select>
          {needsCharacter && characterId === "" && (
            <span style={{ fontSize: "0.74rem", color: palette.parchmentDim }}>
              A {kind} needs a character.
            </span>
          )}
        </div>

        <div style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Roll</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: space(1) }}>
            {(["check", "save", "skill", "raw"] as const).map((k) => (
              <SmallToggle key={k} active={kind === k} onClick={() => setKind(k)}>
                {rollKindLabel(k)}
              </SmallToggle>
            ))}
          </div>
        </div>
      </div>

      {/* Kind-specific selector */}
      <div style={{ marginTop: space(3) }}>
        {(kind === "check" || kind === "save") && (
          <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
            <label style={labelStyle}>Ability</label>
            <select value={ability} onChange={(e) => setAbility(e.target.value as Ability)} style={selectStyle}>
              {ABILITIES.map((a) => (
                <option key={a} value={a}>
                  {abilityFullLabel(a)}
                </option>
              ))}
            </select>
          </div>
        )}

        {kind === "skill" && (
          <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
            <label style={labelStyle}>Skill</label>
            <select value={skill} onChange={(e) => setSkill(e.target.value as Skill)} style={selectStyle}>
              {SKILLS.map((s) => (
                <option key={s} value={s}>
                  {skillLabel(s)} ({ABILITY_LABEL[SKILL_ABILITY[s]]})
                </option>
              ))}
            </select>
          </div>
        )}

        {kind === "raw" && (
          <div style={{ display: "flex", alignItems: "flex-end", gap: space(2), flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
              <label style={labelStyle}>Count</label>
              <input
                type="number"
                min={1}
                max={20}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(20, Math.round(Number(e.target.value)) || 1)))}
                style={{ ...numberInputStyle, width: 64 }}
              />
            </div>
            <span style={{ color: "var(--text-dim)", paddingBottom: space(2) }}>d</span>
            <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
              <label style={labelStyle}>Die</label>
              <select
                value={sides}
                onChange={(e) => setSides(Number(e.target.value) as (typeof DIE_SIDES)[number])}
                style={selectStyle}
              >
                {DIE_SIDES.map((d) => (
                  <option key={d} value={d}>
                    d{d}
                  </option>
                ))}
              </select>
            </div>
            <span style={{ color: "var(--text-dim)", paddingBottom: space(2) }}>+</span>
            <div style={{ display: "flex", flexDirection: "column", gap: space(1) }}>
              <label style={labelStyle}>Modifier</label>
              <input
                type="number"
                min={-50}
                max={50}
                value={modifier}
                onChange={(e) => setModifier(Math.max(-50, Math.min(50, Math.round(Number(e.target.value)) || 0)))}
                style={{ ...numberInputStyle, width: 72 }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Advantage / target / public */}
      <label style={{ ...labelStyle, marginTop: space(4) }}>Advantage</label>
      <div style={{ display: "flex", gap: space(2), marginTop: space(1) }}>
        {(["disadvantage", "normal", "advantage"] as const).map((m) => (
          <SmallToggle key={m} active={mode === m} onClick={() => setMode(m)}>
            {rollModeLabel(m)}
          </SmallToggle>
        ))}
      </div>

      <div style={{ display: "flex", gap: space(3), marginTop: space(4), flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "1 1 180px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Show die on</label>
          <select value={targetPlayerId} onChange={(e) => setTargetPlayerId(e.target.value)} style={selectStyle}>
            <option value="">None (GM only)</option>
            {connectedPlayers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: space(2), paddingBottom: space(2) }}>
          <SmallToggle active={isPublic} onClick={() => setIsPublic((v) => !v)}>
            {isPublic ? "Public ✓" : "Public"}
          </SmallToggle>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(4) }}>
        <button onClick={handleFire} disabled={!canFire} style={primaryButtonStyle(!canFire)}>
          {busy ? "Rolling…" : "Roll"}
        </button>
        {error && <span style={{ color: FUMBLE_RED, fontSize: "0.82rem" }}>{error}</span>}
      </div>

      {/* Latest result — prominent. */}
      {latest && <LatestRoll result={latest} />}

      {/* Roll log — newest first. */}
      {rollLog.length > 1 && (
        <>
          <label style={{ ...labelStyle, marginTop: space(4) }}>Recent rolls</label>
          <div style={{ display: "flex", flexDirection: "column", gap: space(1), marginTop: space(2) }}>
            {rollLog.slice(1).map((r) => (
              <RollLogRow key={r.id} result={r} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// LatestRoll — the big readout of the most recent result
// ---------------------------------------------------------------------------

function LatestRoll({ result }: { result: RollResult }) {
  const flair = result.crit ? CRIT_GREEN : result.fumble ? FUMBLE_RED : palette.ember;
  return (
    <div
      style={{
        marginTop: space(4),
        padding: `${space(4)} ${space(4)}`,
        background: "var(--bg)",
        borderRadius: radius.md,
        border: `1px solid ${flair}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space(4),
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: space(1), minWidth: 0 }}>
        <span style={{ fontSize: "0.92rem", fontWeight: 700, color: "var(--text)" }}>
          {result.label}
          {result.characterName ? ` · ${result.characterName}` : ""}
        </span>
        <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
          {rollDetail(result)}
          {result.crit && <span style={{ color: CRIT_GREEN, fontWeight: 700 }}>  CRIT!</span>}
          {result.fumble && <span style={{ color: FUMBLE_RED, fontWeight: 700 }}>  FUMBLE</span>}
        </span>
      </div>
      <span
        style={{
          fontSize: "2.2rem",
          fontWeight: 800,
          color: flair,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1,
        }}
      >
        {result.total}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RollLogRow — one compact past result
// ---------------------------------------------------------------------------

function RollLogRow({ result }: { result: RollResult }) {
  const flair = result.crit ? CRIT_GREEN : result.fumble ? FUMBLE_RED : "var(--text)";
  return (
    <div style={logRowStyle}>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.82rem", color: "var(--text-dim)" }}>
        <span style={{ color: "var(--text)", fontWeight: 600 }}>{result.label}</span>
        {result.characterName ? ` · ${result.characterName}` : ""}
        <span style={{ marginLeft: space(2) }}>{rollDetail(result)}</span>
      </span>
      <span style={{ fontWeight: 800, color: flair, fontVariantNumeric: "tabular-nums", flexShrink: 0, fontSize: "0.95rem" }}>
        {result.total}
      </span>
    </div>
  );
}

/** "2d20kh1 [14, 9] +5" style detail string for a result. */
function rollDetail(r: RollResult): string {
  const dicePart = `[${r.dice.join(", ")}]`;
  const modPart = r.modifier !== 0 ? ` ${signed(r.modifier)}` : "";
  const modeTag =
    r.mode === "advantage" ? " adv" : r.mode === "disadvantage" ? " dis" : "";
  return `d${r.sides}${modeTag} ${dicePart}${modPart}`;
}

// ===========================================================================
// 3. Initiative
// ===========================================================================

/** A locally-edited combatant row (id present = an existing server entry). */
interface DraftEntry {
  id?: string;
  name: string;
  initiative: number;
  characterId?: string;
  hp?: number;
  maxHp?: number;
}

function InitiativeCard({
  characters,
  initiative,
}: {
  characters: Character[];
  initiative: InitiativeState | null;
}) {
  // The add-combatant form.
  const [name, setName] = useState("");
  const [init, setInit] = useState<string>("");
  const [linkId, setLinkId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const entries = initiative?.entries ?? [];
  const turnIndex = initiative?.turnIndex ?? -1;
  const round = initiative?.round ?? 0;

  /** Replace the whole order from a draft list (the server re-sorts + pushes). */
  function setOrder(next: DraftEntry[]) {
    const req: SetInitiativeRequest = {
      entries: next.map((e) => ({
        ...(e.id ? { id: e.id } : {}),
        name: e.name,
        initiative: e.initiative,
        ...(e.characterId ? { characterId: e.characterId } : {}),
        ...(e.hp !== undefined ? { hp: e.hp } : {}),
        ...(e.maxHp !== undefined ? { maxHp: e.maxHp } : {}),
      })),
    };
    socket.emit("initiative:set", req, () => {
      // The ack carries the new state, but the server also pushes
      // initiative:update to App — let that single path drive the UI.
    });
  }

  /** Current entries as a draft list we can mutate then re-send. */
  function draftFrom(list: InitiativeEntry[]): DraftEntry[] {
    return list.map((e) => ({
      id: e.id,
      name: e.name,
      initiative: e.initiative,
      characterId: e.characterId,
      hp: e.hp,
      maxHp: e.maxHp,
    }));
  }

  function handleAdd() {
    const trimmed = name.trim();
    const value = Math.round(Number(init));
    if (trimmed.length === 0 || init.trim() === "" || Number.isNaN(value)) return;
    const linked = linkId !== "" ? characters.find((c) => c.id === linkId) : undefined;
    const next: DraftEntry = {
      name: trimmed.slice(0, 60),
      initiative: Math.max(-10, Math.min(60, value)),
      ...(linked ? { characterId: linked.id } : {}),
      ...(linked?.maxHp !== undefined ? { hp: linked.maxHp, maxHp: linked.maxHp } : {}),
    };
    setOrder([...draftFrom(entries), next]);
    setName("");
    setInit("");
    setLinkId("");
  }

  function handleRemove(id: string) {
    setOrder(draftFrom(entries).filter((e) => e.id !== id));
  }

  function handleEditInit(id: string, value: number) {
    setOrder(
      draftFrom(entries).map((e) =>
        e.id === id ? { ...e, initiative: Math.max(-10, Math.min(60, value)) } : e,
      ),
    );
  }

  function handleEditHp(id: string, value: number | undefined) {
    setOrder(
      draftFrom(entries).map((e) => (e.id === id ? { ...e, hp: value } : e)),
    );
  }

  function handleAdvance() {
    if (busy) return;
    setBusy(true);
    socket.emit("initiative:advance", () => setBusy(false));
  }

  function handleClear() {
    if (busy) return;
    setBusy(true);
    socket.emit("initiative:clear", () => setBusy(false));
  }

  /** Nice-to-have: roll initiative for everyone (d20 + their DEX modifier). */
  function handleRollAll() {
    if (entries.length === 0) return;
    setOrder(
      draftFrom(entries).map((e) => {
        const linked = e.characterId
          ? characters.find((c) => c.id === e.characterId)
          : undefined;
        const dexMod = linked ? abilityModifier(linked.abilities.dex) : 0;
        const roll = 1 + Math.floor(Math.random() * 20);
        return { ...e, initiative: Math.max(-10, Math.min(60, roll + dexMod)) };
      }),
    );
  }

  // Already sorted high→low by the server, but sort defensively.
  const ordered = [...entries].sort((a, b) => b.initiative - a.initiative);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space(3) }}>
        <h2 style={{ ...sectionHeadingStyle, margin: 0 }}>Initiative</h2>
        {round > 0 && (
          <span style={{ fontSize: "0.8rem", color: palette.ember, fontWeight: 700, letterSpacing: "0.06em" }}>
            Round {round}
          </span>
        )}
      </div>

      {/* Add a combatant */}
      <div style={{ display: "flex", gap: space(2), marginTop: space(3), flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: "2 1 140px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Combatant</label>
          <input
            type="text"
            placeholder="Goblin, NPC, or a name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            style={textInputStyle}
          />
        </div>
        <div style={{ flex: "0 1 80px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Init</label>
          <input
            type="number"
            min={-10}
            max={60}
            placeholder="0"
            value={init}
            onChange={(e) => setInit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            style={numberInputStyle}
          />
        </div>
        <div style={{ flex: "1 1 130px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Link (optional)</label>
          <select
            value={linkId}
            onChange={(e) => {
              const id = e.target.value;
              setLinkId(id);
              // Convenience: pre-fill the name from the linked character.
              const linked = id !== "" ? characters.find((c) => c.id === id) : undefined;
              if (linked && name.trim() === "") setName(linked.name);
            }}
            style={selectStyle}
          >
            <option value="">No link</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button onClick={handleAdd} disabled={name.trim() === "" || init.trim() === ""} style={secondaryButtonStyle(name.trim() === "" || init.trim() === "")}>
          Add
        </button>
      </div>

      {/* The order */}
      {ordered.length === 0 ? (
        <p style={{ ...emptyStyle, marginTop: space(4) }}>
          No combatants yet — add one to start the order.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space(1), marginTop: space(4) }}>
          {ordered.map((e, i) => (
            <InitiativeRow
              key={e.id}
              entry={e}
              current={i === turnIndex}
              onInit={(v) => handleEditInit(e.id, v)}
              onHp={(v) => handleEditHp(e.id, v)}
              onRemove={() => handleRemove(e.id)}
            />
          ))}
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: space(2), marginTop: space(4), flexWrap: "wrap" }}>
        <button
          onClick={handleAdvance}
          disabled={busy || ordered.length === 0}
          style={primaryButtonStyle(busy || ordered.length === 0)}
        >
          {turnIndex < 0 ? "Start" : "Next turn"}
        </button>
        <button
          onClick={handleRollAll}
          disabled={ordered.length === 0}
          style={secondaryButtonStyle(ordered.length === 0)}
          title="Assign d20 + DEX to every combatant"
        >
          Roll initiative
        </button>
        <button
          onClick={handleClear}
          disabled={busy || ordered.length === 0}
          style={ghostDangerButtonStyle(busy || ordered.length === 0)}
        >
          Clear
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// InitiativeRow — one combatant; the current turn is highlighted
// ---------------------------------------------------------------------------

function InitiativeRow({
  entry,
  current,
  onInit,
  onHp,
  onRemove,
}: {
  entry: InitiativeEntry;
  current: boolean;
  onInit: (value: number) => void;
  onHp: (value: number | undefined) => void;
  onRemove: () => void;
}) {
  // Local mirror so typing in the init box doesn't round-trip on every keypress;
  // commit on blur / Enter.
  const [initDraft, setInitDraft] = useState(String(entry.initiative));
  useEffect(() => {
    setInitDraft(String(entry.initiative));
  }, [entry.initiative]);

  const [hpDraft, setHpDraft] = useState(entry.hp !== undefined ? String(entry.hp) : "");
  useEffect(() => {
    setHpDraft(entry.hp !== undefined ? String(entry.hp) : "");
  }, [entry.hp]);

  function commitInit() {
    const v = Math.round(Number(initDraft));
    if (!Number.isNaN(v) && v !== entry.initiative) onInit(v);
    else setInitDraft(String(entry.initiative));
  }

  function commitHp() {
    const t = hpDraft.trim();
    if (t === "") {
      if (entry.hp !== undefined) onHp(undefined);
      return;
    }
    const v = Math.round(Number(t));
    if (!Number.isNaN(v) && v !== entry.hp) onHp(v);
  }

  return (
    <div
      style={{
        ...initRowStyle,
        background: current ? palette.emberDim : "var(--bg)",
        borderColor: current ? palette.ember : "transparent",
      }}
    >
      {/* Turn marker / initiative value */}
      <input
        type="number"
        min={-10}
        max={60}
        value={initDraft}
        onChange={(e) => setInitDraft(e.target.value)}
        onBlur={commitInit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        aria-label={`Initiative for ${entry.name}`}
        style={{
          ...numberInputStyle,
          width: 48,
          textAlign: "center",
          fontWeight: 700,
          color: current ? palette.bone : "var(--text)",
        }}
      />

      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {current && <span style={{ color: palette.ember, marginRight: space(1) }} aria-hidden="true">▸</span>}
        <span style={{ fontWeight: current ? 700 : 600, color: current ? palette.bone : "var(--text)", fontSize: "0.9rem" }}>
          {entry.name}
        </span>
      </span>

      {/* Optional HP box (shown for linked combatants or any with HP). */}
      {(entry.hp !== undefined || entry.maxHp !== undefined) && (
        <span style={{ display: "flex", alignItems: "center", gap: space(1), flexShrink: 0 }}>
          <input
            type="number"
            value={hpDraft}
            onChange={(e) => setHpDraft(e.target.value)}
            onBlur={commitHp}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-label={`HP for ${entry.name}`}
            style={{ ...numberInputStyle, width: 52, textAlign: "center" }}
          />
          {entry.maxHp !== undefined && (
            <span style={{ fontSize: "0.74rem", color: "var(--text-dim)" }}>/ {entry.maxHp}</span>
          )}
        </span>
      )}

      <button onClick={onRemove} style={removeButtonStyle} aria-label={`Remove ${entry.name}`} title="Remove">
        ×
      </button>
    </div>
  );
}

// ===========================================================================
// Shared small controls
// ===========================================================================

function SmallToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${space(2)} ${space(3)}`,
        background: active ? palette.emberDim : "var(--surface)",
        color: active ? palette.ember : "var(--text-dim)",
        border: `1px solid ${active ? palette.ember : palette.ash}`,
        borderRadius: radius.md,
        fontSize: "0.82rem",
        fontWeight: active ? 700 : 400,
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

/** A checkbox-style chip for skill / save proficiencies. */
function CheckChip({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      role="checkbox"
      aria-checked={checked}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space(1),
        padding: `${space(1)} ${space(2)}`,
        background: checked ? palette.emberDim : "var(--bg)",
        color: checked ? palette.ember : "var(--text-dim)",
        border: `1px solid ${checked ? palette.ember : palette.ash}`,
        borderRadius: radius.pill,
        fontSize: "0.78rem",
        fontWeight: checked ? 700 : 400,
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "0.7rem", opacity: checked ? 1 : 0.4 }}>
        {checked ? "✓" : "○"}
      </span>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function rollKindLabel(k: RollKind): string {
  switch (k) {
    case "check": return "Check";
    case "save": return "Save";
    case "skill": return "Skill";
    case "raw": return "Raw";
  }
}

function rollModeLabel(m: RollMode): string {
  switch (m) {
    case "normal": return "Normal";
    case "advantage": return "Advantage";
    case "disadvantage": return "Disadvantage";
  }
}

function abilityFullLabel(a: Ability): string {
  switch (a) {
    case "str": return "Strength";
    case "dex": return "Dexterity";
    case "con": return "Constitution";
    case "int": return "Intelligence";
    case "wis": return "Wisdom";
    case "cha": return "Charisma";
  }
}

// ===========================================================================
// Styles (match the other GM cards: Channel / Soundboard / WhisperVoices)
// ===========================================================================

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: `${space(5)} ${space(5)}`,
  background: "var(--surface)",
  borderRadius: radius.md,
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: `0 0 ${space(4)}`,
  fontSize: "0.78rem",
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const subHeadingStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.74rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const hintStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  lineHeight: 1.45,
  color: "var(--text-dim)",
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.9rem",
  color: "var(--text-dim)",
  fontStyle: "italic",
};

const rowStyle: React.CSSProperties = {
  padding: `${space(3)} ${space(4)}`,
  background: "var(--bg)",
  borderRadius: radius.md,
  display: "flex",
  flexDirection: "column",
  gap: space(1),
  borderLeft: `3px solid ${palette.emberDim}`,
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: space(3),
};

const textInputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(2)} ${space(3)}`,
  fontSize: "0.9rem",
  outline: "none",
  fontFamily: "var(--font)",
  caretColor: palette.ember,
  boxSizing: "border-box",
  width: "100%",
};

const numberInputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(2)} ${space(3)}`,
  fontSize: "0.9rem",
  outline: "none",
  fontFamily: "var(--font)",
  fontVariantNumeric: "tabular-nums",
  caretColor: palette.ember,
  boxSizing: "border-box",
  width: "100%",
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(2)} ${space(3)}`,
  fontSize: "0.9rem",
  fontFamily: "var(--font)",
  outline: "none",
  cursor: "pointer",
  boxSizing: "border-box",
  width: "100%",
};

const abilityGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))",
  gap: space(2),
  marginTop: space(1),
};

const abilityCellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: space(1),
  padding: `${space(2)} ${space(1)}`,
  background: "var(--bg)",
  borderRadius: radius.sm,
  border: `1px solid ${palette.ash}`,
};

const formWrapStyle: React.CSSProperties = {
  marginTop: space(5),
  paddingTop: space(4),
  borderTop: `1px solid ${palette.ash}`,
  display: "flex",
  flexDirection: "column",
};

const formTitleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: space(3),
};

const importWrapStyle: React.CSSProperties = {
  marginTop: space(5),
  paddingTop: space(4),
  borderTop: `1px solid ${palette.ash}`,
  display: "flex",
  flexDirection: "column",
};

const logRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: space(3),
  padding: `${space(1)} ${space(3)}`,
  background: "var(--bg)",
  borderRadius: radius.sm,
};

const initRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2)} ${space(3)}`,
  borderRadius: radius.md,
  border: "1px solid transparent",
  transition: "background 0.15s, border-color 0.15s",
};

const removeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-dim)",
  fontSize: "1.1rem",
  lineHeight: 1,
  cursor: "pointer",
  padding: `0 ${space(1)}`,
  flexShrink: 0,
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(3)} ${space(5)}`,
    background: disabled ? palette.ash : palette.ember,
    color: disabled ? palette.parchmentDim : palette.nearBlack,
    border: "none",
    borderRadius: radius.md,
    fontWeight: 700,
    fontSize: "0.92rem",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
    alignSelf: "flex-start",
    whiteSpace: "nowrap",
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(2)} ${space(4)}`,
    background: disabled ? palette.ash : "var(--surface)",
    color: disabled ? palette.parchmentDim : palette.ember,
    border: `1px solid ${disabled ? palette.ash : palette.emberDim}`,
    borderRadius: radius.md,
    fontWeight: 600,
    fontSize: "0.9rem",
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

function ghostDangerButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(2)} ${space(4)}`,
    background: "transparent",
    color: disabled ? palette.parchmentDim : FUMBLE_RED,
    border: `1px solid ${disabled ? palette.ash : FUMBLE_RED}`,
    borderRadius: radius.md,
    fontWeight: 600,
    fontSize: "0.9rem",
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

const miniButtonStyle: React.CSSProperties = {
  padding: `${space(1)} ${space(2)}`,
  background: "transparent",
  color: "var(--text-dim)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.sm,
  fontSize: "0.74rem",
  fontWeight: 600,
  cursor: "pointer",
};

const miniDangerButtonStyle: React.CSSProperties = {
  padding: `${space(1)} ${space(2)}`,
  background: "transparent",
  color: FUMBLE_RED,
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.sm,
  fontSize: "0.74rem",
  fontWeight: 600,
  cursor: "pointer",
};
