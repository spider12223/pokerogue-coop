/**
 * The index of a given Pokemon on-field. \
 * Used as an index into `globalScene.getField`, as well as for most target-specifying effects.
 */
export enum BattlerIndex {
  ATTACKER = -1,
  PLAYER,
  PLAYER_2,
  ENEMY,
  ENEMY_2,
  /**
   * Co-op (D40): the third player Pokémon of a game of three. After the enemies, so their numbers, and everything sent
   * over the network, stay as they are
   */
  PLAYER_3,
}

/** @returns Whether the battler is on the player's side */
export function isPlayerBattler(index: BattlerIndex): boolean {
  return index === BattlerIndex.PLAYER || index === BattlerIndex.PLAYER_2 || index === BattlerIndex.PLAYER_3;
}

/** @returns The battler of the player's field slot `fieldIndex` (slot 2 is {@linkcode BattlerIndex.PLAYER_3}) */
export function playerBattlerOf(fieldIndex: number): BattlerIndex {
  return fieldIndex === 2 ? BattlerIndex.PLAYER_3 : fieldIndex;
}

/** @returns The field slot of the battler on its own side */
export function fieldIndexOfBattler(index: BattlerIndex): number {
  return index === BattlerIndex.PLAYER_3 ? 2 : index % 2;
}
