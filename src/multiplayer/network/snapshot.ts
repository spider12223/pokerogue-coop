import type { BattleScene } from "#app/battle-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { allMoves } from "#data/data-lists";
import type { MoveId } from "#enums/move-id";
import type { Pokemon } from "#field/pokemon";
import { z } from "zod";

export const pokemonViewSchema = z.object({
  id: z.number().int(),
  species: z.number().int().min(0),
  name: z.string(),
  level: z.number().int().min(1),
  hp: z.number().int().min(0),
  maxHp: z.number().int().min(1),
  status: z.number().int().nullable(),
  isShiny: z.boolean(),
  moves: z
    .array(
      z.object({
        id: z.number().int().min(0),
        name: z.string(),
        ppRemaining: z.number().int().min(0),
        ppMax: z.number().int().min(0),
      }),
    )
    .max(4),
});

export const weatherViewSchema = z.object({
  type: z.number().int().min(0),
  turnsRemaining: z.number().int().min(0),
});

export const battleSnapshotSchema = z.object({
  field: z.object({
    slot0: pokemonViewSchema.nullable(),
    slot1: pokemonViewSchema.nullable(),
    foe0: pokemonViewSchema.nullable(),
    foe1: pokemonViewSchema.nullable(),
  }),
  weather: weatherViewSchema.nullable(),
  recentLog: z.array(z.string()).max(10),
});

export type PokemonView = z.infer<typeof pokemonViewSchema>;
export type WeatherView = z.infer<typeof weatherViewSchema>;
export type BattleSnapshot = z.infer<typeof battleSnapshotSchema>;

export interface ProjectSnapshotOptions {
  getPokemonName?: (p: Pokemon) => string;
  getMoveName?: (id: MoveId) => string;
}

const defaultGetPokemonName = (p: Pokemon): string => getPokemonNameWithAffix(p);
const defaultGetMoveName = (id: MoveId): string => allMoves[id]?.name ?? "";

function pokemonToView(
  p: Pokemon,
  getPokemonName: (p: Pokemon) => string,
  getMoveName: (id: MoveId) => string,
): PokemonView {
  return {
    id: p.id,
    species: p.species.speciesId,
    name: getPokemonName(p),
    level: p.level,
    hp: p.hp,
    maxHp: p.getMaxHp(),
    status: p.status?.effect ?? null,
    isShiny: p.isShiny(),
    moves: p
      .getMoveset()
      .filter((pm): pm is NonNullable<typeof pm> => pm != null)
      .slice(0, 4)
      .map(pm => ({
        id: pm.moveId,
        name: getMoveName(pm.moveId),
        ppRemaining: Math.max(0, pm.getMovePp() - pm.ppUsed),
        ppMax: pm.getMovePp(),
      })),
  };
}

function maybeProject(
  p: Pokemon | null | undefined,
  getPokemonName: (p: Pokemon) => string,
  getMoveName: (id: MoveId) => string,
): PokemonView | null {
  return p ? pokemonToView(p, getPokemonName, getMoveName) : null;
}

export function projectSnapshot(scene: BattleScene, opts: ProjectSnapshotOptions = {}): BattleSnapshot {
  const getPokemonName = opts.getPokemonName ?? defaultGetPokemonName;
  const getMoveName = opts.getMoveName ?? defaultGetMoveName;
  const playerField = scene.getPlayerField();
  const enemyField = scene.getEnemyField();
  const weather = scene.arena.weather;
  return {
    field: {
      slot0: maybeProject(playerField[0], getPokemonName, getMoveName),
      slot1: maybeProject(playerField[1], getPokemonName, getMoveName),
      foe0: maybeProject(enemyField[0], getPokemonName, getMoveName),
      foe1: maybeProject(enemyField[1], getPokemonName, getMoveName),
    },
    weather: weather
      ? {
          type: weather.weatherType,
          turnsRemaining: weather.turnsLeft,
        }
      : null,
    recentLog: [],
  };
}
