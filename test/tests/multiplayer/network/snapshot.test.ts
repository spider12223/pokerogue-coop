import { type ProjectSnapshotOptions, projectSnapshot } from "#app/multiplayer/network/snapshot";
import { StatusEffect } from "#enums/status-effect";
import { WeatherType } from "#enums/weather-type";
import { describe, expect, it } from "vitest";

interface FakeMoveOpts {
  moveId: number;
  ppUsed?: number;
  movePp?: number;
}

interface FakePokemonOpts {
  id?: number;
  speciesId?: number;
  level?: number;
  hp?: number;
  maxHp?: number;
  status?: StatusEffect | null;
  isShiny?: boolean;
  moves?: Array<FakeMoveOpts | null>;
}

function makeFakePokemon(opts: FakePokemonOpts = {}) {
  return {
    id: opts.id ?? 1,
    species: { speciesId: opts.speciesId ?? 25 },
    level: opts.level ?? 50,
    hp: opts.hp ?? 100,
    getMaxHp: () => opts.maxHp ?? 100,
    status: opts.status == null ? null : { effect: opts.status },
    isShiny: () => opts.isShiny ?? false,
    getMoveset: () =>
      (opts.moves ?? []).map(m =>
        m
          ? {
              moveId: m.moveId,
              ppUsed: m.ppUsed ?? 0,
              getMovePp: () => m.movePp ?? 35,
            }
          : null,
      ),
  };
}

interface FakeSceneOpts {
  playerField?: ReturnType<typeof makeFakePokemon>[] | (ReturnType<typeof makeFakePokemon> | undefined)[];
  enemyField?: ReturnType<typeof makeFakePokemon>[] | (ReturnType<typeof makeFakePokemon> | undefined)[];
  weather?: { type: WeatherType; turnsRemaining: number } | null;
  recentMessages?: string[];
}

function makeFakeScene(opts: FakeSceneOpts = {}) {
  return {
    getPlayerField: () => opts.playerField ?? [],
    getEnemyField: () => opts.enemyField ?? [],
    arena: {
      weather: opts.weather
        ? {
            weatherType: opts.weather.type,
            turnsLeft: opts.weather.turnsRemaining,
          }
        : null,
    },
    messageLog: {
      getRecent: (_n: number) => opts.recentMessages ?? [],
    },
  };
}

const stubOpts: ProjectSnapshotOptions = {
  getPokemonName: (p: any) => `P${p.species.speciesId}`,
  getMoveName: (id: number) => `M${id}`,
};

describe("projectSnapshot", () => {
  it("returns nulls for absent slots in a single battle", () => {
    const scene = makeFakeScene({
      playerField: [makeFakePokemon(), undefined],
      enemyField: [makeFakePokemon({ speciesId: 4 }), undefined],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0).not.toBeNull();
    expect(snap.field.slot1).toBeNull();
    expect(snap.field.foe0).not.toBeNull();
    expect(snap.field.foe1).toBeNull();
  });

  it("populates all 4 field positions in a double battle", () => {
    const scene = makeFakeScene({
      playerField: [makeFakePokemon({ speciesId: 1 }), makeFakePokemon({ speciesId: 2 })],
      enemyField: [makeFakePokemon({ speciesId: 3 }), makeFakePokemon({ speciesId: 4 })],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0?.species).toBe(1);
    expect(snap.field.slot1?.species).toBe(2);
    expect(snap.field.foe0?.species).toBe(3);
    expect(snap.field.foe1?.species).toBe(4);
  });

  it("reflects fainted state (hp=0, status=FAINT)", () => {
    const scene = makeFakeScene({
      playerField: [makeFakePokemon({ hp: 0, status: StatusEffect.FAINT })],
      enemyField: [],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0?.hp).toBe(0);
    expect(snap.field.slot0?.status).toBe(StatusEffect.FAINT);
  });

  it("reflects status effects on healthy pokemon", () => {
    const scene = makeFakeScene({
      playerField: [makeFakePokemon({ status: StatusEffect.POISON })],
      enemyField: [],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0?.status).toBe(StatusEffect.POISON);
  });

  it("populates weather when present", () => {
    const scene = makeFakeScene({
      weather: { type: WeatherType.RAIN, turnsRemaining: 3 },
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.weather).toEqual({ type: WeatherType.RAIN, turnsRemaining: 3 });
  });

  it("returns null weather when absent", () => {
    const scene = makeFakeScene({ weather: null });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.weather).toBeNull();
  });

  it("propagates move PP correctly when one move has been used", () => {
    const scene = makeFakeScene({
      playerField: [
        makeFakePokemon({
          moves: [
            { moveId: 33, movePp: 35, ppUsed: 5 },
            { moveId: 45, movePp: 40, ppUsed: 0 },
          ],
        }),
      ],
      enemyField: [],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0?.moves).toHaveLength(2);
    expect(snap.field.slot0?.moves[0]).toEqual({
      id: 33,
      name: "M33",
      ppRemaining: 30,
      ppMax: 35,
    });
    expect(snap.field.slot0?.moves[1].ppRemaining).toBe(40);
  });

  it("filters null moveset entries (pokemon with fewer than 4 moves)", () => {
    const scene = makeFakeScene({
      playerField: [
        makeFakePokemon({
          moves: [{ moveId: 1 }, null, { moveId: 2 }, null],
        }),
      ],
      enemyField: [],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0?.moves).toHaveLength(2);
    expect(snap.field.slot0?.moves.map(m => m.id)).toEqual([1, 2]);
  });

  it("propagates isShiny", () => {
    const scene = makeFakeScene({
      playerField: [makeFakePokemon({ isShiny: true })],
      enemyField: [],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0?.isShiny).toBe(true);
  });

  it("uses the injected getPokemonName for the name field", () => {
    const scene = makeFakeScene({
      playerField: [makeFakePokemon({ speciesId: 25 })],
      enemyField: [],
    });
    const snap = projectSnapshot(scene as any, {
      getPokemonName: () => "Custom Name",
      getMoveName: stubOpts.getMoveName,
    });
    expect(snap.field.slot0?.name).toBe("Custom Name");
  });

  it("propagates the pokemon id field", () => {
    const scene = makeFakeScene({
      playerField: [makeFakePokemon({ id: 12345 })],
      enemyField: [],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.field.slot0?.id).toBe(12345);
  });

  it("recentLog is empty when scene has no recent messages", () => {
    const scene = makeFakeScene({});
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.recentLog).toEqual([]);
  });

  it("recentLog reflects scene.messageLog.getRecent(5)", () => {
    const scene = makeFakeScene({
      recentMessages: ["Wild Pidgey appeared!", "Pikachu used Tackle!", "It's super effective!"],
    });
    const snap = projectSnapshot(scene as any, stubOpts);
    expect(snap.recentLog).toEqual(["Wild Pidgey appeared!", "Pikachu used Tackle!", "It's super effective!"]);
  });
});
