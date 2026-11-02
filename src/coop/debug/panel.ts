/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { DebugAction } from "#coop/debug/actions";
import { debugSendsNow, onDebugQueue, queueDebug, waitingDebug } from "#coop/debug/queue";
import { emptyWavePlan, MAX_PLANNED_REWARDS, MAX_PLANNED_SPECIES, type WavePlan } from "#coop/debug/state";
import type { Seat } from "#coop/protocol";
import { getCoopSession } from "#coop/session";
import { coopText } from "#coop/text";
import { allAbilities, allMoves, modifierTypes } from "#data/data-lists";
import { getNatureName } from "#data/nature";
import { TerrainType } from "#data/terrain";
import { BiomeId } from "#enums/biome-id";
import { Button } from "#enums/buttons";
import { Device } from "#enums/devices";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import { PokemonType } from "#enums/pokemon-type";
import { StatusEffect } from "#enums/status-effect";
import { TrainerType } from "#enums/trainer-type";
import { UiMode } from "#enums/ui-mode";
import { WeatherType } from "#enums/weather-type";
import type { PlayerPokemon } from "#field/pokemon";
import { getButtonWithKeycode } from "#inputs/config-handler";
import { PersistentModifier } from "#modifiers/modifier";
import { PokemonHeldItemModifierType, PokemonModifierType } from "#modifiers/modifier-type";
import { getBiomeName } from "#utils/common";
import Phaser from "phaser";

/**
 * The host's debug menu (DECISIONS D42): a side panel over the game, like the chat box, that only the host of a run with
 * the menu on has. Its key (F8 at first) opens and closes it. What it does goes into the queue of cheats
 * ({@linkcode queueDebug}): each goes to every client with the next turn, or at once on a reward screen. The guests see
 * no panel and no notice, only what changes.
 * @module
 */

const ROOT_ID = "coopDebug";

type TabId = "party" | "waves" | "rewards" | "battle" | "fun";

interface Parts {
  root: HTMLElement;
  tabs: HTMLElement;
  search: HTMLInputElement;
  body: HTMLElement;
  status: HTMLElement;
}

/** One entry of a search list: what is shown and typed, and what it stands for */
interface Choice {
  label: string;
  value: number | string;
}

let parts: Parts | null = null;
let running = false;
let open = false;
let tab: TabId = "party";
let selected: number | null = null;
/** The last thing the host did, said in the status line */
let lastNote = "";
let stopQueueListener: (() => void) | null = null;
/** The plan being edited in the Waves tab, until it is saved */
let draftPlan: WavePlan = emptyWavePlan();
let draftWave = 0;
/** The items being chosen for the next reward screen */
let draftRewards: string[] = [];

const t = (key: string, text: string, vars: Record<string, string | number> = {}): string =>
  coopText(`debug${key}`, text, vars);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// #region Lists

const lists = new Map<string, Choice[]>();

function titleOf(key: string): string {
  return key
    .toLowerCase()
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function enumChoices(values: Record<string, string | number>, skip: readonly number[] = []): Choice[] {
  return Object.entries(values)
    .filter(([, value]) => typeof value === "number" && !skip.includes(value))
    .map(([key, value]) => ({ label: titleOf(key), value: value as number }));
}

/** Families of items that are made at random, and that a Pokémon holds */
const HELD_FAMILIES: readonly string[] = ["BERRY", "ATTACK_TYPE_BOOSTER", "BASE_STAT_BOOSTER", "SPECIES_STAT_BOOSTER"];

/**
 * The items of the game, as held items or items of the whole team. Made from the game's own item list; drawing nothing at
 * random (the battle's random numbers must stay as they are on every client).
 */
function itemChoices(): { held: Choice[]; team: Choice[] } {
  const held: Choice[] = [];
  const team: Choice[] = [];
  const state = Phaser.Math.RND.state();
  try {
    for (const key of Object.keys(modifierTypes) as string[]) {
      try {
        const type = modifierTypes[key as keyof typeof modifierTypes]();
        const random = type.is("ModifierTypeGenerator");
        let name: string = key;
        try {
          name = random ? titleOf(key) : type.name;
        } catch {
          name = titleOf(key);
        }
        const choice = { label: `${name}${random ? ` (${t("Random", "random")})` : ""} · ${key}`, value: key };
        if (random) {
          if (HELD_FAMILIES.includes(key)) {
            held.push(choice);
          }
        } else if (type instanceof PokemonHeldItemModifierType) {
          held.push(choice);
        } else if (!(type instanceof PokemonModifierType) && type.newModifier() instanceof PersistentModifier) {
          team.push(choice);
        }
      } catch {
        // an item the panel cannot make without a battle: not listed
      }
    }
  } finally {
    Phaser.Math.RND.state(state);
  }
  return { held, team };
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
      made = allMoves.slice(1).map(move => ({ label: move.name, value: move.id }));
      break;
    case "abilities":
      made = allAbilities.slice(1).map(ability => ({ label: ability.name, value: ability.id }));
      break;
    case "held":
    case "team": {
      const items = itemChoices();
      lists.set("held", items.held);
      lists.set("team", items.team);
      return name === "held" ? items.held : items.team;
    }
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

/** The `<datalist>` of a list, made once */
function datalistId(name: string): string {
  const id = `${ROOT_ID}-${name}`;
  if (document.getElementById(id) === null) {
    const node = document.createElement("datalist");
    node.id = id;
    for (const choice of list(name)) {
      const option = document.createElement("option");
      option.value = choice.label;
      node.append(option);
    }
    parts?.root.append(node);
  }
  return id;
}

// #endregion

// #region Controls

function button(text: string, action: () => void, className = ""): HTMLButtonElement {
  const node = element("button", `coop-debug-button ${className}`.trim(), text);
  node.type = "button";
  node.addEventListener("click", () => action());
  return node;
}

function numberInput(value: number, min: number, max: number, width = 4): HTMLInputElement {
  const node = element("input", "coop-debug-number");
  node.type = "number";
  node.min = String(min);
  node.max = String(max);
  node.value = String(value);
  node.style.width = `${width + 2}ch`;
  return node;
}

function readNumber(input: HTMLInputElement, min: number, max: number): number | null {
  const value = Math.trunc(Number(input.value));
  return Number.isFinite(value) && value >= min && value <= max && input.value.trim() !== "" ? value : null;
}

/** A text box with the names of a list to search in; `read` gives the chosen entry, or `null` (and says so) */
function searchBox(name: string, placeholder: string): { input: HTMLInputElement; read: () => Choice | null } {
  const input = element("input", "coop-debug-search-box");
  input.type = "text";
  input.placeholder = placeholder;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.setAttribute("list", datalistId(name));
  const read = (): Choice | null => {
    const text = input.value.trim().toLowerCase();
    const found =
      list(name).find(choice => choice.label.toLowerCase() === text)
      ?? list(name).find(choice => String(choice.value).toLowerCase() === text)
      ?? list(name).find(choice => choice.label.toLowerCase().startsWith(text));
    if (found === undefined || text === "") {
      note(t("NotFound", "Nothing called “{{text}}”.", { text: input.value }));
      return null;
    }
    return found;
  };
  return { input, read };
}

function selectOf(choices: readonly Choice[], value?: number | string): HTMLSelectElement {
  const node = element("select", "coop-debug-select");
  for (const choice of choices) {
    const option = document.createElement("option");
    option.value = String(choice.value);
    option.textContent = choice.label;
    option.selected = choice.value === value;
    node.append(option);
  }
  return node;
}

/** A line of the panel: its label and controls; the search box finds it by its label and its controls' words */
function row(label: string, ...controls: (HTMLElement | string)[]): HTMLElement {
  const node = element("div", "coop-debug-row");
  const words = controls.map(control => (typeof control === "string" ? control : (control.textContent ?? "")));
  node.dataset["search"] = [label, ...words].join(" ").toLowerCase();
  node.append(element("span", "coop-debug-label", label));
  const box = element("span", "coop-debug-controls");
  box.append(...controls);
  node.append(box);
  return node;
}

function heading(text: string): HTMLElement {
  const node = element("div", "coop-debug-heading", text);
  node.dataset["search"] = text.toLowerCase();
  return node;
}

// #endregion

// #region Sending

function note(text: string): void {
  lastNote = text;
  drawStatus();
}

function send(what: string, ...actions: DebugAction[]): void {
  queueDebug(...actions);
  note(what);
}

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

function party(): PlayerPokemon[] {
  try {
    return globalScene.getPlayerParty();
  } catch {
    return [];
  }
}

function currentWave(): number {
  return globalScene.currentBattle?.waveIndex ?? 0;
}

// #endregion

// #region Tabs

function partyRows(): HTMLElement[] {
  const members = party();
  const session = getCoopSession();
  if (selected === null || !members.some(pokemon => pokemon.id === selected)) {
    selected = members[0]?.id ?? null;
  }
  const rows: HTMLElement[] = [];
  const picker = element("div", "coop-debug-picker");
  for (const pokemon of members) {
    const owner = session?.ownership.get(pokemon.id);
    const pick = button(`${pokemon.name} ${pokemon.level}`, () => {
      selected = pokemon.id;
      draw();
    });
    pick.title = owner === undefined ? "" : seatName(owner);
    pick.classList.toggle("coop-debug-on", pokemon.id === selected);
    picker.append(pick);
  }
  const pickRow = row(t("Pokemon", "Pokémon"), picker);
  pickRow.dataset["search"] = `${pickRow.dataset["search"]} party pokemon team`;
  rows.push(pickRow);

  const pokemon = members.find(member => member.id === selected) ?? null;
  if (pokemon !== null) {
    const p = pokemon.id;
    const name = pokemon.name;
    const level = numberInput(pokemon.level, 1, 10_000, 5);
    rows.push(
      row(
        t("Level", "Level"),
        level,
        button(t("Set", "Set"), () => {
          const v = readNumber(level, 1, 10_000);
          if (v !== null) {
            send(t("SentLevel", "{{name}}: level {{v}}", { name, v }), { t: "level", p, v });
          }
        }),
        button("100", () => send(t("SentLevel", "{{name}}: level {{v}}", { name, v: 100 }), { t: "level", p, v: 100 })),
      ),
    );
    const ivs = pokemon.ivs.map(iv => numberInput(iv, 0, 31, 2));
    rows.push(
      row(
        t("Ivs", "IVs (HP Atk Def SpA SpD Spe)"),
        ...ivs,
        button(t("Set", "Set"), () => {
          const v = ivs.map(input => readNumber(input, 0, 31));
          if (v.every(iv => iv !== null)) {
            send(t("SentIvs", "{{name}}: IVs set", { name }), { t: "ivs", p, v: v as number[] });
          }
        }),
        button(t("Perfect", "All 31"), () =>
          send(t("SentIvs", "{{name}}: IVs set", { name }), { t: "ivs", p, v: [31, 31, 31, 31, 31, 31] }),
        ),
      ),
    );
    const nature = selectOf(list("natures"), pokemon.nature);
    rows.push(
      row(
        t("Nature", "Nature"),
        nature,
        button(t("Set", "Set"), () =>
          send(t("SentNature", "{{name}}: new nature", { name }), { t: "nature", p, v: Number(nature.value) }),
        ),
      ),
    );
    const ability = searchBox("abilities", t("AbilitySearch", "Any ability…"));
    rows.push(
      row(
        t("Ability", "Ability"),
        ability.input,
        button(t("Set", "Set"), () => {
          const found = ability.read();
          if (found !== null) {
            send(t("SentAbility", "{{name}}: {{what}}", { name, what: found.label }), {
              t: "ability",
              p,
              v: found.value as number,
            });
          }
        }),
        button(t("Own", "Own"), () =>
          send(t("SentAbilityOwn", "{{name}}: own ability", { name }), { t: "ability", p, v: 0 }),
        ),
      ),
    );
    const passive = searchBox("abilities", t("AbilitySearch", "Any ability…"));
    rows.push(
      row(
        t("Passive", "Passive (unlocked)"),
        passive.input,
        button(t("Set", "Set"), () => {
          const found = passive.read();
          if (found !== null) {
            send(t("SentPassive", "{{name}}: passive {{what}}", { name, what: found.label }), {
              t: "passive",
              p,
              v: found.value as number,
            });
          }
        }),
        button(t("Own", "Own"), () =>
          send(t("SentPassiveOwn", "{{name}}: own passive, unlocked", { name }), { t: "passive", p, v: 0 }),
        ),
      ),
    );
    const friendship = numberInput(pokemon.friendship, 0, 255, 3);
    rows.push(
      row(
        t("Friendship", "Friendship"),
        friendship,
        button(t("Set", "Set"), () => {
          const v = readNumber(friendship, 0, 255);
          if (v !== null) {
            send(t("SentFriendship", "{{name}}: friendship {{v}}", { name, v }), { t: "friendship", p, v });
          }
        }),
        button(t("Max", "Max"), () =>
          send(t("SentFriendship", "{{name}}: friendship {{v}}", { name, v: 255 }), { t: "friendship", p, v: 255 }),
        ),
      ),
    );
    const species = searchBox("species", t("SpeciesSearch", "Species…"));
    const form = numberInput(0, 0, 100, 2);
    form.title = t("Form", "Form");
    rows.push(
      row(
        t("Species", "Species (form)"),
        species.input,
        form,
        button(t("Set", "Set"), () => {
          const found = species.read();
          if (found !== null) {
            send(t("SentSpecies", "{{name}} becomes {{what}}", { name, what: found.label }), {
              t: "species",
              p,
              v: found.value as number,
              form: readNumber(form, 0, 100) ?? 0,
            });
          }
        }),
      ),
    );
    const fusion = searchBox("species", t("SpeciesSearch", "Species…"));
    rows.push(
      row(
        t("Fusion", "Fusion"),
        fusion.input,
        button(t("Fuse", "Fuse"), () => {
          const found = fusion.read();
          if (found !== null) {
            send(t("SentFusion", "{{name}} fused with {{what}}", { name, what: found.label }), {
              t: "fusion",
              p,
              v: found.value as number,
              form: 0,
            });
          }
        }),
        button(t("Unfuse", "Unfuse"), () =>
          send(t("SentUnfuse", "{{name}} unfused", { name }), { t: "fusion", p, v: 0, form: 0 }),
        ),
      ),
    );
    const shiny = (on: boolean, variant: number, label: string) =>
      button(label, () =>
        send(t("SentShiny", "{{name}}: {{what}}", { name, what: label }), { t: "shiny", p, shiny: on, variant }),
      );
    rows.push(
      row(
        t("Shiny", "Shiny"),
        shiny(false, 0, t("NotShiny", "No")),
        shiny(true, 0, "★"),
        shiny(true, 1, "★★"),
        shiny(true, 2, "★★★"),
      ),
    );
    const gender = (v: number, label: string) =>
      button(label, () => send(t("SentGender", "{{name}}: {{what}}", { name, what: label }), { t: "gender", p, v }));
    rows.push(row(t("Gender", "Gender"), gender(0, "♂"), gender(1, "♀"), gender(-1, "—")));
    const tera = selectOf(
      enumChoices(PokemonType as unknown as Record<string, number>, [PokemonType.UNKNOWN]),
      pokemon.teraType,
    );
    rows.push(
      row(
        t("Tera", "Tera type"),
        tera,
        button(t("Set", "Set"), () =>
          send(t("SentTera", "{{name}}: new Tera type", { name }), { t: "tera", p, v: Number(tera.value) }),
        ),
      ),
    );
    for (let slot = 0; slot < 4; slot++) {
      const known = pokemon.moveset[slot];
      const move = searchBox("moves", known?.getName() ?? t("MoveSearch", "Move…"));
      rows.push(
        row(
          t("Move", "Move {{slot}}", { slot: slot + 1 }),
          move.input,
          button(t("Set", "Set"), () => {
            const found = move.read();
            if (found !== null) {
              send(t("SentMove", "{{name}} learns {{what}}", { name, what: found.label }), {
                t: "move",
                p,
                slot,
                v: found.value as number,
              });
            }
          }),
          button(t("Forget", "Forget"), () =>
            send(t("SentForget", "{{name}} forgets move {{slot}}", { name, slot: slot + 1 }), {
              t: "move",
              p,
              slot,
              v: 0,
            }),
          ),
        ),
      );
    }
    const item = searchBox("held", t("ItemSearch", "Held item…"));
    const count = numberInput(1, 1, 99, 2);
    rows.push(
      row(
        t("HeldItem", "Give held item"),
        item.input,
        count,
        button(t("Give", "Give"), () => {
          const found = item.read();
          if (found !== null) {
            send(t("SentItem", "{{name}} gets {{what}}", { name, what: found.label }), {
              t: "item",
              p,
              item: String(found.value),
              count: readNumber(count, 1, 99) ?? 1,
            });
          }
        }),
      ),
    );
    rows.push(
      row(
        t("Care", "Care"),
        button(t("HealOne", "Heal / revive"), () => send(t("SentHeal", "{{name}} healed", { name }), { t: "heal", p })),
        button(t("Remove", "Remove"), () => send(t("SentRemove", "{{name}} removed", { name }), { t: "remove", p })),
      ),
    );
    rows.push(
      row(
        t("GiveTo", "Give to player"),
        ...seats().map(seat =>
          button(seatName(seat), () =>
            send(t("SentOwner", "{{name}} goes to {{who}}", { name, who: seatName(seat) }), { t: "owner", p, seat }),
          ),
        ),
      ),
    );
  }

  rows.push(heading(t("AddHeading", "Add a Pokémon")));
  const species = searchBox("species", t("SpeciesSearch", "Species…"));
  const level = numberInput(Math.max(5, members[0]?.level ?? 5), 1, 10_000, 5);
  const shiny = selectOf([
    { label: t("NotShiny", "No"), value: -1 },
    { label: "★", value: 0 },
    { label: "★★", value: 1 },
    { label: "★★★", value: 2 },
  ]);
  const to = selectOf(
    seats().map(seat => ({ label: seatName(seat), value: seat })),
    "host",
  );
  rows.push(
    row(
      t("Add", "Species, level, shiny, for"),
      species.input,
      level,
      shiny,
      to,
      button(t("AddButton", "Add"), () => {
        const found = species.read();
        const v = readNumber(level, 1, 10_000);
        if (found === null || v === null) {
          return;
        }
        const variant = Number(shiny.value);
        send(t("SentAdd", "{{what}} joins {{who}}", { what: found.label, who: seatName(to.value as Seat) }), {
          t: "add",
          seat: to.value as Seat,
          species: found.value as number,
          form: 0,
          level: v,
          shiny: variant >= 0,
          variant: Math.max(0, variant),
          seed: seed(),
        });
      }),
    ),
  );
  rows.push(
    row(
      t("Team", "Whole team"),
      button(t("HealAll", "Heal all"), () => send(t("SentHealAll", "Team healed"), { t: "heal", p: null })),
      button(t("AllShiny", "All shiny"), () => send(t("SentAllShiny", "Everyone is shiny"), { t: "allShiny" })),
    ),
  );
  return rows;
}

function waveRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const next = currentWave() + 1;
  if (draftWave <= currentWave()) {
    draftWave = next;
    draftPlan = getCoopSession()?.debugState.plans[String(next)] ?? emptyWavePlan();
  }
  const wave = numberInput(draftWave, next, 100_000, 5);
  wave.addEventListener("change", () => {
    const v = readNumber(wave, next, 100_000);
    if (v !== null) {
      draftWave = v;
      draftPlan = structuredClone(getCoopSession()?.debugState.plans[String(v)] ?? emptyWavePlan());
      draw();
    }
  });
  rows.push(heading(t("PlanHeading", "Plan a wave")));
  rows.push(row(t("Wave", "Wave (next: {{next}})", { next }), wave));
  const kind = selectOf(
    [
      { label: t("KindGame", "Game's choice"), value: "game" },
      { label: t("KindWild", "Wild battle"), value: "wild" },
      { label: t("KindTrainer", "Trainer battle"), value: "trainer" },
      { label: t("KindMe", "Mystery Encounter"), value: "me" },
    ],
    draftPlan.battle,
  );
  kind.addEventListener("change", () => {
    draftPlan.battle = kind.value as WavePlan["battle"];
  });
  rows.push(row(t("Kind", "Kind"), kind));

  const chips = element("span", "coop-debug-chips");
  for (const [index, id] of draftPlan.species.entries()) {
    chips.append(
      button(`${speciesDataRegistry.getSpecies(id).name} ×`, () => {
        draftPlan.species.splice(index, 1);
        draw();
      }),
    );
  }
  const species = searchBox("species", t("SpeciesSearch", "Species…"));
  rows.push(
    row(
      t("Enemies", "Enemies (in order)"),
      chips,
      species.input,
      button("+", () => {
        const found = species.read();
        if (found !== null && draftPlan.species.length < MAX_PLANNED_SPECIES) {
          draftPlan.species.push(found.value as number);
          draw();
        }
      }),
    ),
  );
  const level = numberInput(draftPlan.level, 0, 10_000, 5);
  level.title = t("ZeroGame", "0: the game's");
  level.addEventListener("change", () => {
    draftPlan.level = readNumber(level, 0, 10_000) ?? 0;
  });
  const boss = numberInput(draftPlan.boss, 0, 5, 2);
  boss.title = t("ZeroGame", "0: the game's");
  boss.addEventListener("change", () => {
    draftPlan.boss = readNumber(boss, 0, 5) ?? 0;
  });
  const shiny = selectOf(
    [
      { label: t("GameChoice", "Game's"), value: "null" },
      { label: t("Yes", "Yes"), value: "true" },
      { label: t("No", "No"), value: "false" },
    ],
    String(draftPlan.shiny),
  );
  shiny.addEventListener("change", () => {
    draftPlan.shiny = shiny.value === "null" ? null : shiny.value === "true";
  });
  rows.push(row(t("EnemyLook", "Level · boss bars · shiny"), level, boss, shiny));
  const trainer = searchBox("trainers", t("TrainerSearch", "Any trainer"));
  if (draftPlan.trainer !== null) {
    trainer.input.value = list("trainers").find(choice => choice.value === draftPlan.trainer)?.label ?? "";
  }
  trainer.input.addEventListener("change", () => {
    draftPlan.trainer = trainer.input.value.trim() === "" ? null : ((trainer.read()?.value as number) ?? null);
  });
  rows.push(row(t("Trainer", "Trainer"), trainer.input));
  const encounter = searchBox("encounters", t("EncounterSearch", "Any encounter"));
  if (draftPlan.encounter !== null) {
    encounter.input.value = list("encounters").find(choice => choice.value === draftPlan.encounter)?.label ?? "";
  }
  encounter.input.addEventListener("change", () => {
    draftPlan.encounter = encounter.input.value.trim() === "" ? null : ((encounter.read()?.value as number) ?? null);
  });
  rows.push(row(t("Encounter", "Mystery Encounter"), encounter.input));
  rows.push(
    row(
      "",
      button(t("SavePlan", "Save plan"), () =>
        send(t("SentPlan", "Wave {{wave}} planned", { wave: draftWave }), {
          t: "plan",
          wave: draftWave,
          plan: structuredClone(draftPlan),
        }),
      ),
      button(t("ClearPlan", "Clear plan"), () => {
        draftPlan = emptyWavePlan();
        send(t("SentClearPlan", "Plan of wave {{wave}} cleared", { wave: draftWave }), {
          t: "plan",
          wave: draftWave,
          plan: null,
        });
        draw();
      }),
    ),
  );
  const plans = Object.keys(getCoopSession()?.debugState.plans ?? {});
  if (plans.length > 0) {
    rows.push(row(t("Planned", "Planned waves"), plans.join(", ")));
  }

  rows.push(heading(t("WhereHeading", "Where and when")));
  const jump = numberInput(next + 9, next + 1, 100_000, 5);
  rows.push(
    row(
      t("Jump", "Jump to wave (after this one)"),
      jump,
      button(t("Jump", "Jump"), () => {
        const v = readNumber(jump, next + 1, 100_000);
        if (v !== null) {
          send(t("SentJump", "Next wave: {{v}}", { v }), { t: "jump", v });
        }
      }),
      button(t("Cancel", "Cancel"), () => send(t("SentNoJump", "No jump"), { t: "jump", v: null })),
    ),
  );
  const biome = searchBox("biomes", t("BiomeSearch", "Biome…"));
  rows.push(
    row(
      t("Biome", "Go to biome (after this wave)"),
      biome.input,
      button(t("Set", "Set"), () => {
        const found = biome.read();
        if (found !== null) {
          send(t("SentBiome", "Next biome: {{what}}", { what: found.label }), { t: "biome", v: found.value as number });
        }
      }),
      button(t("Cancel", "Cancel"), () => send(t("SentNoBiome", "No biome change"), { t: "biome", v: null })),
    ),
  );
  return rows;
}

function rewardRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const state = getCoopSession()?.debugState;
  rows.push(heading(t("RewardHeading", "Next reward screen")));
  const chips = element("span", "coop-debug-chips");
  for (const [index, key] of draftRewards.entries()) {
    chips.append(
      button(`${titleOf(key)} ×`, () => {
        draftRewards.splice(index, 1);
        draw();
      }),
    );
  }
  const item = searchBox("held", t("RewardSearch", "Item…"));
  const team = searchBox("team", t("TeamItemSearch", "Team item…"));
  const add = (box: { read: () => Choice | null }) => () => {
    const found = box.read();
    if (found !== null && draftRewards.length < MAX_PLANNED_REWARDS) {
      draftRewards.push(String(found.value));
      draw();
    }
  };
  rows.push(row(t("RewardItems", "Items (in order)"), chips));
  rows.push(row(t("RewardHeld", "Add held item"), item.input, button("+", add(item))));
  rows.push(row(t("RewardTeam", "Add team item"), team.input, button("+", add(team))));
  rows.push(
    row(
      "",
      button(t("SetRewards", "Use these"), () => {
        if (draftRewards.length > 0) {
          send(
            debugSendsNow()
              ? t("SentRewardsNow", "Reward screen redrawn")
              : t("SentRewards", "Next reward screen planned"),
            { t: "rewards", items: [...draftRewards] },
          );
        }
      }),
      button(t("ClearRewards", "Clear"), () => {
        draftRewards = [];
        send(t("SentNoRewards", "Rewards: the game's"), { t: "rewards", items: null });
        draw();
      }),
    ),
  );
  if (state?.rewards != null) {
    rows.push(row(t("RewardsPlanned", "Planned"), state.rewards.map(titleOf).join(", ")));
  }

  rows.push(heading(t("ShopHeading", "Shop and bag")));
  rows.push(
    row(
      t("Fees", "Free shop · free rerolls"),
      toggle("freeShop", state?.modes.freeShop ?? false),
      toggle("freeRerolls", state?.modes.freeRerolls ?? false),
    ),
  );
  const money = numberInput(globalScene.money ?? 0, 0, 1_000_000_000, 10);
  rows.push(
    row(
      t("Money", "Money"),
      money,
      button(t("Set", "Set"), () => {
        const v = readNumber(money, 0, 1_000_000_000);
        if (v !== null) {
          send(t("SentMoney", "Money: {{v}}", { v }), { t: "money", v });
        }
      }),
      button("+10k", () =>
        send(t("SentMoney", "Money: {{v}}", { v: (globalScene.money ?? 0) + 10_000 }), {
          t: "money",
          v: Math.min(1_000_000_000, (globalScene.money ?? 0) + 10_000),
        }),
      ),
    ),
  );
  const balls = enumChoices(PokeballType as unknown as Record<string, number>);
  const ball = selectOf(balls, PokeballType.MASTER_BALL);
  const count = numberInput(99, 0, 999, 3);
  rows.push(
    row(
      t("Balls", "Poké Balls"),
      ball,
      count,
      button(t("Set", "Set"), () => {
        const v = readNumber(count, 0, 999);
        if (v !== null) {
          send(t("SentBalls", "{{what}}: {{v}}", { what: ball.selectedOptions[0]?.textContent ?? "", v }), {
            t: "balls",
            ball: Number(ball.value),
            v,
          });
        }
      }),
    ),
  );
  const teamItem = searchBox("team", t("TeamItemSearch", "Team item…"));
  const teamCount = numberInput(1, 1, 99, 2);
  rows.push(
    row(
      t("GiveTeam", "Give team item"),
      teamItem.input,
      teamCount,
      button(t("Give", "Give"), () => {
        const found = teamItem.read();
        if (found !== null) {
          send(t("SentTeamItem", "Team gets {{what}}", { what: found.label }), {
            t: "item",
            p: null,
            item: String(found.value),
            count: readNumber(teamCount, 1, 99) ?? 1,
          });
        }
      }),
    ),
  );
  return rows;
}

function battleRows(): HTMLElement[] {
  const rows: HTMLElement[] = [];
  rows.push(
    row(
      t("Win", "This wave"),
      button(t("WinButton", "Win it"), () => send(t("SentWin", "Wave won"), { t: "win" }), "coop-debug-strong"),
      button(t("HealAll", "Heal all"), () => send(t("SentHealAll", "Team healed"), { t: "heal", p: null })),
    ),
  );
  const enemies: Choice[] = [{ label: t("AllEnemies", "Every enemy"), value: -1 }];
  try {
    for (const [index, enemy] of globalScene.getEnemyField().entries()) {
      if (enemy?.isActive(true)) {
        enemies.push({ label: `${enemy.name} ${enemy.level}`, value: index });
      }
    }
  } catch {
    // no battle
  }
  const target = selectOf(enemies, -1);
  const enemyAction = (what: "faint" | "hp1" | "heal" | "level", label: string, v = 0) =>
    button(label, () => {
      const e = Number(target.value);
      send(t("SentEnemy", "Enemy: {{what}}", { what: label }), { t: "enemy", e: e < 0 ? null : e, what, v });
    });
  rows.push(heading(t("EnemyHeading", "Enemies")));
  rows.push(
    row(
      t("Enemy", "Enemy"),
      target,
      enemyAction("faint", t("Faint", "Faint")),
      enemyAction("hp1", t("Hp1", "1 HP")),
      enemyAction("heal", t("FullHeal", "Full HP")),
    ),
  );
  const enemyLevel = numberInput(1, 1, 10_000, 5);
  rows.push(
    row(
      t("EnemyLevel", "Enemy level"),
      enemyLevel,
      button(t("Set", "Set"), () => {
        const v = readNumber(enemyLevel, 1, 10_000);
        const e = Number(target.value);
        if (v !== null) {
          send(t("SentEnemyLevel", "Enemy: level {{v}}", { v }), { t: "enemy", e: e < 0 ? null : e, what: "level", v });
        }
      }),
    ),
  );
  rows.push(heading(t("FieldHeading", "Field")));
  const stages = (side: "party" | "enemy", v: number, label: string) =>
    button(label, () => send(t("SentStages", "Stat stages: {{what}}", { what: label }), { t: "stages", side, v }));
  rows.push(
    row(
      t("Stages", "Stat stages"),
      stages("party", 6, t("UsMax", "Us +6")),
      stages("party", 0, t("UsReset", "Us 0")),
      stages("enemy", -6, t("ThemMin", "Them −6")),
      stages("enemy", 0, t("ThemReset", "Them 0")),
    ),
  );
  const statuses = enumChoices(StatusEffect as unknown as Record<string, number>, [StatusEffect.FAINT]);
  const status = selectOf(statuses, StatusEffect.PARALYSIS);
  rows.push(
    row(
      t("Status", "Status"),
      status,
      button(t("OnThem", "On them"), () =>
        send(t("SentStatus", "Enemies: {{what}}", { what: status.selectedOptions[0]?.textContent ?? "" }), {
          t: "status",
          side: "enemy",
          v: Number(status.value),
        }),
      ),
      button(t("CureUs", "Cure us"), () =>
        send(t("SentCure", "Our status cured"), { t: "status", side: "party", v: StatusEffect.NONE }),
      ),
    ),
  );
  const weather = selectOf(enumChoices(WeatherType as unknown as Record<string, number>));
  rows.push(
    row(
      t("Weather", "Weather"),
      weather,
      button(t("Set", "Set"), () =>
        send(t("SentWeather", "Weather: {{what}}", { what: weather.selectedOptions[0]?.textContent ?? "" }), {
          t: "weather",
          v: Number(weather.value),
        }),
      ),
    ),
  );
  const terrain = selectOf(enumChoices(TerrainType as unknown as Record<string, number>));
  rows.push(
    row(
      t("Terrain", "Terrain"),
      terrain,
      button(t("Set", "Set"), () =>
        send(t("SentTerrain", "Terrain: {{what}}", { what: terrain.selectedOptions[0]?.textContent ?? "" }), {
          t: "terrain",
          v: Number(terrain.value),
        }),
      ),
    ),
  );
  return rows;
}

/** A switch for a mode of the menu that stays on */
function toggle(mode: "freeShop" | "freeRerolls" | "noDamage" | "oneHit" | "shinyEnemies", on: boolean) {
  const labels: Record<typeof mode, string> = {
    freeShop: t("FreeShop", "Free shop"),
    freeRerolls: t("FreeRerolls", "Free rerolls"),
    noDamage: t("NoDamage", "We take no damage"),
    oneHit: t("OneHit", "Our hits knock out"),
    shinyEnemies: t("ShinyEnemies", "Shiny enemies"),
  };
  const node = button(`${on ? "■" : "□"} ${labels[mode]}`, () => {
    send(`${labels[mode]}: ${on ? t("Off", "off") : t("On", "on")}`, { t: "mode", mode, v: !on });
  });
  node.classList.toggle("coop-debug-on", on);
  return node;
}

function funRows(): HTMLElement[] {
  const modes = getCoopSession()?.debugState.modes;
  const rows: HTMLElement[] = [];
  rows.push(
    row(
      t("Modes", "Modes"),
      toggle("noDamage", modes?.noDamage ?? false),
      toggle("oneHit", modes?.oneHit ?? false),
      toggle("shinyEnemies", modes?.shinyEnemies ?? false),
    ),
  );
  const multiplier = (mode: "exp" | "money", label: string, value: number) => {
    const input = numberInput(value, 1, 100, 3);
    return row(
      label,
      input,
      button(t("Set", "Set"), () => {
        const v = readNumber(input, 1, 100);
        if (v !== null) {
          send(`${label}: ×${v}`, { t: "mode", mode, v });
        }
      }),
    );
  };
  rows.push(multiplier("exp", t("ExpTimes", "EXP ×"), modes?.exp ?? 1));
  rows.push(multiplier("money", t("MoneyTimes", "Money ×"), modes?.money ?? 1));
  const enemyLevel = numberInput(modes?.enemyLevel ?? 0, 0, 10_000, 5);
  enemyLevel.title = t("ZeroGame", "0: the game's");
  rows.push(
    row(
      t("AllEnemyLevel", "Every enemy's level (0: the game's)"),
      enemyLevel,
      button(t("Set", "Set"), () => {
        const v = readNumber(enemyLevel, 0, 10_000);
        if (v !== null) {
          send(t("SentAllEnemyLevel", "Enemies from now: level {{v}}", { v }), { t: "mode", mode: "enemyLevel", v });
        }
      }),
    ),
  );
  rows.push(
    row(
      t("Chaos", "Chaos"),
      button(t("Randomize", "Random species for our team"), () =>
        send(t("SentRandomize", "Team randomized"), { t: "randomize", seed: seed() }),
      ),
      button(t("AllShiny", "All shiny"), () => send(t("SentAllShiny", "Everyone is shiny"), { t: "allShiny" })),
    ),
  );
  return rows;
}

const TABS: readonly { id: TabId; label: () => string; rows: () => HTMLElement[] }[] = [
  { id: "party", label: () => t("TabParty", "Party"), rows: partyRows },
  { id: "waves", label: () => t("TabWaves", "Waves"), rows: waveRows },
  { id: "rewards", label: () => t("TabRewards", "Rewards"), rows: rewardRows },
  { id: "battle", label: () => t("TabBattle", "Battle"), rows: battleRows },
  { id: "fun", label: () => t("TabFun", "Fun"), rows: funRows },
];

// #endregion

// #region Panel

function drawStatus(): void {
  if (parts === null) {
    return;
  }
  const waiting = waitingDebug().length;
  const when = debugSendsNow() ? t("WhenNow", "sent now") : t("WhenTurn", "sent with the next turn");
  const queue =
    waiting === 0 ? t("NoneWaiting", "Nothing waiting") : t("Waiting", "{{n}} waiting, {{when}}", { n: waiting, when });
  parts.status.textContent = lastNote === "" ? queue : `${lastNote} · ${queue}`;
}

function draw(): void {
  if (parts === null || !open) {
    return;
  }
  parts.tabs.replaceChildren(
    ...TABS.map(entry => {
      const node = button(entry.label(), () => {
        tab = entry.id;
        parts!.search.value = "";
        draw();
      });
      node.classList.toggle("coop-debug-on", entry.id === tab && parts!.search.value.trim() === "");
      return node;
    }),
  );
  const query = parts.search.value.trim().toLowerCase();
  let rows: HTMLElement[];
  if (query === "") {
    rows = TABS.find(entry => entry.id === tab)!.rows();
  } else {
    // The search finds lines of every tab
    rows = TABS.flatMap(entry => {
      const found = entry.rows().filter(node => (node.dataset["search"] ?? "").includes(query));
      return found.length === 0 ? [] : [heading(entry.label()), ...found];
    });
    if (rows.length === 0) {
      rows = [element("div", "coop-debug-empty", t("NoMatch", "Nothing matches."))];
    }
  }
  parts.body.replaceChildren(...rows);
  drawStatus();
}

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement
    && (target.isContentEditable
      || target.tagName === "INPUT"
      || target.tagName === "TEXTAREA"
      || target.tagName === "SELECT")
  );
}

/** Whether the key is the one bound to the debug menu ("Co-op: debug menu", F8 at first) */
function isDebugKey(event: KeyboardEvent): boolean {
  try {
    const controller = globalScene.inputController;
    controller?.ensureKeyboardIsInit();
    const config = controller?.getActiveConfig(Device.KEYBOARD);
    return config != null && getButtonWithKeycode(config, event.keyCode) === Button.COOP_DEBUG;
  } catch {
    return false;
  }
}

function onDebugKey(event: KeyboardEvent): void {
  if (
    !running
    || event.type !== "keydown"
    || event.repeat
    || event.ctrlKey
    || event.metaKey
    || event.altKey
    || (isTyping(event.target) && !(event.target instanceof Node && parts?.root.contains(event.target)))
    || globalScene.ui?.mode === UiMode.KEYBOARD_BINDING
    || !isDebugKey(event)
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  setOpen(!open);
}

/** Whatever the game thinks is held stays held otherwise: the panel takes the keyboard */
function releaseGameKeys(): void {
  try {
    globalScene.inputController?.loseFocus();
  } catch {
    // no game (a test page)
  }
}

function build(): Parts {
  const root = element("div", "coop-debug");
  root.id = ROOT_ID;
  root.hidden = true;
  const head = element("div", "coop-debug-head");
  const title = element("span", "coop-debug-title", t("Title", "Debug menu"));
  const close = element("button", "coop-debug-close", "×");
  close.type = "button";
  close.addEventListener("click", () => setOpen(false));
  head.append(title, close);
  const search = element("input", "coop-debug-search");
  search.type = "search";
  search.placeholder = t("Search", "Search every tab…");
  search.addEventListener("input", () => draw());
  const tabs = element("div", "coop-debug-tabs");
  const body = element("div", "coop-debug-body");
  const status = element("div", "coop-debug-status");
  root.append(head, search, tabs, body, status);
  document.body.append(root);
  // The game hears none of the keys typed in the panel
  for (const type of ["keydown", "keyup", "keypress"] as const) {
    root.addEventListener(type, event => {
      if (event.type === "keydown" && (event as KeyboardEvent).key === "Escape") {
        setOpen(false);
      }
      event.stopPropagation();
    });
  }
  root.addEventListener("focusin", () => releaseGameKeys());
  window.addEventListener("keydown", onDebugKey, true);
  return { root, tabs, search, body, status };
}

function setOpen(next: boolean): void {
  if (parts === null || !running) {
    return;
  }
  open = next;
  parts.root.hidden = !open;
  releaseGameKeys();
  if (open) {
    draw();
  } else if (parts.root.contains(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
}

/** The host of a run with the menu on: the panel is there for the whole session, closed at first */
export function startDebugPanel(): void {
  if (typeof document === "undefined") {
    return;
  }
  stopDebugPanel();
  parts ??= build();
  running = true;
  lastNote = "";
  draftPlan = emptyWavePlan();
  draftWave = 0;
  draftRewards = [];
  stopQueueListener = onDebugQueue(() => drawStatus());
  setOpen(false);
}

/** The session is over */
export function stopDebugPanel(): void {
  stopQueueListener?.();
  stopQueueListener = null;
  if (parts !== null) {
    parts.root.hidden = true;
  }
  running = false;
  open = false;
}

/** The debug key: open the panel, or close it */
export function toggleDebugPanel(): void {
  setOpen(!open);
}

/** What the debug API and the tests read */
export function debugPanelInfo(): { open: boolean; tab: TabId; waiting: number; status: string } | null {
  if (!running || parts === null) {
    return null;
  }
  return { open, tab, waiting: waitingDebug().length, status: parts.status.textContent ?? "" };
}

/** The tests and the debug API switch tabs as a click does */
export function showDebugTab(next: TabId): void {
  tab = next;
  if (parts !== null) {
    parts.search.value = "";
  }
  draw();
}

// #endregion
