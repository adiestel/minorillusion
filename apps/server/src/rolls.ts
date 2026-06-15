/**
 * Authoritative roll resolution (M5; DECISIONS D6 — we own rolls). The server is
 * the system of record: it rolls ONE fair die set, applies the *correct* modifier
 * derived from the character sheet (ability mod + proficiency where it applies),
 * honours advantage/disadvantage, and flags crit/fumble. The player's 3D die (M4)
 * only visualizes this result. Pure + RNG-injectable, so it's fully unit-tested.
 */
import {
  abilityModifier,
  proficiencyForLevel,
  SKILL_ABILITY,
  type Ability,
  type Character,
  type DieSides,
  type RollMode,
  type RollRequest,
  type Skill,
} from "@minorillusion/contract";

/** A uniform RNG in [0, 1). Injected so tests are deterministic. */
export type Rng = () => number;

/** Roll one die of `sides` faces (1..sides) from the RNG. */
function rollDie(sides: number, rng: Rng): number {
  return Math.floor(rng() * sides) + 1;
}

const ABILITY_NAME: Record<Ability, string> = {
  str: "Strength", dex: "Dexterity", con: "Constitution",
  int: "Intelligence", wis: "Wisdom", cha: "Charisma",
};

const SKILL_NAME: Record<Skill, string> = {
  acrobatics: "Acrobatics", animal_handling: "Animal Handling", arcana: "Arcana",
  athletics: "Athletics", deception: "Deception", history: "History",
  insight: "Insight", intimidation: "Intimidation", investigation: "Investigation",
  medicine: "Medicine", nature: "Nature", perception: "Perception",
  performance: "Performance", persuasion: "Persuasion", religion: "Religion",
  sleight_of_hand: "Sleight of Hand", stealth: "Stealth", survival: "Survival",
};

/** The resolved roll (the handler stamps id/createdAt/targetPlayerId onto this). */
export interface ResolvedRoll {
  label: string;
  characterName?: string;
  sides: DieSides;
  dice: number[];
  kept: number;
  modifier: number;
  total: number;
  mode: RollMode;
  crit: boolean;
  fumble: boolean;
}

/** A character's ability modifier (0 when no sheet is attached). */
function abilityMod(character: Character | undefined, a: Ability): number {
  return character ? abilityModifier(character.abilities[a]) : 0;
}

/** Proficiency bonus for a character (explicit override, else level-derived; 0 with no sheet). */
function profBonus(character: Character | undefined): number {
  if (!character) return 0;
  return character.proficiencyBonus ?? proficiencyForLevel(character.level);
}

function fmtMod(n: number): string {
  if (n === 0) return "";
  return n > 0 ? ` + ${n}` : ` − ${-n}`;
}

const MODE_SUFFIX: Record<RollMode, string> = {
  normal: "",
  advantage: " (Adv)",
  disadvantage: " (Dis)",
};

/**
 * Resolve a GM-called roll into a concrete result. `raw` rolls NdS+mod (no
 * advantage, no crit). Derived rolls (check/save/skill) roll a d20 — two for
 * advantage/disadvantage, keeping the higher/lower — add the sheet-correct
 * modifier, and flag a natural 20/1. `req.label` overrides the auto label.
 */
export function resolveRoll(
  req: RollRequest,
  character: Character | undefined,
  rng: Rng = Math.random,
): ResolvedRoll {
  const spec = req.spec;
  const mode: RollMode = req.mode ?? "normal";

  // --- raw NdS + modifier (damage, a flat roll): sum all dice, no crit. ---
  if (spec.kind === "raw") {
    const dice = Array.from({ length: spec.count }, () => rollDie(spec.sides, rng));
    const kept = dice.reduce((a, b) => a + b, 0);
    return {
      label: req.label ?? `${spec.count}d${spec.sides}${fmtMod(spec.modifier)}`,
      sides: spec.sides,
      dice,
      kept,
      modifier: spec.modifier,
      total: kept + spec.modifier,
      mode: "normal",
      crit: false,
      fumble: false,
    };
  }

  // --- derived d20 roll: correct modifier from the sheet. ---
  let modifier: number;
  let baseLabel: string;
  if (spec.kind === "check") {
    modifier = abilityMod(character, spec.ability);
    baseLabel = `${ABILITY_NAME[spec.ability]} Check`;
  } else if (spec.kind === "save") {
    const proficient = character?.saveProficiencies.includes(spec.ability) ?? false;
    modifier = abilityMod(character, spec.ability) + (proficient ? profBonus(character) : 0);
    baseLabel = `${ABILITY_NAME[spec.ability]} Save`;
  } else {
    // skill
    const ab = SKILL_ABILITY[spec.skill];
    const proficient = character?.skillProficiencies.includes(spec.skill) ?? false;
    modifier = abilityMod(character, ab) + (proficient ? profBonus(character) : 0);
    baseLabel = SKILL_NAME[spec.skill];
  }

  // Advantage/disadvantage rolls two d20 and keeps the higher/lower.
  const dice =
    mode === "normal" ? [rollDie(20, rng)] : [rollDie(20, rng), rollDie(20, rng)];
  const kept =
    mode === "advantage"
      ? Math.max(...dice)
      : mode === "disadvantage"
        ? Math.min(...dice)
        : dice[0]!;

  return {
    label: req.label ?? `${baseLabel}${MODE_SUFFIX[mode]}`,
    ...(character ? { characterName: character.name } : {}),
    sides: 20,
    dice,
    kept,
    modifier,
    total: kept + modifier,
    mode,
    crit: kept === 20,
    fumble: kept === 1,
  };
}
