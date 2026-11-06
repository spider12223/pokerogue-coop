/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { catalogItem } from "#coop/debug/catalog";
import { currentWave, itemChoices, keep, labelOf, list } from "#coop/debug/choices";
import { button, chip, el, field, numberBox, picker, segmented, selectBox, t } from "#coop/debug/dom";
import { speciesIcon } from "#coop/debug/live";
import { debugChanges } from "#coop/debug/queue";
import {
  ENEMY_MOVE_SLOTS,
  type EnemyPlan,
  emptyEnemyPlan,
  emptyWavePlan,
  isEnemyPlanSet,
  MAX_ENEMY_ITEMS,
  MAX_LEVEL,
  MAX_PLANNED_ENEMIES,
  MAX_WILD_ENEMIES,
  type WavePlan,
} from "#coop/debug/state";
import { change, isPending, pendingAction, redraw, view } from "#coop/debug/view";
import { getCoopSession } from "#coop/session";
import { allAbilities, allMoves } from "#data/data-lists";
import { Gender } from "#data/gender";
import type { BiomeId } from "#enums/biome-id";
import { ClassicFixedBossWaves } from "#enums/fixed-boss-waves";
import { getBiomeName } from "#utils/common";

/**
 * The Waves section of the host's debug window (DECISIONS D42, amended): the next-battle planner. One card plans one
 * wave, the next one first: what kind of battle, then a column per enemy (species, fusion, level, shiny rarity, and under
 * "More" boss bars, ability, nature, Terastallize, gender, moves, held items), and a line on what the wave will be.
 * Picking anything for an enemy of a "Game's" wave makes it wild. A fixed wave (rival, evil team, Elite Four, champion)
 * keeps its battle: its columns are that trainer's team. Every change sends the wave's whole plan (`plan:<wave>`).
 * @module
 */

type Kind = WavePlan["battle"];

const STARS = ["★", "★★", "★★★"] as const;

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

const speciesName = (id: number): string => speciesDataRegistry.getSpecies(id).name;

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** @returns Whether `wave` is a fixed battle of the run's mode: its battle stays (D42 amended) */
function isFixedWave(wave: number): boolean {
  try {
    return globalScene.gameMode.isFixedBattle(wave);
  } catch {
    return false;
  }
}

/** What a fixed wave is, said from its place in Classic (never by making its trainer: that would draw random numbers) */
function fixedBattleName(wave: number): string {
  const key = (ClassicFixedBossWaves[wave] as string | undefined) ?? "";
  if (key.startsWith("RIVAL")) {
    return t("FixedRival", "the rival's battle");
  }
  if (key.startsWith("EVIL")) {
    return t("FixedEvil", "an evil team's battle");
  }
  if (key.startsWith("ELITE_FOUR")) {
    return t("FixedEliteFour", "an Elite Four battle");
  }
  if (key === "CHAMPION") {
    return t("FixedChampion", "the champion's battle");
  }
  if (key === "TOWN_YOUNGSTER") {
    return t("FixedYoungster", "the youngster's battle");
  }
  return t("FixedOther", "a fixed battle");
}

// #region The summary

/** @returns An enemy's plan in a few words ("Charizard fused with Gengar, ★★★, Lv 50"); `nobody` if it plans nothing */
function describeEnemy(enemy: EnemyPlan | null, nobody: string): string {
  if (!isEnemyPlanSet(enemy)) {
    return nobody;
  }
  let who = enemy.species === null ? t("GamesPick", "the game's pick") : speciesName(enemy.species);
  if (enemy.fusion === "random") {
    who += ` ${t("FusedRandom", "fused with a random partner")}`;
  } else if (enemy.fusion !== null) {
    who += ` ${t("FusedWith", "fused with {{name}}", { name: speciesName(enemy.fusion) })}`;
  }
  const parts = [who];
  if (enemy.shiny !== null) {
    parts.push(enemy.shiny < 0 ? t("NotShinyWord", "not shiny") : STARS[enemy.shiny]);
  }
  if (enemy.level > 0) {
    parts.push(`Lv ${enemy.level}`);
  }
  if (enemy.boss === 1) {
    parts.push(t("NotABoss", "not a boss"));
  } else if (enemy.boss > 1) {
    parts.push(t("BossCount", "{{n}} boss bars", { n: enemy.boss }));
  }
  if (enemy.tera !== null) {
    parts.push(t("TeraInto", "Terastallizes ({{type}})", { type: labelOf("types", enemy.tera) }));
  }
  return parts.join(", ");
}

/** @returns A team's planned members, then that the rest is the trainer's own */
function describeTeam(plan: WavePlan): string {
  let last = plan.enemies.length - 1;
  while (last >= 0 && !isEnemyPlanSet(plan.enemies[last])) {
    last--;
  }
  if (last < 0) {
    return t("OwnTeam", "The trainer's own team.");
  }
  const own = t("TrainersOwn", "the trainer's own");
  const members = plan.enemies.slice(0, last + 1).map(enemy => describeEnemy(enemy, own));
  return `${capitalized(members.join("; "))}; ${t("RestOwn", "the rest of the team is the trainer's own.")}`;
}

/** @returns What the wave will be, in one line */
export function planSummary(wave: number, plan: WavePlan): string {
  const head = t("WaveHead", "Wave {{wave}}:", { wave });
  if (isFixedWave(wave)) {
    return `${head} ${fixedBattleName(wave)} (${t("FixedWord", "fixed")}). ${describeTeam(plan)}`;
  }
  switch (plan.battle) {
    case "game":
      return `${head} ${t("GamesChoiceLine", "the game's choice.")}`;
    case "wild": {
      const pick = t("GamesPick", "the game's pick");
      const [first, second] = [0, 1].map(slot => describeEnemy(plan.enemies[slot] ?? null, pick));
      return `${head} ${t("WildDouble", "wild double battle.")} ${capitalized(first)}; ${t("And", "and")} ${second}.`;
    }
    case "trainer": {
      const who = plan.trainer === null ? t("RandomTrainer", "a random trainer") : labelOf("trainers", plan.trainer);
      return `${head} ${who}. ${describeTeam(plan)}`;
    }
    case "me":
      return plan.encounter === null
        ? `${head} ${t("RandomEncounter", "a random Mystery Encounter.")}`
        : `${head} ${t("EncounterLine", "Mystery Encounter, {{what}}.", { what: labelOf("encounters", plan.encounter) })}`;
  }
}

// #endregion

// #region An enemy's column

/** @returns How many of the options under "More" an enemy's plan sets */
function moreCount(enemy: EnemyPlan): number {
  return [
    enemy.boss !== 0,
    enemy.ability !== 0,
    enemy.nature !== null,
    enemy.tera !== null,
    enemy.gender !== null,
    enemy.moves.some(move => move !== 0),
    enemy.items.length > 0,
  ].filter(Boolean).length;
}

/** A row of a column: a small label, then its controls */
function line(label: string, ...controls: (Node | null)[]): HTMLElement {
  return el("div", "cdw-row", el("span", "cdw-mini", label), ...controls);
}

/** The options under "More" */
function moreBox(enemy: EnemyPlan, slot: number, edit: (next: EnemyPlan, what: string) => void): HTMLElement {
  const games = t("GameChoice", "Game's");
  const moves = Array.from({ length: ENEMY_MOVE_SLOTS }, (_, at) => {
    const move = enemy.moves[at] ?? 0;
    const setMove = (v: number, what: string): void =>
      edit({ ...enemy, moves: enemy.moves.map((old, i) => (i === at ? v : old)) }, what);
    return move === 0
      ? keep(
          picker(
            () => list("moves"),
            t("MoveSlot", "Move {{n}}…", { n: at + 1 }),
            choice => setMove(choice.value as number, choice.label),
            110,
          ),
          `plan-${slot}-move-${at}`,
        )
      : chip(allMoves[move]?.name ?? String(move), () => setMove(0, t("MoveGames", "the game's move")));
  });
  return el(
    "div",
    "cdw-morebox",
    line(
      t("BossBars", "Boss bars"),
      segmented<number>(
        [
          { label: games, value: 0 },
          { label: t("No", "No"), value: 1 },
          ...[2, 3, 4, 5].map(v => ({ label: String(v), value: v })),
        ],
        enemy.boss,
        v =>
          edit(
            { ...enemy, boss: v },
            v === 0 ? t("BossGames", "the game's boss bars") : v === 1 ? t("NotABoss", "not a boss") : `${v}`,
          ),
      ),
    ),
    line(
      t("Ability", "Ability"),
      keep(
        picker(
          () => list("abilities"),
          enemy.ability === 0 ? t("AbilityGames", "The game's…") : (allAbilities[enemy.ability]?.name ?? ""),
          choice => edit({ ...enemy, ability: choice.value as number }, choice.label),
          150,
        ),
        `plan-${slot}-ability`,
      ),
      enemy.ability === 0
        ? null
        : button(
            games,
            () => edit({ ...enemy, ability: 0 }, t("AbilityGamesNote", "the game's ability")),
            "cdw-btn cdw-small",
          ),
    ),
    line(
      t("Nature", "Nature"),
      selectBox([{ label: games, value: "" }, ...list("natures")], enemy.nature ?? "", value =>
        edit(
          { ...enemy, nature: value === "" ? null : Number(value) },
          value === "" ? games : labelOf("natures", Number(value)),
        ),
      ),
    ),
    line(
      t("Terastallize", "Terastallize"),
      selectBox([{ label: games, value: "" }, ...list("types")], enemy.tera ?? "", value =>
        edit(
          { ...enemy, tera: value === "" ? null : Number(value) },
          value === "" ? games : t("TeraInto", "Terastallizes ({{type}})", { type: labelOf("types", Number(value)) }),
        ),
      ),
    ),
    line(
      t("Gender", "Gender"),
      segmented<number | null>(
        [
          { label: games, value: null },
          { label: "♂", value: Gender.MALE },
          { label: "♀", value: Gender.FEMALE },
        ],
        enemy.gender,
        v => edit({ ...enemy, gender: v }, v === null ? games : v === Gender.MALE ? "♂" : "♀"),
      ),
    ),
    line(t("Moves", "Moves"), ...moves),
    line(
      t("HeldItems", "Held items"),
      ...enemy.items.map((id, at) =>
        chip(catalogItem(id)?.name ?? id, () =>
          edit({ ...enemy, items: enemy.items.filter((_, i) => i !== at) }, t("ItemTaken", "one item less")),
        ),
      ),
      enemy.items.length < MAX_ENEMY_ITEMS
        ? keep(
            picker(
              () => itemChoices(item => item.held),
              t("GiveItem", "Give an item…"),
              choice => edit({ ...enemy, items: [...enemy.items, String(choice.value)] }, choice.label),
              150,
            ),
            `plan-${slot}-item`,
          )
        : null,
    ),
  );
}

/**
 * One enemy's column: Wild's Enemy 1 and 2, a trainer's members
 * @param member - A trainer's team member: `×` takes the column away (for Wild it sets it back to the game's)
 */
function enemyColumn(wave: number, plan: WavePlan, slot: number, label: string, member: boolean): HTMLElement {
  const enemy = plan.enemies[slot] ?? emptyEnemyPlan();
  const fixed = isFixedWave(wave);
  const edit = (next: EnemyPlan, what: string): void => {
    const enemies = [...plan.enemies];
    while (enemies.length <= slot) {
      enemies.push(null);
    }
    enemies[slot] = isEnemyPlanSet(next) ? next : null;
    while (!member && enemies.length > 0 && enemies.at(-1) === null) {
      enemies.pop();
    }
    // (an enemy planned on a "Game's" wave makes it wild; on a fixed wave, the fixed trainer's)
    const battle: Kind = plan.battle === "game" ? (fixed ? "trainer" : "wild") : plan.battle;
    savePlan(
      wave,
      { ...plan, battle, enemies },
      t("SentColumn", "Wave {{wave}}, {{who}}: {{what}}", { wave, who: label, what }),
    );
  };
  const clear = member
    ? button(
        "×",
        () =>
          savePlan(
            wave,
            { ...plan, enemies: plan.enemies.filter((_, at) => at !== slot) },
            t("SentColumn", "Wave {{wave}}, {{who}}: {{what}}", { wave, who: label, what: t("Removed", "taken out") }),
          ),
        "cdw-x",
      )
    : isEnemyPlanSet(enemy)
      ? button("×", () => edit(emptyEnemyPlan(), t("GamesPick", "the game's pick")), "cdw-x")
      : null;
  if (clear !== null) {
    clear.title = member ? t("RemoveMember", "Take this member out") : t("ClearColumn", "Back to the game's pick");
  }

  const fusion =
    enemy.fusion === null
      ? [
          keep(
            picker(
              () => list("species"),
              t("FuseWith", "Fuse with…"),
              choice =>
                edit(
                  { ...enemy, fusion: choice.value as number },
                  t("FusedWith", "fused with {{name}}", { name: choice.label }),
                ),
              130,
            ),
            `plan-${slot}-fusion`,
          ),
          button(
            t("RandomFusion", "Random"),
            () => edit({ ...enemy, fusion: "random" }, t("FusedRandom", "fused with a random partner")),
            "cdw-btn cdw-small",
          ),
        ]
      : [
          chip(
            enemy.fusion === "random"
              ? t("FusedRandom", "fused with a random partner")
              : t("FusedWith", "fused with {{name}}", { name: speciesName(enemy.fusion) }),
            () => edit({ ...enemy, fusion: null }, t("NotFused", "not fused")),
          ),
        ];

  const shiny = segmented<number | null>(
    [
      { label: t("GameChoice", "Game's"), value: null },
      { label: t("No", "No"), value: -1 },
      ...STARS.map((stars, rarity) => ({ label: stars, value: rarity })),
    ],
    enemy.shiny,
    v =>
      edit(
        { ...enemy, shiny: v },
        v === null ? t("ShinyGames", "the game's shiny") : v < 0 ? t("NotShinyWord", "not shiny") : STARS[v],
      ),
  );
  // (the stars in the game's rarity colours)
  for (const [rarity, node] of Array.from(shiny.children).slice(2).entries()) {
    node.classList.add(`cdw-s${rarity + 1}`);
  }

  const level = keep(
    numberBox(
      enemy.level,
      0,
      MAX_LEVEL,
      v => edit({ ...enemy, level: v }, v === 0 ? t("LevelGames", "the game's level") : `Lv ${v}`),
      1,
      56,
    ),
    `plan-${slot}-level`,
  );
  level.title = t("LevelZero", "0: the game's level");

  const key = `${wave}:${slot}`;
  const open = view.openMore.includes(key);
  const count = moreCount(enemy);
  const more = button(
    `${t("MoreOptions", "More")}${count > 0 ? ` (${count})` : ""} ${open ? "▴" : "▾"}`,
    () => {
      view.openMore = open ? view.openMore.filter(other => other !== key) : [...view.openMore, key];
      redraw();
    },
    "cdw-morebtn",
  );
  more.title = t("MoreHint", "Boss bars, ability, nature, Terastallize, gender, moves, held items");

  return el(
    "div",
    `cdw-ecol${isEnemyPlanSet(enemy) ? " cdw-set" : ""}`,
    el("div", "cdw-ecol-h", label, clear),
    el(
      "div",
      "cdw-row",
      enemy.species === null ? el("span", "cdw-icon cdw-icon-none") : speciesIcon(enemy.species),
      keep(
        picker(
          () => list("species"),
          enemy.species === null ? t("PickPokemon", "Pick a Pokémon…") : speciesName(enemy.species),
          choice => edit({ ...enemy, species: choice.value as number }, choice.label),
          170,
        ),
        `plan-${slot}-species`,
      ),
    ),
    el("div", "cdw-row", ...fusion),
    el("div", "cdw-row", el("span", "cdw-mini", "Lv"), level, shiny),
    more,
    open ? moreBox(enemy, slot, edit) : null,
  );
}

// #endregion

// #region The card

function kindName(kind: Kind): string {
  return {
    game: t("KindGameShort", "Game's"),
    wild: t("KindWild", "Wild"),
    trainer: t("KindTrainer", "Trainer"),
    me: t("KindMeShort", "Mystery"),
  }[kind];
}

function kindHint(kind: Kind): string {
  return {
    game: t("HintGame", "Pick a Pokémon below to plan a wild battle."),
    wild: t("HintWild", "A lone boss uses Enemy 1 only."),
    trainer: t("HintTrainer", "No member planned: the trainer's own team. Members past its size go unused."),
    me: t("HintMe", "The encounter brings its own enemies."),
  }[kind];
}

function setKind(wave: number, plan: WavePlan, kind: Kind): void {
  const note = t("SentKind", "Wave {{wave}}: {{kind}}", { wave, kind: kindName(kind) });
  switch (kind) {
    case "game":
      savePlan(wave, null, note);
      return;
    case "wild":
      savePlan(wave, { ...emptyWavePlan(), battle: "wild", enemies: plan.enemies.slice(0, MAX_WILD_ENEMIES) }, note);
      return;
    case "trainer":
      savePlan(wave, { ...emptyWavePlan(), battle: "trainer", enemies: plan.enemies, trainer: plan.trainer }, note);
      return;
    case "me":
      savePlan(wave, { ...emptyWavePlan(), battle: "me", encounter: plan.encounter }, note);
  }
}

function kindRow(wave: number, plan: WavePlan): HTMLElement {
  const kinds: Kind[] = ["game", "wild", "trainer", "me"];
  return el(
    "div",
    "cdw-row",
    segmented<Kind>(
      kinds.map(kind => ({ label: kindName(kind), value: kind })),
      plan.battle,
      kind => setKind(wave, plan, kind),
    ),
    el("span", "cdw-hint cdw-inline", kindHint(plan.battle)),
  );
}

/** A trainer's columns, and "+ Add a team member" */
function teamColumns(wave: number, plan: WavePlan, fixed: boolean): HTMLElement[] {
  const columns = plan.enemies.map((_, slot) =>
    enemyColumn(wave, plan, slot, t("MemberN", "Member {{n}}", { n: slot + 1 }), true),
  );
  return [
    el("div", "cdw-ecols", ...columns),
    plan.enemies.length < MAX_PLANNED_ENEMIES
      ? button(
          t("AddMember", "+ Add a team member"),
          () =>
            savePlan(
              wave,
              {
                ...plan,
                battle: fixed || plan.battle === "game" ? "trainer" : plan.battle,
                enemies: [...plan.enemies, null],
              },
              t("SentAddMember", "Wave {{wave}}: a team member more", { wave }),
            ),
          "cdw-btn cdw-small",
        )
      : el("span", "cdw-hint cdw-inline", t("TeamFull", "Six members: a full team.")),
  ];
}

function pickRow(
  label: string,
  current: string | null,
  onClear: () => void,
  choices: () => ReturnType<typeof list>,
  placeholder: string,
  onPick: (value: number, label: string) => void,
  id: string,
): HTMLElement {
  return line(
    label,
    current === null ? null : chip(current, onClear),
    keep(
      picker(choices, placeholder, choice => onPick(choice.value as number, choice.label), 180),
      id,
    ),
  );
}

function nextBattleCard(wave: number, next: number, plan: WavePlan): HTMLElement {
  const fixed = isFixedWave(wave);
  const parts: (HTMLElement | null)[] = [
    el(
      "div",
      "cdw-planhead",
      t("WaveWord", "Wave"),
      keep(
        numberBox(
          wave,
          next,
          100_000,
          v => {
            view.planWave = v;
            redraw();
          },
          1,
          64,
        ),
        "plan-wave",
      ),
      button(
        t("Reset", "Reset"),
        () => savePlan(wave, null, t("SentClearPlan", "Wave {{wave}}: plan cleared", { wave })),
        "cdw-btn cdw-small",
      ),
    ),
  ];
  const note = t("SentPlan", "Wave {{wave}}: plan changed", { wave });
  if (fixed) {
    parts.push(
      el(
        "div",
        "cdw-hint",
        t("FixedLine", "Wave {{wave}}: {{what}}. It always happens.", { wave, what: fixedBattleName(wave) }),
      ),
      ...teamColumns(wave, plan, true),
    );
  } else {
    parts.push(kindRow(wave, plan));
    if (plan.battle === "trainer") {
      parts.push(
        pickRow(
          t("Trainer", "Trainer"),
          plan.trainer === null ? null : labelOf("trainers", plan.trainer),
          () => savePlan(wave, { ...plan, trainer: null }, note),
          () => list("trainers"),
          t("TrainerSearch", "Any trainer…"),
          value => savePlan(wave, { ...plan, trainer: value }, note),
          "plan-trainer",
        ),
        ...teamColumns(wave, plan, false),
      );
    } else if (plan.battle === "me") {
      parts.push(
        pickRow(
          t("Encounter", "Mystery Encounter"),
          plan.encounter === null ? null : labelOf("encounters", plan.encounter),
          () => savePlan(wave, { ...plan, encounter: null }, note),
          () => list("encounters"),
          t("EncounterSearch", "Any encounter…"),
          value => savePlan(wave, { ...plan, encounter: value }, note),
          "plan-encounter",
        ),
      );
    } else {
      parts.push(
        el(
          "div",
          "cdw-ecols",
          ...Array.from({ length: MAX_WILD_ENEMIES }, (_, slot) =>
            enemyColumn(wave, plan, slot, t("EnemyN", "Enemy {{n}}", { n: slot + 1 }), false),
          ),
        ),
      );
    }
  }
  parts.push(el("div", "cdw-info cdw-sum", planSummary(wave, plan)));
  return field(
    wave === next ? t("NextBattle", "Next battle") : t("PlannedBattle", "Planned battle"),
    {
      wide: true,
      pending: isPending(`plan:${wave}`),
      words:
        "wave plan next battle wild trainer mystery encounter enemy species pokemon fusion fuse shiny level boss ability nature tera terastallize gender moves items",
    },
    el("div", "cdw-plan", ...parts),
  );
}

/** The other planned waves, to see and to open; `null` if there are none */
function otherWaves(shown: number): HTMLElement | null {
  // Every planned wave, the waiting plans too (a waiting "clear" takes one out)
  const waves = new Set(Object.keys(getCoopSession()?.debugState.plans ?? {}).map(Number));
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
  waves.delete(shown);
  if (waves.size === 0) {
    return null;
  }
  const rows = [...waves]
    .sort((a, b) => a - b)
    .map(wave =>
      el(
        "tr",
        "",
        el("td", "", t("WaveN", "Wave {{n}}", { n: wave })),
        el("td", "", planSummary(wave, planOf(wave)).replace(/^[^:]*:\s*/, "")),
        el(
          "td",
          "",
          button(
            t("Edit", "Edit"),
            () => {
              view.planWave = wave;
              redraw();
            },
            "cdw-btn cdw-small",
          ),
          " ",
          button(
            "×",
            () => savePlan(wave, null, t("SentClearPlan", "Wave {{wave}}: plan cleared", { wave })),
            "cdw-btn cdw-small",
          ),
        ),
      ),
    );
  return field(
    t("OtherWaves", "Other planned waves"),
    { words: "planned waves later" },
    el("table", "cdw-table", el("tbody", "", ...rows)),
  );
}

/** Where the run goes after this wave: a later wave, another biome */
function afterThisWave(next: number): HTMLElement {
  const state = getCoopSession()?.debugState;
  const jumpWaiting = pendingAction("jump");
  const jump = jumpWaiting?.t === "jump" ? jumpWaiting.v : (state?.jump ?? null);
  let jumpTo = Math.max(next + 1, jump ?? next + 9);
  const biomeWaiting = pendingAction("biome");
  const biome = biomeWaiting?.t === "biome" ? biomeWaiting.v : (state?.biome ?? null);
  return field(
    t("AfterWave", "After this wave"),
    {
      hint: t("AfterHint", "The run goes on at that wave, in that biome. Each is used once."),
      pending: isPending("jump") || isPending("biome"),
      words: "jump ahead later wave next biome",
    },
    el("span", "cdw-mini", t("AfterJump", "Jump to")),
    keep(
      numberBox(jumpTo, next + 1, 100_000, v => {
        jumpTo = v;
      }),
      "jump",
    ),
    button(
      t("AfterJumpButton", "Jump"),
      () => change(t("SentJump", "Next wave: {{v}}", { v: jumpTo }), "jump", { t: "jump", v: jumpTo }),
      "cdw-btn cdw-small",
    ),
    jump === null
      ? null
      : chip(t("JumpSet", "to wave {{v}}", { v: jump }), () =>
          change(t("SentNoJump", "No jump"), "jump", { t: "jump", v: null }),
        ),
    el("span", "cdw-mini", t("AfterBiome", "Biome")),
    biome === null
      ? null
      : chip(getBiomeName(biome as BiomeId), () =>
          change(t("SentNoBiome", "No biome change"), "biome", { t: "biome", v: null }),
        ),
    keep(
      picker(
        () => list("biomes"),
        t("BiomeSearch", "Any biome…"),
        choice =>
          change(t("SentBiome", "Next biome: {{what}}", { what: choice.label }), "biome", {
            t: "biome",
            v: choice.value as number,
          }),
        160,
      ),
      "biome",
    ),
  );
}

// #endregion

export function wavesSection(): HTMLElement[] {
  const next = currentWave() + 1;
  if (view.planWave < next) {
    view.planWave = next;
  }
  const wave = view.planWave;
  const cards: HTMLElement[] = [nextBattleCard(wave, next, planOf(wave))];
  const others = otherWaves(wave);
  if (others !== null) {
    cards.push(others);
  }
  cards.push(afterThisWave(next));
  return [el("div", "cdw-grid", ...cards)];
}
