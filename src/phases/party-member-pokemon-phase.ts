import { globalScene } from "#app/global-scene";
import type { Pokemon } from "#field/pokemon";
import { FieldPhase } from "#phases/field-phase";

export abstract class PartyMemberPokemonPhase extends FieldPhase {
  protected partyMemberIndex: number;
  protected fieldIndex: number;
  protected player: boolean;

  constructor(partyMemberIndex: number, player: boolean) {
    super();

    this.partyMemberIndex = partyMemberIndex;
    // Co-op (D40): a game of three has a third slot of ours
    const slots = player
      ? globalScene.currentBattle.getPlayerBattlerCount()
      : globalScene.currentBattle.getBattlerCount();
    this.fieldIndex = partyMemberIndex < slots ? partyMemberIndex : -1;
    this.player = player;
  }

  getParty(): Pokemon[] {
    return this.player ? globalScene.getPlayerParty() : globalScene.getEnemyParty();
  }

  getPokemon(): Pokemon {
    return this.getParty()[this.partyMemberIndex];
  }

  isPlayer(): boolean {
    return this.player;
  }
}
