/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { DebugAction } from "#coop/debug/actions";
import {
  type CatalogItem,
  catalogItem,
  ITEM_FAMILIES,
  type ItemFamily,
  itemCatalog,
  partyMembersFor,
} from "#coop/debug/catalog";
import {
  button,
  type Choice,
  chip,
  dangerButton,
  el,
  field,
  numberBox,
  picker,
  segmented,
  selectBox,
  switchButton,
  t,
} from "#coop/debug/dom";
import { hpBar, ownerTag, party, pokemonIcon, titleOf } from "#coop/debug/live";
import { debugChanges, debugSendsNow } from "#coop/debug/queue";
import {
  type DebugModes,
  emptyEnemyPlan,
  emptyWavePlan,
  MAX_LEVEL,
  MAX_MULTIPLIER,
  MAX_PLANNED_ENEMIES,
  MAX_PLANNED_REWARDS,
  type WavePlan,
} from "#coop/debug/state";
import { change, isPending, pendingAction, redraw, type SectionId, view } from "#coop/debug/view";
import type { Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { allAbilities, allMoves } from "#data/data-lists";
import { Gender } from "#data/gender";
import { getNatureName } from "#data/nature";
import { TerrainType } from "#data/terrain";
import { BiomeId } from "#enums/biome-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import { PokemonType } from "#enums/pokemon-type";
import { StatusEffect } from "#enums/status-effect";
import { TrainerType } from "#enums/trainer-type";
import { WeatherType } from "#enums/weather-type";
import type { PlayerPokemon } from "#field/pokemon";
import { MegaEvolutionAccessModifier, type PersistentModifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import { getBiomeName } from "#utils/common";

/**
 * The sections of the host's debug window (DECISIONS D42): Pokémon, Enemies & Field, Waves, Rewards & Shop, Modes, and the
 * quick buttons above them. Every control makes its change in one step (`view.change`): it waits for the next turn, or goes
 * at once on a reward screen.
 * @module
 */

// #region Lists

const lists = new Map<string, Choice[]>();

function enumChoices(values: Record<string, string | number>, skip: readonly number[] = []): Choice[] {
  return Object.entries(values)
    .filter(([, value]) => typeof value === "number" && !skip.includes(value))
    .map(([key, value]) => ({ label: titleOf(key), value: value as number }));
}

function list(name: string): Choice[] {
  const known = lists.get(name);
  if (known !== undefined) {
    return known;
  }
  let made: Choice[];
  switch (name) {
    case "species":
      made = speciesDataRegistry.getAllSpecies().map(species => ({ label: species.name, value: species.speciesId }));
      break;
    case "moves":
      made = allMoves
        .slice(1)
        .map(move => ({ label: move.name, value: move.id, note: titleOf(PokemonType[move.type]) }));
      break;
    case "abilities":
      made = allAbilities.slice(1).map(ability => ({ label: ability.name, value: ability.id }));
      break;
    case "natures":
      made = enumChoices(Nature as unknown as Record<string, number>).map(choice => ({
        ...choice,
        label: getNatureName(choice.value as Nature, true, false, true),
      }));
      break;
    case "trainers":
      made = enumChoices(TrainerType as unknown as Record<string, number>, [TrainerType.UNKNOWN]);
      break;
    case "encounters":
      made = enumChoices(MysteryEncounterType as unknown as Record<string, number>);
      break;
    case "biomes":
      made = enumChoices(BiomeId as unknown as Record<string, number>).map(choice => ({
        ...choice,
        label: getBiomeName(choice.value as BiomeId),
      }));
      break;
    case "types":
      made = enumChoices(PokemonType as unknown as Record<string, number>, [PokemonType.UNKNOWN]);
      break;
    default:
      made = [];
  }
  // (two entries with one name: the second says its number)
  const seen = new Set<string>();
  for (const choice of made) {
    if (seen.has(choice.label)) {
      choice.label = `${choice.label} #${choice.value}`;
    }
    seen.add(choice.label);
  }
  lists.set(name, made);
  return made;
}

const labelOf = (name: string, value: number | null): string =>
  value === null ? "" : (list(name).find(choice => choice.value === value)?.label ?? String(value));

// #endregion

// #region Helpers

/** A seed the host draws (not the battle's random numbers), so every client makes the same */
function seed(): number {
  return Math.floor(Math.random() * 1_000_000_000);
}

function seats(): Seat[] {
  return getCoopSession()?.players === 3 ? ["host", "guest", "guest2"] : ["host", "guest"];
}

function seatName(seat: Seat): string {
  return getCoopSession()?.nameOf(seat) ?? seat;
}

function currentWave(): number {
  return globalScene.currentBattle?.waveIndex ?? 0;
}

function modes(): DebugModes | null {
  return getCoopSession()?.debugState.modes ?? null;
}

/** A mode as it will be once what waits is sent */
function modeValue<K extends keyof DebugModes>(mode: K): DebugModes[K] | undefined {
  const waiting = pendingAction(`mode:${mode}`);
  if (waiting?.t === "mode") {
    return waiting.v as DebugModes[K];
  }
  return modes()?.[mode];
}

function setMode(mode: keyof DebugModes, v: boolean | number, note: string): void {
  change(note, `mode:${mode}`, { t: "mode", mode, v } as DebugAction);
}

const MODE_LABELS = (): Record<"freeShop" | "freeRerolls" | "noDamage" | "oneHit" | "shinyEnemies", string> => ({
  freeShop: t("FreeShop", "Free shop"),
  freeRerolls: t("FreeRerolls", "Free rerolls"),
  noDamage: t("NoDamage", "We take no damage"),
  oneHit: t("OneHit", "Our hits knock out"),
  shinyEnemies: t("ShinyEnemies", "Shiny enemies"),
});

function modeSwitch(mode: "freeShop" | "freeRerolls" | "noDamage" | "oneHit" | "shinyEnemies", label?: string) {
  const name = MODE_LABELS()[mode];
  const on = modeValue(mode) === true;
  return switchButton(label ?? name, on, next =>
    setMode(mode, next, `${name}: ${next ? t("On", "on") : t("Off", "off")}`),
  );
}

/** The number a picker and a number box are found by again after the window is drawn again */
function keep<T extends HTMLElement>(node: T, id: string): T {
  const input = node.matches("input, select") ? node : node.querySelector<HTMLElement>("input, select");
  if (input !== null) {
    input.dataset["keep"] = id;
  }
  return node;
}

// #endregion

// #region Quick buttons

export function quickBar(): HTMLElement {
  const money = (): number => {
    const waiting = pendingAction("money");
    return waiting?.t === "money" ? waiting.v : (globalScene.money ?? 0);
  };
  return el(
    "div",
    "cdw-quick",
    button(
      t("WinButton", "Win the wave"),
      () => change(t("SentWin", "Wave won"), "win", { t: "win" }),
      "cdw-btn cdw-hot",
    ),
    button(t("HealAll", "Heal team"), () =>
      change(t("SentHealAll", "Team healed"), "heal:all", { t: "heal", p: null }),
    ),
    button(t("AllLevel100", "Everyone Lv 100"), () =>
      change(
        t("SentAllLevel", "Everyone: level 100"),
        "level:all",
        ...party().map(pokemon => ({ t: "level", p: pokemon.id, v: 100 }) as DebugAction),
      ),
    ),
    button("+10k ₽", () => {
      const v = Math.min(1_000_000_000, money() + 10_000);
      change(t("SentMoney", "Money: {{v}}", { v: v.toLocaleString() }), "money", { t: "money", v });
    }),
    button(t("MasterBalls", "99 Master Balls"), () =>
      change(t("SentBalls", "{{what}}: {{v}}", { what: "Master Ball", v: 99 }), `balls:${PokeballType.MASTER_BALL}`, {
        t: "balls",
        ball: PokeballType.MASTER_BALL,
        v: 99,
      }),
    ),
    button(t("EnemiesHp1", "Enemies to 1 HP"), () =>
      change(t("SentEnemiesHp1", "Enemies: 1 HP"), "enemy:all:hp", { t: "enemy", e: null, what: "hp1", v: 0 }),
    ),
    modeSwitch("freeShop"),
    modeSwitch("noDamage", t("NoDamageShort", "No damage")),
  );
}

// #endregion

// #region Pokémon

/** What "Add a Pokémon" holds until it is added */
const addDraft = { species: null as Choice | null, level: 50, variant: -1, seat: "host" as Seat };

function heldItems(pokemon: PlayerPokemon): PokemonHeldItemModifier[] {
  try {
    return globalScene.findModifiers(
      modifier => modifier instanceof PokemonHeldItemModifier && modifier.pokemonId === pokemon.id,
    ) as PokemonHeldItemModifier[];
  } catch {
    return [];
  }
}

function modifierName(modifier: PersistentModifier): string {
  try {
    return modifier.type.name;
  } catch {
    return titleOf(modifier.type.id);
  }
}

/** The catalog's items of a kind, as a list to pick from; the ones for our team first */
function itemChoices(keepItem: (item: CatalogItem) => boolean, members: readonly PlayerPokemon[] = []): Choice[] {
  const choices: Choice[] = [];
  for (const item of itemCatalog()) {
    if (!keepItem(item)) {
      continue;
    }
    const fits = members.length === 0 ? [] : partyMembersFor(item.id, members);
    choices.push({
      label: item.name,
      value: item.id,
      note:
        fits.length > 0
          ? t("Fits", "fits {{who}}", { who: fits.map(p => p.name).join(", ") })
          : familyName(item.family),
      fits: fits.length > 0,
    });
  }
  return choices.sort((a, b) => Number(b.fits ?? false) - Number(a.fits ?? false));
}

function whoCard(pokemon: PlayerPokemon): HTMLElement {
  const p = pokemon.id;
  const name = pokemon.name;
  const owner = ownerTag(pokemon);
  const gender = pokemon.gender === Gender.MALE ? " · ♂" : pokemon.gender === Gender.FEMALE ? " · ♀" : "";
  let ability = "";
  try {
    ability = pokemon.getAbility().name;
  } catch {
    ability = "";
  }
  const where = pokemon.isOnField() ? t("OnField", "on the field") : t("Bench", "in the party");
  return el(
    "div",
    "cdw-who",
    pokemonIcon(pokemon, "cdw-icon-big"),
    el(
      "div",
      "",
      el(
        "div",
        "cdw-big",
        `${name} `,
        el("span", "cdw-meta", `Lv ${pokemon.level}${gender}${pokemon.shiny ? " · ★" : ""}`),
      ),
      el(
        "div",
        "cdw-meta",
        [
          owner.name === "" ? "" : t("Owner", "{{who}}'s", { who: owner.name }),
          where,
          getNatureName(pokemon.nature),
          ability,
        ]
          .filter(part => part !== "")
          .join(" · "),
      ),
    ),
    el(
      "div",
      "cdw-acts",
      button(
        t("HealOne", "Heal"),
        () => change(t("SentHeal", "{{name}} healed", { name }), `heal:${p}`, { t: "heal", p }),
        "cdw-btn cdw-small",
      ),
      button(
        "Lv 100",
        () =>
          change(t("SentLevel", "{{name}}: level {{v}}", { name, v: 100 }), `level:${p}`, { t: "level", p, v: 100 }),
        "cdw-btn cdw-small",
      ),
      button(
        t("Perfect", "IVs all 31"),
        () =>
          change(t("SentIvs", "{{name}}: IVs all 31", { name }), `ivs:${p}`, {
            t: "ivs",
            p,
            v: [31, 31, 31, 31, 31, 31],
          }),
        "cdw-btn cdw-small",
      ),
      button(
        t("MaxFriendship", "Max friendship"),
        () =>
          change(t("SentFriendship", "{{name}}: friendship {{v}}", { name, v: 255 }), `friendship:${p}`, {
            t: "friendship",
            p,
            v: 255,
          }),
        "cdw-btn cdw-small",
      ),
      button(
        t("MakeShiny", "Make shiny"),
        () =>
          change(t("SentShiny", "{{name}}: {{what}}", { name, what: "★" }), `shiny:${p}`, {
            t: "shiny",
            p,
            shiny: true,
            variant: 0,
          }),
        "cdw-btn cdw-small",
      ),
    ),
  );
}

/** Which slot "Teach a move" fills */
let moveSlot = 0;

function pokemonFields(pokemon: PlayerPokemon): HTMLElement[] {
  const p = pokemon.id;
  const name = pokemon.name;
  const fields: HTMLElement[] = [];

  fields.push(
    field(
      t("Level", "Level"),
      { hint: t("LevelHint", "Type a level and press Enter."), pending: isPending(`level:${p}`) },
      keep(
        numberBox(pokemon.level, 1, MAX_LEVEL, v =>
          change(t("SentLevel", "{{name}}: level {{v}}", { name, v }), `level:${p}`, { t: "level", p, v }),
        ),
        "level",
      ),
      ...[50, 100].map(v =>
        button(
          String(v),
          () => change(t("SentLevel", "{{name}}: level {{v}}", { name, v }), `level:${p}`, { t: "level", p, v }),
          "cdw-btn cdw-small",
        ),
      ),
    ),
  );
  fields.push(
    field(
      t("Nature", "Nature"),
      { hint: t("PickHint", "Applies as soon as you pick."), pending: isPending(`nature:${p}`) },
      selectBox(list("natures"), pokemon.nature, value =>
        change(t("SentNature", "{{name}}: {{what}}", { name, what: getNatureName(Number(value)) }), `nature:${p}`, {
          t: "nature",
          p,
          v: Number(value),
        }),
      ),
    ),
  );
  const abilityField = (passive: boolean) => {
    const label = passive ? t("Passive", "Passive") : t("Ability", "Ability");
    let current = "";
    try {
      current = passive ? pokemon.getPassiveAbility().name : pokemon.getAbility().name;
    } catch {
      current = "";
    }
    return field(
      label,
      {
        hint: passive
          ? t("PassiveHint", "Unlocked for this run. Own: its own passive.")
          : t("AbilityHint", "Pick from the list; it applies. Own: its own ability."),
        pending: isPending(`${passive ? "passive" : "ability"}:${p}`),
        words: current,
      },
      picker(
        () => list("abilities"),
        current === "" ? t("AbilitySearch", "Any ability…") : current,
        choice =>
          change(`${name}: ${label} ${choice.label}`, `${passive ? "passive" : "ability"}:${p}`, {
            t: passive ? "passive" : "ability",
            p,
            v: choice.value as number,
          }),
      ),
      button(
        t("Own", "Own"),
        () =>
          change(`${name}: ${label} ${t("OwnLower", "own")}`, `${passive ? "passive" : "ability"}:${p}`, {
            t: passive ? "passive" : "ability",
            p,
            v: 0,
          }),
        "cdw-btn cdw-small",
      ),
    );
  };
  fields.push(abilityField(false), abilityField(true));
  fields.push(
    field(
      t("Shiny", "Shiny"),
      { pending: isPending(`shiny:${p}`) },
      segmented(
        [
          { label: t("NotShiny", "No"), value: -1 },
          { label: "★", value: 0 },
          { label: "★★", value: 1 },
          { label: "★★★", value: 2 },
        ],
        pokemon.shiny ? pokemon.variant : -1,
        v =>
          change(
            t("SentShiny", "{{name}}: {{what}}", { name, what: v < 0 ? t("NotShiny", "No") : "★".repeat(v + 1) }),
            `shiny:${p}`,
            {
              t: "shiny",
              p,
              shiny: v >= 0,
              variant: Math.max(0, v) as 0 | 1 | 2,
            },
          ),
      ),
    ),
  );
  fields.push(
    field(
      t("GenderTera", "Gender · Tera type"),
      { pending: isPending(`gender:${p}`) || isPending(`tera:${p}`) },
      segmented(
        [
          { label: "♂", value: Gender.MALE },
          { label: "♀", value: Gender.FEMALE },
          { label: "—", value: Gender.GENDERLESS },
        ],
        pokemon.gender,
        v =>
          change(
            t("SentGender", "{{name}}: {{what}}", {
              name,
              what: v === Gender.MALE ? "♂" : v === Gender.FEMALE ? "♀" : "—",
            }),
            `gender:${p}`,
            { t: "gender", p, v },
          ),
      ),
      selectBox(list("types"), pokemon.teraType, value =>
        change(t("SentTera", "{{name}}: Tera {{what}}", { name, what: labelOf("types", Number(value)) }), `tera:${p}`, {
          t: "tera",
          p,
          v: Number(value),
        }),
      ),
    ),
  );

  // Moves: a card each; a click on one picks its slot for "Teach a move"
  const slotRow = segmented(
    [0, 1, 2, 3].map(slot => ({ label: t("Slot", "Slot {{n}}", { n: slot + 1 }), value: slot })),
    moveSlot,
    slot => {
      moveSlot = slot;
    },
  );
  const cards = el(
    "div",
    "cdw-moves",
    ...[0, 1, 2, 3].map(slot => {
      const move = pokemon.moveset[slot];
      if (move == null) {
        const empty = el("div", "cdw-move cdw-empty", t("EmptySlot", "Empty"));
        empty.addEventListener("click", () => {
          moveSlot = slot;
          (slotRow.children[slot] as HTMLElement | undefined)?.click();
        });
        return empty;
      }
      const data = allMoves[move.moveId];
      const card = el(
        "div",
        "cdw-move",
        move.getName(),
        el(
          "small",
          "",
          `${titleOf(PokemonType[data?.type ?? PokemonType.UNKNOWN])} · ${move.getMovePp() - move.ppUsed}/${move.getMovePp()} PP`,
        ),
        button(
          "×",
          () =>
            change(t("SentForget", "{{name}} forgets {{what}}", { name, what: move.getName() }), `move:${p}:${slot}`, {
              t: "move",
              p,
              slot,
              v: 0,
            }),
          "cdw-x",
        ),
      );
      card.title = t("SwapHint", "Click to teach a move in its place");
      card.addEventListener("click", event => {
        if ((event.target as HTMLElement).closest("button") === null) {
          (slotRow.children[slot] as HTMLElement | undefined)?.click();
        }
      });
      return card;
    }),
  );
  fields.push(
    field(
      t("Moves", "Moves"),
      {
        wide: true,
        hint: t("MovesHint", "Click a move (or pick a slot), then pick the move to teach there. × forgets it."),
        pending: [0, 1, 2, 3].some(slot => isPending(`move:${p}:${slot}`)),
        words: pokemon.moveset.map(move => move?.getName() ?? "").join(" "),
      },
      el(
        "div",
        "",
        cards,
        el(
          "div",
          "cdw-row",
          slotRow,
          picker(
            () => list("moves"),
            t("TeachMove", "Teach a move…"),
            choice =>
              change(t("SentMove", "{{name}} learns {{what}}", { name, what: choice.label }), `move:${p}:${moveSlot}`, {
                t: "move",
                p,
                slot: moveSlot,
                v: choice.value as number,
              }),
          ),
        ),
      ),
    ),
  );

  // Held items: what it has (× takes it away) and the whole catalog of held items
  const held = heldItems(pokemon);
  fields.push(
    field(
      t("HeldItems", "Held items"),
      {
        wide: true,
        hint: t("HeldHint", "The full catalog of held items, Mega Stones too. Pick again to give one more."),
        words: held.map(modifierName).join(" "),
      },
      el(
        "div",
        "cdw-chips",
        ...held.map((modifier, index) =>
          chip(`${modifierName(modifier)}${modifier.stackCount > 1 ? ` ×${modifier.stackCount}` : ""}`, () =>
            change(t("SentDrop", "{{name}} drops {{what}}", { name, what: modifierName(modifier) }), null, {
              t: "drop",
              p,
              index,
              key: modifier.type.id,
            }),
          ),
        ),
        keep(
          picker(
            () => itemChoices(item => item.held && item.family !== "random", [pokemon]),
            t("GiveItem", "Give an item…"),
            choice =>
              change(t("SentItem", "{{name}} gets {{what}}", { name, what: choice.label }), null, {
                t: "item",
                p,
                item: String(choice.value),
                count: 1,
              }),
            240,
          ),
          "held",
        ),
      ),
    ),
  );

  const ivNames = ["HP", "Atk", "Def", "SpA", "SpD", "Spe"];
  const ivInputs = pokemon.ivs.map(iv => {
    const input = el("input", "cdw-in");
    input.type = "text";
    input.inputMode = "numeric";
    input.value = String(iv);
    return input;
  });
  const sendIvs = (): void => {
    const v = ivInputs.map(input => Math.min(31, Math.max(0, Math.trunc(Number(input.value)) || 0)));
    if (v.some((iv, index) => iv !== pokemon.ivs[index])) {
      change(t("SentIvs", "{{name}}: IVs {{v}}", { name, v: v.join("/") }), `ivs:${p}`, { t: "ivs", p, v });
    }
  };
  for (const input of ivInputs) {
    input.addEventListener("change", sendIvs);
    input.addEventListener("keydown", event => event.key === "Enter" && sendIvs());
  }
  fields.push(
    field(
      t("Ivs", "IVs"),
      { hint: t("IvsHint", "0 to 31; Enter or leaving a box applies."), pending: isPending(`ivs:${p}`) },
      el("span", "cdw-ivs", ...ivInputs.map((input, index) => el("label", "", ivNames[index], input))),
      button(
        t("All31", "All 31"),
        () =>
          change(t("SentIvs", "{{name}}: IVs {{v}}", { name, v: "31" }), `ivs:${p}`, {
            t: "ivs",
            p,
            v: [31, 31, 31, 31, 31, 31],
          }),
        "cdw-btn cdw-small",
      ),
    ),
  );
  fields.push(
    field(
      t("SpeciesFusion", "Species · Fusion"),
      { hint: t("SpeciesHint", "Pick to apply."), pending: isPending(`species:${p}`) || isPending(`fusion:${p}`) },
      picker(
        () => list("species"),
        t("TurnInto", "Turn into…"),
        choice =>
          change(t("SentSpecies", "{{name}} becomes {{what}}", { name, what: choice.label }), `species:${p}`, {
            t: "species",
            p,
            v: choice.value as number,
            form: 0,
          }),
        150,
      ),
      picker(
        () => list("species"),
        t("FuseWith", "Fuse with…"),
        choice =>
          change(t("SentFusion", "{{name}} fused with {{what}}", { name, what: choice.label }), `fusion:${p}`, {
            t: "fusion",
            p,
            v: choice.value as number,
            form: 0,
          }),
        150,
      ),
      pokemon.isFusion()
        ? button(
            t("Unfuse", "Unfuse"),
            () =>
              change(t("SentUnfuse", "{{name}} unfused", { name }), `fusion:${p}`, { t: "fusion", p, v: 0, form: 0 }),
            "cdw-btn cdw-small",
          )
        : null,
    ),
  );
  fields.push(
    field(
      t("OwnerField", "Owner"),
      { hint: t("OwnerHint", "Who controls it in battle."), pending: isPending(`owner:${p}`) },
      segmented(
        seats().map(seat => ({ label: seatName(seat), value: seat })),
        getCoopSession()?.ownership.get(p),
        seat =>
          change(t("SentOwner", "{{name}} goes to {{who}}", { name, who: seatName(seat) }), `owner:${p}`, {
            t: "owner",
            p,
            seat,
          }),
      ),
    ),
  );
  fields.push(
    field(
      t("FriendshipRemove", "Friendship · Remove"),
      { pending: isPending(`friendship:${p}`) || isPending(`remove:${p}`) },
      keep(
        numberBox(
          pokemon.friendship,
          0,
          255,
          v =>
            change(t("SentFriendship", "{{name}}: friendship {{v}}", { name, v }), `friendship:${p}`, {
              t: "friendship",
              p,
              v,
            }),
          10,
        ),
        "friendship",
      ),
      dangerButton(t("Remove", "Remove from party"), t("RemoveSure", "Really remove?"), () =>
        change(t("SentRemove", "{{name}} removed", { name }), `remove:${p}`, { t: "remove", p }),
      ),
    ),
  );
  return fields;
}

function addPokemonField(): HTMLElement {
  const chosen = el("span", "cdw-meta", addDraft.species?.label ?? t("NoneChosen", "none chosen"));
  return field(
    t("AddHeading", "Add a Pokémon"),
    {
      wide: true,
      hint: t("AddHint", "The one place with an Add button: species, level, shiny and owner go together."),
    },
    picker(
      () => list("species"),
      t("SpeciesSearch", "Species…"),
      choice => {
        addDraft.species = choice;
        chosen.textContent = choice.label;
      },
    ),
    chosen,
    numberBox(addDraft.level, 1, MAX_LEVEL, v => {
      addDraft.level = v;
    }),
    segmented(
      [
        { label: t("NotShiny", "No"), value: -1 },
        { label: "★", value: 0 },
        { label: "★★", value: 1 },
        { label: "★★★", value: 2 },
      ],
      addDraft.variant,
      v => {
        addDraft.variant = v;
      },
    ),
    segmented(
      seats().map(seat => ({ label: t("ForWho", "For {{who}}", { who: seatName(seat) }), value: seat })),
      addDraft.seat,
      seat => {
        addDraft.seat = seat;
      },
    ),
    button(
      t("AddButton", "Add"),
      () => {
        const species = addDraft.species;
        if (species === null) {
          return;
        }
        change(
          t("SentAdd", "{{what}} Lv {{v}} joins {{who}}", {
            what: species.label,
            v: addDraft.level,
            who: seatName(addDraft.seat),
          }),
          null,
          {
            t: "add",
            seat: addDraft.seat,
            species: species.value as number,
            form: 0,
            level: addDraft.level,
            shiny: addDraft.variant >= 0,
            variant: Math.max(0, addDraft.variant) as 0 | 1 | 2,
            seed: seed(),
          },
        );
      },
      "cdw-btn",
    ),
  );
}

function pokemonSection(): HTMLElement[] {
  const members = party();
  if (view.selected === null || !members.some(pokemon => pokemon.id === view.selected)) {
    view.selected = members[0]?.id ?? null;
  }
  const pokemon = members.find(member => member.id === view.selected) ?? null;
  const blocks: HTMLElement[] = [];
  if (pokemon !== null) {
    blocks.push(whoCard(pokemon), el("div", "cdw-grid", ...pokemonFields(pokemon)));
  }
  blocks.push(el("div", "cdw-grid", addPokemonField()));
  return blocks;
}

// #endregion

// #region Enemies & Field

const STATUSES: readonly StatusEffect[] = [
  StatusEffect.PARALYSIS,
  StatusEffect.BURN,
  StatusEffect.POISON,
  StatusEffect.TOXIC,
  StatusEffect.SLEEP,
  StatusEffect.FREEZE,
];

function enemiesSection(): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  let enemyField: (ReturnType<typeof globalScene.getEnemyField>[number] | undefined)[] = [];
  try {
    enemyField = globalScene.getEnemyField();
  } catch {
    enemyField = [];
  }
  const hpButtons = (e: number | null, who: string) =>
    (
      [
        ["faint", t("Faint", "Faint")],
        ["hp1", t("Hp1", "1 HP")],
        ["heal", t("FullHeal", "Full HP")],
      ] as const
    ).map(([what, label]) =>
      button(
        label,
        () =>
          change(t("SentEnemy", "{{who}}: {{what}}", { who, what: label }), `enemy:${e ?? "all"}:hp`, {
            t: "enemy",
            e,
            what,
            v: 0,
          }),
        "cdw-btn cdw-small",
      ),
    );
  const cards: HTMLElement[] = [];
  for (const [index, enemy] of enemyField.entries()) {
    if (enemy == null || !enemy.isActive(true)) {
      continue;
    }
    const boss =
      enemy.isBoss() && enemy.bossSegments > 1
        ? t("BossBars", "boss, {{n}} of {{of}} bars left", { n: enemy.bossSegmentIndex + 1, of: enemy.bossSegments })
        : "";
    const node = el(
      "div",
      "cdw-f",
      el(
        "div",
        "cdw-enemy",
        pokemonIcon(enemy, "cdw-icon-big"),
        el(
          "div",
          "",
          el("span", "cdw-big", `${enemy.name} `),
          el("span", "cdw-meta", [`Lv ${enemy.level}`, boss].filter(Boolean).join(" · ")),
        ),
        el("div", "cdw-row", ...hpButtons(index, enemy.name)),
        el(
          "div",
          "cdw-hp",
          hpBar(enemy),
          t("LevelWord", "level"),
          keep(
            numberBox(enemy.level, 1, MAX_LEVEL, v =>
              change(t("SentEnemyLevel", "{{who}}: level {{v}}", { who: enemy.name, v }), `enemy:${index}:level`, {
                t: "enemy",
                e: index,
                what: "level",
                v,
              }),
            ),
            `enemy-level-${index}`,
          ),
        ),
      ),
    );
    node.dataset["search"] = `${enemy.name} enemy faint hp level boss`.toLowerCase();
    cards.push(node);
  }
  if (cards.length === 0) {
    blocks.push(
      el("div", "cdw-note", t("NoBattleHint", "No battle right now: the enemy buttons work once one starts.")),
    );
  } else {
    blocks.push(...cards);
  }
  blocks.push(
    el(
      "div",
      "cdw-grid",
      field(
        t("EveryEnemy", "Every enemy"),
        { hint: t("EveryEnemyHint", "Applies to every enemy on the field.") },
        ...hpButtons(null, t("AllEnemies", "Every enemy")),
      ),
      field(
        t("Stages", "Stat stages"),
        { words: "stages boost" },
        ...(
          [
            ["party", 6, t("UsMax", "Us +6")],
            ["party", 0, t("UsReset", "Us 0")],
            ["enemy", -6, t("ThemMin", "Them −6")],
            ["enemy", 0, t("ThemReset", "Them 0")],
          ] as const
        ).map(([side, v, label]) =>
          button(
            label,
            () =>
              change(t("SentStages", "Stat stages: {{what}}", { what: label }), `stages:${side}`, {
                t: "stages",
                side,
                v,
              }),
            "cdw-btn cdw-small",
          ),
        ),
      ),
      field(
        t("Status", "Status"),
        {
          hint: t("StatusHint", "A status goes on every enemy. Cure us clears ours."),
          words: "paralysis burn poison sleep freeze",
        },
        ...STATUSES.map(status =>
          button(
            titleOf(StatusEffect[status]),
            () =>
              change(t("SentStatus", "Enemies: {{what}}", { what: titleOf(StatusEffect[status]) }), "status:enemy", {
                t: "status",
                side: "enemy",
                v: status,
              }),
            "cdw-btn cdw-small",
          ),
        ),
        button(
          t("CureUs", "Cure us"),
          () =>
            change(t("SentCure", "Our status cured"), "status:party", {
              t: "status",
              side: "party",
              v: StatusEffect.NONE,
            }),
          "cdw-btn cdw-small",
        ),
      ),
      field(
        t("Weather", "Weather"),
        { wide: true, pending: isPending("weather") },
        segmented(
          enumChoices(WeatherType as unknown as Record<string, number>).map(choice => ({
            label: choice.label,
            value: choice.value as number,
          })),
          globalScene.arena?.weather?.weatherType ?? WeatherType.NONE,
          v =>
            change(t("SentWeather", "Weather: {{what}}", { what: titleOf(WeatherType[v]) }), "weather", {
              t: "weather",
              v,
            }),
        ),
      ),
      field(
        t("Terrain", "Terrain"),
        { wide: true, pending: isPending("terrain") },
        segmented(
          enumChoices(TerrainType as unknown as Record<string, number>).map(choice => ({
            label: choice.label,
            value: choice.value as number,
          })),
          globalScene.arena?.terrain?.terrainType ?? TerrainType.NONE,
          v =>
            change(t("SentTerrain", "Terrain: {{what}}", { what: titleOf(TerrainType[v]) }), "terrain", {
              t: "terrain",
              v,
            }),
        ),
      ),
    ),
  );
  return blocks;
}

// #endregion

// #region Waves

/** The plan of a wave as it will be once what waits is sent */
function planOf(wave: number): WavePlan {
  const waiting = pendingAction(`plan:${wave}`);
  if (waiting?.t === "plan") {
    return structuredClone(waiting.plan ?? emptyWavePlan());
  }
  return structuredClone(getCoopSession()?.debugState.plans[String(wave)] ?? emptyWavePlan());
}

function savePlan(wave: number, plan: WavePlan | null, note: string): void {
  change(note, `plan:${wave}`, { t: "plan", wave, plan: plan === null ? null : structuredClone(plan) });
  redraw();
}

function planSummary(plan: WavePlan): string {
  const kind = {
    game: t("KindGame", "Game's choice"),
    wild: t("KindWild", "Wild"),
    trainer: t("KindTrainer", "Trainer"),
    me: t("KindMe", "Mystery Encounter"),
  }[plan.battle];
  return [
    kind,
    plan.enemies
      .flatMap(enemy => (enemy?.species == null ? [] : [speciesDataRegistry.getSpecies(enemy.species).name]))
      .join(", "),
    plan.trainer === null ? "" : labelOf("trainers", plan.trainer),
    plan.encounter === null ? "" : labelOf("encounters", plan.encounter),
  ]
    .filter(part => part !== "")
    .join(" · ");
}

function wavesSection(): HTMLElement[] {
  const next = currentWave() + 1;
  if (view.planWave < next) {
    view.planWave = next;
  }
  const wave = view.planWave;
  const plan = planOf(wave);
  const note = t("SentPlan", "Wave {{wave}}: plan changed", { wave });
  const state = getCoopSession()?.debugState;
  const fields: HTMLElement[] = [];

  fields.push(
    field(
      t("PlanWave", "Plan wave"),
      {
        wide: true,
        hint: t("PlanHint", "Every change saves the plan. There's no Save button."),
        pending: isPending(`plan:${wave}`),
      },
      keep(
        numberBox(wave, next, 100_000, v => {
          view.planWave = v;
          redraw();
        }),
        "plan-wave",
      ),
      segmented(
        [
          { label: t("KindGame", "Game's choice"), value: "game" as const },
          { label: t("KindWild", "Wild"), value: "wild" as const },
          { label: t("KindTrainer", "Trainer"), value: "trainer" as const },
          { label: t("KindMe", "Mystery Encounter"), value: "me" as const },
        ],
        plan.battle,
        battle => savePlan(wave, { ...plan, battle }, note),
      ),
      button(
        t("ClearPlan", "Clear plan"),
        () => savePlan(wave, null, t("SentClearPlan", "Wave {{wave}}: plan cleared", { wave })),
        "cdw-btn cdw-small",
      ),
    ),
  );
  fields.push(
    field(
      t("Enemies", "Enemies, in order"),
      {
        wide: true,
        hint: t("EnemiesHint", "Pick a species and it joins the plan (up to {{n}}).", { n: MAX_PLANNED_ENEMIES }),
      },
      el(
        "div",
        "cdw-chips",
        ...plan.enemies.map((enemy, index) =>
          chip(enemy?.species == null ? "?" : speciesDataRegistry.getSpecies(enemy.species).name, () => {
            plan.enemies.splice(index, 1);
            savePlan(wave, plan, note);
          }),
        ),
        plan.enemies.length < MAX_PLANNED_ENEMIES
          ? keep(
              picker(
                () => list("species"),
                t("AddEnemy", "Add an enemy…"),
                choice => {
                  plan.enemies.push({ ...emptyEnemyPlan(), species: choice.value as number });
                  savePlan(wave, { ...plan, battle: plan.battle === "game" ? "wild" : plan.battle }, note);
                },
              ),
              "plan-species",
            )
          : null,
      ),
    ),
  );
  fields.push(
    field(
      t("Trainer", "Trainer"),
      { hint: t("TrainerHint", "For a trainer battle.") },
      plan.trainer === null
        ? null
        : chip(labelOf("trainers", plan.trainer), () => savePlan(wave, { ...plan, trainer: null }, note)),
      picker(
        () => list("trainers"),
        t("TrainerSearch", "Any trainer…"),
        choice => savePlan(wave, { ...plan, battle: "trainer", trainer: choice.value as number }, note),
      ),
    ),
  );
  fields.push(
    field(
      t("Encounter", "Mystery Encounter"),
      { hint: t("EncounterHint", "For a Mystery Encounter.") },
      plan.encounter === null
        ? null
        : chip(labelOf("encounters", plan.encounter), () => savePlan(wave, { ...plan, encounter: null }, note)),
      picker(
        () => list("encounters"),
        t("EncounterSearch", "Any encounter…"),
        choice => savePlan(wave, { ...plan, battle: "me", encounter: choice.value as number }, note),
      ),
    ),
  );

  // Every planned wave, the waiting plans too (a waiting "clear" takes one out)
  const waves = new Set(Object.keys(state?.plans ?? {}).map(Number));
  for (const entry of debugChanges()) {
    const action = entry.actions.at(-1);
    if (entry.state === "pending" && action?.t === "plan") {
      if (action.plan === null) {
        waves.delete(action.wave);
      } else {
        waves.add(action.wave);
      }
    }
  }
  const rows = [...waves]
    .sort((a, b) => a - b)
    .map(w => {
      const row = el(
        "tr",
        "",
        el("td", "", t("WaveN", "Wave {{n}}", { n: w })),
        el("td", "", planSummary(planOf(w))),
        el(
          "td",
          "",
          button(
            t("Edit", "Edit"),
            () => {
              view.planWave = w;
              redraw();
            },
            "cdw-btn cdw-small",
          ),
          " ",
          button(
            t("Clear", "Clear"),
            () => savePlan(w, null, t("SentClearPlan", "Wave {{wave}}: plan cleared", { wave: w })),
            "cdw-btn cdw-small",
          ),
        ),
      );
      return row;
    });
  fields.push(
    field(
      t("Planned", "Planned waves"),
      { wide: true },
      rows.length === 0
        ? el("span", "cdw-empty", t("NoPlans", "No wave planned."))
        : el("table", "cdw-table", el("tbody", "", ...rows)),
    ),
  );

  const jumpWaiting = pendingAction("jump");
  const jump = jumpWaiting?.t === "jump" ? jumpWaiting.v : (state?.jump ?? null);
  let jumpTo = Math.max(next + 1, jump ?? next + 9);
  fields.push(
    field(
      t("Jump", "Jump ahead"),
      { hint: t("JumpHint", "After this wave, the run goes on at that wave."), pending: isPending("jump") },
      keep(
        numberBox(jumpTo, next + 1, 100_000, v => {
          jumpTo = v;
        }),
        "jump",
      ),
      button(
        t("JumpButton", "Jump after this wave"),
        () => change(t("SentJump", "Next wave: {{v}}", { v: jumpTo }), "jump", { t: "jump", v: jumpTo }),
        "cdw-btn cdw-small",
      ),
      jump === null
        ? null
        : chip(t("JumpSet", "to wave {{v}}", { v: jump }), () =>
            change(t("SentNoJump", "No jump"), "jump", { t: "jump", v: null }),
          ),
    ),
  );
  const biomeWaiting = pendingAction("biome");
  const biome = biomeWaiting?.t === "biome" ? biomeWaiting.v : (state?.biome ?? null);
  fields.push(
    field(
      t("Biome", "Next biome"),
      { hint: t("BiomeHint", "Pick one; you go there after this wave."), pending: isPending("biome") },
      biome === null
        ? null
        : chip(getBiomeName(biome as BiomeId), () =>
            change(t("SentNoBiome", "No biome change"), "biome", { t: "biome", v: null }),
          ),
      picker(
        () => list("biomes"),
        t("BiomeSearch", "Any biome…"),
        choice =>
          change(t("SentBiome", "Next biome: {{what}}", { what: choice.label }), "biome", {
            t: "biome",
            v: choice.value as number,
          }),
        180,
      ),
    ),
  );
  return [el("div", "cdw-grid", ...fields)];
}

// #endregion

// #region Rewards & Shop

export function familyName(family: ItemFamily): string {
  return {
    balls: t("FamBalls", "Poké Balls"),
    pokemon: t("FamPokemon", "Pokémon items"),
    berries: t("FamBerries", "Berries"),
    held: t("FamHeld", "Held items"),
    boosters: t("FamBoosters", "Type boosters"),
    evolution: t("FamEvolution", "Evolution items"),
    forms: t("FamForms", "Mega Stones & forms"),
    tms: t("FamTms", "TMs"),
    mints: t("FamMints", "Mints"),
    tera: t("FamTera", "Tera Shards"),
    battle: t("FamBattle", "Battle items"),
    team: t("FamTeam", "Team items"),
    other: t("FamOther", "Other"),
    random: t("FamRandom", "Game picks"),
  }[family];
}

/** The next reward screen's items as they will be once what waits is sent */
function rewardDraft(): string[] {
  const waiting = pendingAction("rewards");
  if (waiting?.t === "rewards") {
    return [...(waiting.items ?? [])];
  }
  const planned = getCoopSession()?.debugState.rewards;
  if (planned != null) {
    return [...planned];
  }
  if (debugSendsNow()) {
    // An open screen drawn with the host's items used them up: they are still the ones it shows, and a pick joins them
    const wave = currentWave();
    const changes = debugChanges();
    for (let index = changes.length - 1; index >= 0; index--) {
      const entry = changes[index];
      const action = entry.actions.at(-1);
      const thisScreen = entry.state === "sent" || (entry.where?.wave === wave && entry.where.turn === null);
      if (action?.t === "rewards" && thisScreen) {
        return [...(action.items ?? [])];
      }
    }
  }
  return [];
}

function setRewards(items: string[]): void {
  const names = items.map(id => catalogItem(id)?.name ?? id);
  change(
    items.length === 0
      ? t("SentNoRewards", "Rewards: the game's")
      : debugSendsNow()
        ? t("SentRewardsNow", "Reward screen redrawn: {{what}}", { what: names.join(", ") })
        : t("SentRewards", "Next rewards: {{what}}", { what: names.join(", ") }),
    "rewards",
    { t: "rewards", items: items.length === 0 ? null : items },
  );
  redraw();
}

function hasMegaBracelet(): boolean {
  try {
    return globalScene.findModifier(modifier => modifier instanceof MegaEvolutionAccessModifier) !== undefined;
  } catch {
    return false;
  }
}

/** The whole catalog: the groups down the side, the items of one (or what its search finds) */
function catalogBrowser(onPick: (item: CatalogItem) => void): HTMLElement {
  const catalog = itemCatalog();
  const members = party();
  const families = el("div", "cdw-families");
  const head = el("div", "cdw-cat-head");
  const info = el("div", "cdw-info");
  const grid = el("div", "cdw-items");
  const search = el("input", "cdw-in");
  search.type = "text";
  search.placeholder = t("SearchItems", "Search all items…");
  search.value = view.itemSearch;
  search.style.width = "100%";
  search.style.marginBottom = "6px";
  search.dataset["keep"] = "item-search";

  const drawItems = (): void => {
    const query = view.itemSearch.trim().toLowerCase();
    let shown =
      query === ""
        ? catalog.filter(item => item.family === view.family)
        : catalog.filter(item => item.name.toLowerCase().includes(query));
    const fits = new Map(shown.map(item => [item.id, partyMembersFor(item.id, members)]));
    shown = [...shown].sort(
      (a, b) => Number((fits.get(b.id)?.length ?? 0) > 0) - Number((fits.get(a.id)?.length ?? 0) > 0),
    );
    for (const node of Array.from(families.children)) {
      const family = (node as HTMLElement).dataset["family"];
      node.classList.toggle("cdw-on", query === "" && family === view.family);
    }
    head.replaceChildren(
      el(
        "span",
        "",
        query === ""
          ? familyName(view.family)
          : t("Matches", "{{n}} match “{{q}}”", { n: shown.length, q: view.itemSearch.trim() }),
      ),
    );
    const showMega =
      !hasMegaBracelet() && (query === "" ? view.family === "forms" : shown.some(item => item.family === "forms"));
    info.hidden = !showMega;
    info.replaceChildren(
      t(
        "NoBracelet",
        "No Mega Bracelet yet. Held Mega Stones still work: the bracelet only lets the game roll them by itself.",
      ),
      " ",
      button(
        t("GiveBracelet", "Give the team a Mega Bracelet"),
        () =>
          change(t("SentTeamItem", "Team gets {{what}}", { what: "Mega Bracelet" }), "bracelet", {
            t: "item",
            p: null,
            item: "MEGA_BRACELET",
            count: 1,
          }),
        "cdw-btn cdw-small",
      ),
    );
    grid.replaceChildren(
      ...shown.slice(0, 400).map(item => {
        const who = fits.get(item.id) ?? [];
        const node = el(
          "button",
          `cdw-item${who.length > 0 ? " cdw-fits" : ""}`,
          item.name,
          el(
            "small",
            "",
            who.length > 0
              ? t("FitsOurs", "fits {{who}} on our team", { who: who.map(p => p.name).join(", ") })
              : query === ""
                ? ""
                : familyName(item.family),
          ),
        );
        node.type = "button";
        node.dataset["item"] = item.id;
        node.addEventListener("click", () => onPick(item));
        return node;
      }),
    );
    if (shown.length === 0) {
      grid.append(el("div", "cdw-empty", t("NoMatch", "Nothing matches.")));
    }
  };
  for (const family of ITEM_FAMILIES) {
    const count = catalog.filter(item => item.family === family).length;
    if (count === 0) {
      continue;
    }
    const node = button(
      "",
      () => {
        view.family = family;
        view.itemSearch = "";
        search.value = "";
        drawItems();
      },
      "",
    );
    node.dataset["family"] = family;
    node.append(el("span", "", familyName(family)), el("small", "", String(count)));
    families.append(node);
  }
  search.addEventListener("input", () => {
    view.itemSearch = search.value;
    drawItems();
  });
  drawItems();
  return el("div", "cdw-catalog", el("div", "", search, families), el("div", "", head, info, grid));
}

function rewardsSection(): HTMLElement[] {
  const draft = rewardDraft();
  const fields: HTMLElement[] = [];
  const count = el("span", "cdw-count", `${draft.length} / ${MAX_PLANNED_REWARDS}`);
  const rewardField = field(
    t("RewardHeading", "Next reward screen"),
    {
      wide: true,
      hint: debugSendsNow()
        ? t(
            "RewardHintNow",
            "The whole catalog, every exact item. A reward screen is open: it redraws with these at once.",
          )
        : t("RewardHint", "The whole catalog, every exact item. Click one to add it (up to 8)."),
      pending: isPending("rewards"),
      words: "items catalog mega stone evolution tm berry",
    },
    el(
      "div",
      "",
      el(
        "div",
        "cdw-chips",
        ...draft.map((id, index) =>
          chip(catalogItem(id)?.name ?? id, () => setRewards(draft.filter((_, at) => at !== index))),
        ),
        draft.length === 0 ? el("span", "cdw-empty", t("RewardsGame", "The game's own items.")) : null,
        draft.length === 0
          ? null
          : button(t("GameChoiceRewards", "Game's choice"), () => setRewards([]), "cdw-btn cdw-small"),
      ),
      catalogBrowser(item => {
        if (draft.length < MAX_PLANNED_REWARDS) {
          setRewards([...draft, item.id]);
        }
      }),
    ),
  );
  rewardField.querySelector("label")?.append(count);
  fields.push(rewardField);

  const waitingMoney = pendingAction("money");
  const money = waitingMoney?.t === "money" ? waitingMoney.v : (globalScene.money ?? 0);
  fields.push(
    field(
      t("Money", "Money"),
      { hint: t("MoneyHint", "Type an amount and press Enter."), pending: isPending("money") },
      keep(
        numberBox(
          money,
          0,
          1_000_000_000,
          v => change(t("SentMoney", "Money: {{v}}", { v: v.toLocaleString() }), "money", { t: "money", v }),
          1000,
          120,
        ),
        "money",
      ),
      button(
        "+10k",
        () => {
          const v = Math.min(1_000_000_000, money + 10_000);
          change(t("SentMoney", "Money: {{v}}", { v: v.toLocaleString() }), "money", { t: "money", v });
        },
        "cdw-btn cdw-small",
      ),
    ),
  );
  fields.push(field(t("Shop", "Shop"), {}, modeSwitch("freeShop"), modeSwitch("freeRerolls")));
  const balls = [
    PokeballType.POKEBALL,
    PokeballType.GREAT_BALL,
    PokeballType.ULTRA_BALL,
    PokeballType.ROGUE_BALL,
    PokeballType.MASTER_BALL,
  ];
  fields.push(
    field(
      t("Balls", "Poké Balls"),
      { wide: true, hint: t("BallsHint", "How many of each; Enter applies."), words: "pokeball master ball" },
      ...balls.map(ball => {
        const waiting = pendingAction(`balls:${ball}`);
        const value = waiting?.t === "balls" ? waiting.v : (globalScene.pokeballCounts?.[ball] ?? 0);
        const label = titleOf(PokeballType[ball]).replace(" Ball", "").replace("Pokeball", "Poké");
        return el(
          "span",
          "cdw-row",
          label,
          keep(
            numberBox(
              value,
              0,
              999,
              v =>
                change(t("SentBalls", "{{what}}: {{v}}", { what: titleOf(PokeballType[ball]), v }), `balls:${ball}`, {
                  t: "balls",
                  ball,
                  v,
                }),
              48,
            ),
            `ball-${ball}`,
          ),
        );
      }),
    ),
  );
  let teamItems: PersistentModifier[] = [];
  try {
    teamItems = globalScene.modifiers.filter(modifier => !(modifier instanceof PokemonHeldItemModifier));
  } catch {
    teamItems = [];
  }
  fields.push(
    field(
      t("TeamItems", "Team items"),
      {
        wide: true,
        hint: t("TeamHint", "Pick to give the team one; pick again for more."),
        words: teamItems.map(modifierName).join(" "),
      },
      el(
        "div",
        "cdw-chips",
        ...teamItems.map(modifier =>
          chip(`${modifierName(modifier)}${modifier.stackCount > 1 ? ` ×${modifier.stackCount}` : ""}`),
        ),
        picker(
          () => itemChoices(item => item.team),
          t("TeamItemSearch", "Give a team item…"),
          choice =>
            change(t("SentTeamItem", "Team gets {{what}}", { what: choice.label }), null, {
              t: "item",
              p: null,
              item: String(choice.value),
              count: 1,
            }),
        ),
      ),
    ),
  );
  return [el("div", "cdw-grid", ...fields)];
}

// #endregion

// #region Modes

function multiplierField(mode: "exp" | "money", label: string): HTMLElement {
  const value = Number(modeValue(mode) ?? 1);
  return field(
    label,
    { pending: isPending(`mode:${mode}`), hint: t("MultiplierHint", "1 to {{n}}.", { n: MAX_MULTIPLIER }) },
    segmented(
      [1, 2, 5, 10].map(v => ({ label: `×${v}`, value: v })),
      value,
      v => setMode(mode, v, `${label} ×${v}`),
    ),
    keep(
      numberBox(value, 1, MAX_MULTIPLIER, v => setMode(mode, v, `${label} ×${v}`), 1, 56),
      `mode-${mode}`,
    ),
  );
}

function modesSection(): HTMLElement[] {
  const enemyLevel = Number(modeValue("enemyLevel") ?? 0);
  return [
    el(
      "div",
      "cdw-grid",
      field(t("OurSide", "Our side"), { words: "damage knock out" }, modeSwitch("noDamage"), modeSwitch("oneHit")),
      field(
        t("EnemySide", "Enemies"),
        {
          hint: t("EnemyLevelHint", "Every enemy's level from now; 0: the game's."),
          pending: isPending("mode:enemyLevel"),
        },
        modeSwitch("shinyEnemies"),
        t("LevelWord", "level"),
        keep(
          numberBox(enemyLevel, 0, MAX_LEVEL, v =>
            setMode("enemyLevel", v, t("SentAllEnemyLevel", "Enemies from now: level {{v}}", { v })),
          ),
          "enemy-level",
        ),
      ),
      multiplierField("exp", t("ExpTimes", "EXP")),
      multiplierField("money", t("MoneyTimes", "Money")),
      field(
        t("Chaos", "Chaos"),
        { wide: true, words: "random randomize shiny" },
        dangerButton(t("Randomize", "Random species for our team"), t("RandomizeSure", "Really randomize?"), () =>
          change(t("SentRandomize", "Team randomized"), null, { t: "randomize", seed: seed() }),
        ),
        button(
          t("AllShiny", "All shiny"),
          () => change(t("SentAllShiny", "Everyone is shiny"), "allShiny", { t: "allShiny" }),
          "cdw-btn cdw-small",
        ),
      ),
    ),
  ];
}

// #endregion

export const SECTION_LABELS = (): Record<SectionId, string> => ({
  pokemon: t("TabPokemon", "Pokémon"),
  enemies: t("TabEnemies", "Enemies & Field"),
  waves: t("TabWaves", "Waves"),
  rewards: t("TabRewards", "Rewards & Shop"),
  modes: t("TabModes", "Modes"),
});

export function sectionBlocks(section: SectionId): HTMLElement[] {
  switch (section) {
    case "pokemon":
      return pokemonSection();
    case "enemies":
      return enemiesSection();
    case "waves":
      return wavesSection();
    case "rewards":
      return rewardsSection();
    case "modes":
      return modesSection();
  }
}

/** The search across every section: the cards whose words have what was typed */
export function searchBlocks(query: string): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  const q = query.trim().toLowerCase();
  for (const [section, label] of Object.entries(SECTION_LABELS()) as [SectionId, string][]) {
    const found: HTMLElement[] = [];
    for (const block of sectionBlocks(section)) {
      const cards = block.matches(".cdw-f") ? [block] : Array.from(block.querySelectorAll<HTMLElement>(".cdw-f"));
      found.push(...cards.filter(card => (card.dataset["search"] ?? "").includes(q)));
    }
    if (found.length > 0) {
      blocks.push(el("div", "cdw-section-h", label), el("div", "cdw-grid", ...found));
    }
  }
  if (blocks.length === 0) {
    blocks.push(el("div", "cdw-empty", t("NoMatch", "Nothing matches.")));
  }
  return blocks;
}
