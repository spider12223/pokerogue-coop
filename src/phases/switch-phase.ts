import { globalScene } from "#app/global-scene";
import { isLinked, reportBridgeError } from "#coop/bridge";
import { coopSwitchFilter, isAllowedSwitch, type SwitchReason, switchTargets } from "#coop/control";
import { isCoop } from "#coop/session";
import { coopDecideSwitch } from "#coop/switch-bridge";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import { BattlePhase } from "#phases/battle-phase";
import { PartyOption, PartyUiHandler } from "#ui/party-ui-handler";

/**
 * Opens the party selector UI and transitions into a {@linkcode SwitchSummonPhase}
 * for the player (if a switch would be valid for the current battle state).
 */
export class SwitchPhase extends BattlePhase {
  public readonly phaseName = "SwitchPhase";
  protected readonly fieldIndex: number;
  private readonly switchType: SwitchType;
  private readonly isModal: boolean;
  private readonly doReturn: boolean;

  /**
   * Creates a new SwitchPhase
   * @param switchType {@linkcode SwitchType} The type of switch logic this phase implements
   * @param fieldIndex Field index to switch out
   * @param isModal Indicates if the switch should be forced (true) or is
   * optional (false).
   * @param doReturn Indicates if the party member on the field should be
   * recalled to ball or has already left the field. Passed to {@linkcode SwitchSummonPhase},
   * and is (ostensibly) only set to `false` from `FaintPhase`.
   */
  constructor(switchType: SwitchType, fieldIndex: number, isModal: boolean, doReturn: boolean) {
    super();

    this.switchType = switchType;
    this.fieldIndex = fieldIndex;
    this.isModal = isModal;
    this.doReturn = doReturn;
  }

  /** Co-op: whether this is the replacement of a Pokémon that fainted (the only switch the arrange step may supersede) */
  public get isFaintReplacement(): boolean {
    return this.isModal && !this.doReturn;
  }

  start() {
    super.start();

    // Skip modal switch if impossible (no remaining party members that aren't already in battle)
    if (this.isModal && globalScene.getPokemonAllowedInBattle().every(p => p.isOnField())) {
      return super.end();
    }

    /**
     * Skip if the fainted party member has been revived already. doReturn is
     * only passed as `false` from FaintPhase (as opposed to other usages such
     * as ForceSwitchOutAttr or CheckSwitchPhase), so we only want to check this
     * if the mon should have already been returned but is still alive and well
     * on the field. see also; battle.test.ts
     */
    // TODO: If a Phasing move kills its own user, when does said user appear on field?
    // Is it after the user faints
    if (this.isModal && !this.doReturn && !globalScene.getPlayerParty()[this.fieldIndex].isFainted()) {
      return super.end();
    }

    // Check if there is any space still in field
    if (this.isModal && globalScene.getPlayerField(true).length > globalScene.currentBattle.getBattlerCount()) {
      return super.end();
    }

    // Override field index to 0 in case of double battle where 2/3 remaining legal party members fainted at once
    const fieldIndex =
      globalScene.currentBattle.getBattlerCount() === 1 || globalScene.getPokemonAllowedInBattle().length > 1
        ? this.fieldIndex
        : 0;

    // Co-op (D7): a faint is replaced from the owner's bench, then the partner's; any other switch from the controller's
    // own. Nothing to choose from means no switch (upstream behaviour when there is no bench).
    const reason = this.isModal && !this.doReturn ? "faint" : "voluntary";
    if (isCoop() && switchTargets(fieldIndex, reason).length === 0) {
      return super.end();
    }

    if (isLinked()) {
      this.startSequenced(fieldIndex, reason);
      return;
    }

    globalScene.ui.setMode(
      UiMode.PARTY,
      this.isModal ? PartyUiMode.FAINT_SWITCH : PartyUiMode.POST_BATTLE_SWITCH,
      fieldIndex,
      (slotIndex: number, option: PartyOption) => {
        if (
          slotIndex >= globalScene.currentBattle.getBattlerCount()
          && slotIndex < 6
          && (!isCoop() || isAllowedSwitch(fieldIndex, slotIndex, reason))
        ) {
          const switchType = option === PartyOption.PASS_BATON ? SwitchType.BATON_PASS : this.switchType;
          globalScene.phaseManager.unshiftNew("SwitchSummonPhase", switchType, fieldIndex, slotIndex, this.doReturn);
        }
        globalScene.ui.setMode(UiMode.MESSAGE).then(() => super.end());
      },
      isCoop()
        ? coopSwitchFilter(fieldIndex, reason, PartyUiHandler.FilterNonFainted)
        : PartyUiHandler.FilterNonFainted,
    );
  }

  /**
   * Co-op with a network (D2, D7): the replacement is a sequenced decision. Whoever may pick sees the party screen, the
   * other client waits, and both send the chosen Pokémon out when the decision comes back.
   */
  private startSequenced(fieldIndex: number, reason: SwitchReason): void {
    const leaving = globalScene.getPlayerParty()[fieldIndex];
    coopDecideSwitch({
      fieldIndex,
      reason,
      leavingId: leaving.id,
      partyMode: this.isModal ? PartyUiMode.FAINT_SWITCH : PartyUiMode.POST_BATTLE_SWITCH,
    })
      .then(({ partyIndex, baton }) => {
        if (partyIndex !== null) {
          const switchType = baton ? SwitchType.BATON_PASS : this.switchType;
          globalScene.phaseManager.unshiftNew("SwitchSummonPhase", switchType, fieldIndex, partyIndex, this.doReturn);
        }
        return globalScene.ui.setMode(UiMode.MESSAGE);
      })
      .then(() => super.end())
      .catch(reportBridgeError);
  }
}
