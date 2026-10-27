import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { activeOverrides } from "#app/overrides";
import { AfkWatcher, showTookOver } from "#coop/afk";
import { coopGate, coopText, isLinked, mySeat, reportBridgeError } from "#coop/bridge";
import { coopRewardOptionsReady } from "#coop/checkpoints";
import { endTurnCosmetics, getCosmeticView } from "#coop/cosmetic-view";
import type { RewardOptionView, RewardView } from "#coop/legal";
import { type PartyEdit, partyEditKey } from "#coop/party-edit";
import { applyPartyEdit } from "#coop/party-edit-run";
import type { DecisionKey, Seat } from "#coop/protocol";
import {
  isRewardAction,
  isRewardKind,
  kindOfAction,
  type RewardAction,
  type RewardTarget,
  rewardKey,
  rewardWindow,
} from "#coop/reward-actions";
import { ProposalRejectedError, type RejectReason } from "#coop/sequencer";
import { isCoop, requireCoopSession, rewardPickerOf } from "#coop/session";
import { tradeRequestKey } from "#coop/trade";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import type { ModifierTier } from "#enums/modifier-tier";
import { PartyUiMode } from "#enums/party-ui-mode";
import { UiMode } from "#enums/ui-mode";
import type { Modifier } from "#modifiers/modifier";
import {
  ExtraModifierModifier,
  HealShopCostModifier,
  PokemonHeldItemModifier,
  TempExtraModifierModifier,
} from "#modifiers/modifier";
import type { CustomModifierSettings, ModifierType, ModifierTypeOption } from "#modifiers/modifier-type";
import {
  EvolutionItemModifierType,
  FormChangeItemModifierType,
  FusePokemonModifierType,
  getPlayerModifierTypeOptions,
  getPlayerShopModifierTypeOptionsForWave,
  PokemonModifierType,
  PokemonMoveModifierType,
  PokemonPpRestoreModifierType,
  PokemonPpUpModifierType,
  RememberMoveModifierType,
  regenerateModifierPoolThresholds,
  TmModifierType,
} from "#modifiers/modifier-type";
import { BattlePhase } from "#phases/battle-phase";
import type { ConfirmModeConfig } from "#types/ui-types";
import type { ModifierSelectUiHandler, RewardScreenCoop } from "#ui/modifier-select-ui-handler";
import { SHOP_OPTIONS_ROW_LIMIT } from "#ui/modifier-select-ui-handler";
import { PartyOption, PartyUiHandler } from "#ui/party-ui-handler";
import { NumberHolder } from "#utils/common";
import i18next from "i18next";

export type ModifierSelectCallback = (rowCursor: number, cursor: number) => boolean;

/** What the party screen is opened with to choose the Pokémon (or move) a modifier is for */
interface TargetMenu {
  partyUiMode: PartyUiMode;
  selectFilter: PokemonModifierType["selectFilter"];
  moveSelectFilter: PokemonMoveModifierType["moveSelectFilter"] | undefined;
  tmMoveId: TmModifierType["moveId"] | undefined;
  isPpRestore: boolean;
  /** The evolution or form change item, whose compatibility the party screen shows */
  modifierItemId: EvolutionItemModifierType["evolutionItem"] | FormChangeItemModifierType["formChangeItem"] | undefined;
  isMove: boolean;
  isRememberMove: boolean;
}

export class SelectModifierPhase extends BattlePhase {
  public readonly phaseName = "SelectModifierPhase";

  // #region Co-op reward screen (D9)
  /** Which reward screen of the run this is (`rewardPickCount - 1`); a reroll or a copy is the same screen */
  private screen = 0;
  /** Who picks on this screen */
  private picker: Seat = "host";
  /** The screen has been closed by a decision: nothing more is proposed or applied */
  private closed = false;
  /** An action of this player was proposed and has not come back yet */
  private pending = false;
  /**
   * The switches back to the reward screen that {@linkcode resetSequenced} started and that are not over. A switch from the
   * party screen fades out and in, which takes a third of a second, and a decision can come back sooner (the host sequences
   * its own at once). A decision is applied only after the switches: the message mode that a pick sets must be the last
   * mode to be entered, not the one that the late switch overwrites.
   */
  private screenSwitches = 0;
  private screenReady: Promise<unknown> = Promise.resolve();
  private stopWatchingRejections: (() => void) | null = null;
  /** This player took over the screen from a partner who did not answer (D17) */
  private takingOver = false;
  /** A change of this player's own Pokémon that was proposed and has not come back yet (D28) */
  private pendingEdit: PartyEdit | null = null;
  private editRetries = 0;
  /** The pending edit was refused for the step that is still open here: propose it once that step has closed */
  private editAfterStep = false;
  private watcher: AfkWatcher | null = null;
  private readonly sequencedCallback: ModifierSelectCallback = (rowCursor, cursor) =>
    this.onSequencedInput(rowCursor, cursor);
  // #endregion
  private readonly rerollCount: number;
  private readonly modifierTiers?: ModifierTier[] | undefined;
  private readonly customModifierSettings?: CustomModifierSettings | undefined;
  private readonly isCopy: boolean;

  private typeOptions: ModifierTypeOption[];

  constructor(
    rerollCount = 0,
    modifierTiers?: ModifierTier[],
    customModifierSettings?: CustomModifierSettings,
    isCopy = false,
  ) {
    super();

    this.rerollCount = rerollCount;
    this.modifierTiers = modifierTiers;
    this.customModifierSettings = customModifierSettings;
    this.isCopy = isCopy;
  }

  start() {
    super.start();

    if (!this.isPlayer()) {
      return false;
    }

    if (!this.rerollCount && !this.isCopy) {
      this.updateSeed();
      if (isCoop()) {
        // A new reward screen (a reroll is the same one): the picker alternates with the count (D9)
        requireCoopSession().beginRewardScreen();
      }
    } else if (this.rerollCount) {
      globalScene.reroll = false;
    }

    const party = globalScene.getPlayerParty();
    if (!this.isCopy) {
      regenerateModifierPoolThresholds(party, this.getPoolType(), this.rerollCount);
    }
    const modifierCount = this.getModifierCount();

    this.typeOptions = this.getModifierTypeOptions(modifierCount);
    coopRewardOptionsReady(this, this.typeOptions);

    if (isLinked()) {
      this.startSequenced();
      return;
    }

    const modifierSelectCallback = (rowCursor: number, cursor: number) => {
      if (rowCursor < 0 || cursor < 0) {
        globalScene.ui.showText(i18next.t("battle:skipItemQuestion"), null, () => {
          const skipRewardConfirmOptions: ConfirmModeConfig = {
            yesHandler: () => {
              globalScene.ui.revertMode();
              globalScene.ui.setMode(UiMode.MESSAGE);
              super.end();
            },
            noHandler: () => this.resetModifierSelect(modifierSelectCallback),
          };
          globalScene.ui.setOverlayMode(UiMode.CONFIRM, skipRewardConfirmOptions);
        });
        return false;
      }

      switch (rowCursor) {
        // Execute one of the options from the bottom row
        case 0:
          switch (cursor) {
            case 0:
              return this.rerollModifiers();
            case 1:
              return this.openModifierTransferScreen(modifierSelectCallback);
            // Check the party, pass a callback to restore the modifier select screen.
            case 2:
              globalScene.ui.setModeWithoutClear(UiMode.PARTY, PartyUiMode.CHECK, -1, () => {
                this.resetModifierSelect(modifierSelectCallback);
              });
              return true;
            case 3:
              return this.toggleRerollLock();
            default:
              return false;
          }
        // Pick an option from the rewards
        case 1:
          return this.selectRewardModifierOption(cursor, modifierSelectCallback);
        // Pick an option from the shop
        default: {
          return this.selectShopModifierOption(rowCursor, cursor, modifierSelectCallback);
        }
      }
    };

    this.resetModifierSelect(modifierSelectCallback);
  }

  // Pick a modifier from among the rewards and apply it
  private selectRewardModifierOption(cursor: number, modifierSelectCallback: ModifierSelectCallback): boolean {
    if (this.typeOptions.length === 0) {
      globalScene.ui.clearText();
      globalScene.ui.setMode(UiMode.MESSAGE);
      super.end();
      return true;
    }
    const modifierType = this.typeOptions[cursor].type;
    return this.applyChosenModifier(modifierType, -1, modifierSelectCallback);
  }

  // Pick a modifier from the shop and apply it
  private selectShopModifierOption(
    rowCursor: number,
    cursor: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): boolean {
    const shopOptions = getPlayerShopModifierTypeOptionsForWave(
      globalScene.currentBattle.waveIndex,
      globalScene.getWaveMoneyAmount(1),
    );
    const shopOption =
      shopOptions[
        rowCursor > 2 || shopOptions.length <= SHOP_OPTIONS_ROW_LIMIT ? cursor : cursor + SHOP_OPTIONS_ROW_LIMIT
      ];
    const modifierType = shopOption.type;
    // Apply Black Sludge to healing item cost
    const healingItemCost = new NumberHolder(shopOption.cost);
    globalScene.applyModifier(HealShopCostModifier, true, healingItemCost);
    const cost = healingItemCost.value;

    if (globalScene.money < cost && !activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      globalScene.ui.playError();
      return false;
    }

    return this.applyChosenModifier(modifierType, cost, modifierSelectCallback);
  }

  // Apply a chosen modifier: do an effect or open the party menu
  private applyChosenModifier(
    modifierType: ModifierType,
    cost: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): boolean {
    if (modifierType instanceof PokemonModifierType) {
      if (modifierType instanceof FusePokemonModifierType) {
        this.openFusionMenu(modifierType, cost, modifierSelectCallback);
      } else {
        this.openModifierMenu(modifierType, cost, modifierSelectCallback);
      }
    } else {
      this.applyModifier(modifierType.newModifier()!, cost);
    }
    return cost === -1;
  }

  // Reroll rewards
  private rerollModifiers() {
    const rerollCost = this.getRerollCost(globalScene.lockModifierTiers);
    if (rerollCost < 0 || globalScene.money < rerollCost) {
      globalScene.ui.playError();
      return false;
    }
    globalScene.reroll = true;
    globalScene.phaseManager.unshiftNew(
      "SelectModifierPhase",
      this.rerollCount + 1,
      this.typeOptions.map(o => o.type?.tier).filter(t => t !== undefined) as ModifierTier[],
    );
    globalScene.ui.clearText();
    globalScene.ui.setMode(UiMode.MESSAGE).then(() => super.end());
    if (!activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      globalScene.money -= rerollCost;
      globalScene.updateMoneyText();
      globalScene.animateMoneyChanged(false);
    }
    audioManager.playSound("se/buy");
    return true;
  }

  // Transfer modifiers among party pokemon
  private openModifierTransferScreen(modifierSelectCallback: ModifierSelectCallback) {
    const party = globalScene.getPlayerParty();
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      PartyUiMode.MODIFIER_TRANSFER,
      -1,
      (fromSlotIndex: number, itemIndex: number, itemQuantity: number, toSlotIndex: number) => {
        if (
          toSlotIndex !== undefined
          && fromSlotIndex < 6
          && toSlotIndex < 6
          && fromSlotIndex !== toSlotIndex
          && itemIndex > -1
        ) {
          const itemModifiers = globalScene.findModifiers(
            m => m instanceof PokemonHeldItemModifier && m.isTransferable && m.pokemonId === party[fromSlotIndex].id,
          ) as PokemonHeldItemModifier[];
          const itemModifier = itemModifiers[itemIndex];
          globalScene.tryTransferHeldItemModifier(
            itemModifier,
            party[toSlotIndex],
            true,
            itemQuantity,
            undefined,
            undefined,
            false,
          );
        } else {
          this.resetModifierSelect(modifierSelectCallback);
        }
      },
      PartyUiHandler.FilterItemMaxStacks,
    );
    return true;
  }

  // Toggle reroll lock
  private toggleRerollLock() {
    const rerollCost = this.getRerollCost(globalScene.lockModifierTiers);
    if (rerollCost < 0) {
      // Reroll lock button is also disabled when reroll is disabled
      globalScene.ui.playError();
      return false;
    }
    globalScene.lockModifierTiers = !globalScene.lockModifierTiers;
    const uiHandler = globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler;
    uiHandler.setRerollCost(this.getRerollCost(globalScene.lockModifierTiers));
    uiHandler.updateLockRaritiesText();
    uiHandler.updateRerollCostText();
    return false;
  }

  /**
   * Apply the effects of the chosen modifier
   * @param modifier - The modifier to apply
   * @param cost - The cost of the modifier if it was purchased, or -1 if selected as the modifier reward
   * @param playSound - Whether the 'obtain modifier' sound should be played when adding the modifier.
   */
  private applyModifier(modifier: Modifier, cost = -1, playSound = false): void {
    const result = globalScene.addModifier(modifier, false, playSound, undefined, undefined, cost);
    // Queue a copy of this phase when applying a TM or Memory Mushroom.
    // If the player selects either of these, then escapes out of consuming them,
    // they are returned to a shop in the same state.
    if (modifier.type instanceof RememberMoveModifierType || modifier.type instanceof TmModifierType) {
      globalScene.phaseManager.unshiftPhase(this.copy());
    }

    if (cost !== -1 && !(modifier.type instanceof RememberMoveModifierType)) {
      if (result) {
        if (!activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
          globalScene.money -= cost;
          globalScene.updateMoneyText();
          globalScene.animateMoneyChanged(false);
        }
        audioManager.playSound("se/buy");
        // Not `getHandler()`: in co-op the partner's purchase can be applied while this player is in the party screen
        (globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler).updateCostText();
      } else {
        globalScene.ui.playError();
      }
    } else {
      globalScene.ui.clearText();
      globalScene.ui.setMode(UiMode.MESSAGE);
      this.finishScreen();
    }
  }

  // Opens the party menu specifically for fusions
  private openFusionMenu(
    modifierType: PokemonModifierType,
    cost: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): void {
    const party = globalScene.getPlayerParty();
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      PartyUiMode.SPLICE,
      -1,
      (fromSlotIndex: number, spliceSlotIndex: number) => {
        if (
          spliceSlotIndex !== undefined
          && fromSlotIndex < 6
          && spliceSlotIndex < 6
          && fromSlotIndex !== spliceSlotIndex
        ) {
          globalScene.ui.setMode(UiMode.MODIFIER_SELECT, this.isPlayer()).then(() => {
            const modifier = modifierType.newModifier(party[fromSlotIndex], party[spliceSlotIndex])!; //TODO: is the bang correct?
            this.applyModifier(modifier, cost, true);
          });
        } else {
          this.resetModifierSelect(modifierSelectCallback);
        }
      },
      modifierType.selectFilter,
    );
  }

  /** How the party screen is opened to choose the Pokémon (or the move) for this kind of modifier */
  private getTargetMenu(modifierType: PokemonModifierType): TargetMenu {
    const isMove = modifierType instanceof PokemonMoveModifierType;
    const isTm = modifierType instanceof TmModifierType;
    const isRememberMove = modifierType instanceof RememberMoveModifierType;
    const isEvolutionItem = modifierType instanceof EvolutionItemModifierType;
    const isFormChangeItem = modifierType instanceof FormChangeItemModifierType;
    return {
      partyUiMode: isMove
        ? PartyUiMode.MOVE_MODIFIER
        : isTm
          ? PartyUiMode.TM_MODIFIER
          : isRememberMove
            ? PartyUiMode.REMEMBER_MOVE_MODIFIER
            : isEvolutionItem
              ? PartyUiMode.EVOLUTION_ITEM_MODIFIER
              : isFormChangeItem
                ? PartyUiMode.FORM_CHANGE_ITEM_MODIFIER
                : PartyUiMode.MODIFIER,
      selectFilter: modifierType.selectFilter,
      moveSelectFilter: isMove ? (modifierType as PokemonMoveModifierType).moveSelectFilter : undefined,
      tmMoveId: isTm ? (modifierType as TmModifierType).moveId : undefined,
      isPpRestore:
        modifierType instanceof PokemonPpRestoreModifierType || modifierType instanceof PokemonPpUpModifierType,
      modifierItemId: isEvolutionItem
        ? (modifierType as EvolutionItemModifierType).evolutionItem
        : isFormChangeItem
          ? (modifierType as FormChangeItemModifierType).formChangeItem
          : undefined,
      isMove,
      isRememberMove,
    };
  }

  // Opens the party menu to apply one of various modifiers
  private openModifierMenu(
    modifierType: PokemonModifierType,
    cost: number,
    modifierSelectCallback: ModifierSelectCallback,
  ): void {
    const party = globalScene.getPlayerParty();
    const menu = this.getTargetMenu(modifierType);
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      menu.partyUiMode,
      -1,
      (slotIndex: number, option: PartyOption) => {
        if (slotIndex < 6) {
          globalScene.ui.setMode(UiMode.MODIFIER_SELECT, this.isPlayer()).then(() => {
            const modifier = menu.isMove
              ? modifierType.newModifier(party[slotIndex], option - PartyOption.MOVE_1)
              : menu.isRememberMove
                ? modifierType.newModifier(party[slotIndex], option as number)
                : modifierType.newModifier(party[slotIndex]);
            this.applyModifier(modifier!, cost, true); // TODO: is the bang correct?
          });
        } else {
          this.resetModifierSelect(modifierSelectCallback);
        }
      },
      menu.selectFilter,
      menu.moveSelectFilter,
      menu.tmMoveId,
      menu.isPpRestore,
      menu.modifierItemId,
    );
  }

  // Function that determines how many reward slots are available
  private getModifierCount(): number {
    const modifierCountHolder = new NumberHolder(3);
    globalScene.applyModifiers(ExtraModifierModifier, true, modifierCountHolder);
    globalScene.applyModifiers(TempExtraModifierModifier, true, modifierCountHolder);

    // If custom modifiers are specified, overrides default item count
    if (this.customModifierSettings) {
      const newItemCount =
        (this.customModifierSettings.guaranteedModifierTiers?.length ?? 0)
        + (this.customModifierSettings.guaranteedModifierTypeOptions?.length ?? 0)
        + (this.customModifierSettings.guaranteedModifierTypeFuncs?.length ?? 0);
      if (this.customModifierSettings.fillRemaining) {
        const originalCount = modifierCountHolder.value;
        modifierCountHolder.value = originalCount > newItemCount ? originalCount : newItemCount;
      } else {
        modifierCountHolder.value = newItemCount;
      }
    }

    return modifierCountHolder.value;
  }

  // Function that resets the reward selection screen,
  // e.g. after pressing cancel in the party ui or while learning a move
  private resetModifierSelect(modifierSelectCallback: ModifierSelectCallback) {
    globalScene.ui.setMode(
      UiMode.MODIFIER_SELECT,
      this.isPlayer(),
      this.typeOptions,
      modifierSelectCallback,
      this.getRerollCost(globalScene.lockModifierTiers),
    );
  }

  // #region Co-op reward screen (D9)

  /**
   * Co-op with a network (DECISIONS D9): the reward screen is a window that stays open until the picker picks or skips.
   * Every action of either player is a decision in the sequence: the UI only proposes, and both clients apply the
   * decisions in order. The picker makes the free pick or skip and controls reroll and Lock Capsule; either player buys
   * from the shop (choosing the target) and moves items from their own Pokémon.
   */
  private startSequenced(): void {
    const session = requireCoopSession();
    this.screen = session.rewardPickCount - 1;
    this.picker = rewardPickerOf(this.screen);
    this.takingOver = session.rewardTakeover === this.screen;
    this.stopWatchingRejections = session.link!.sequencer.onProposalRejected(({ key, reason }) =>
      this.onRejected(key, reason),
    );
    // The markers of the last turn are over (D8, D16)
    endTurnCosmetics();
    this.resetSequenced();
    this.runWindow().catch(reportBridgeError);
  }

  /** The screen, as this player sees it: the picker's with every button, the other's read-only apart from the shop */
  private resetSequenced(): void {
    if (this.closed) {
      return;
    }
    const session = requireCoopSession();
    const handler = this.rewardHandler();
    if (globalScene.ui.mode === UiMode.MODIFIER_SELECT && handler.active) {
      // The screen is up and only its input was taken (a cancel, a refused button): give the input back. Switching to the
      // mode it is already in would do nothing, and the screen would not answer until the next decision
      handler.show([this.isPlayer(), this.typeOptions, this.sequencedCallback]);
      return;
    }
    const label =
      this.picker === mySeat() || this.takingOver
        ? undefined
        : coopText("pickerChoosing", "{{partner}} is choosing…", { partner: session.partnerName });
    this.screenSwitches++;
    this.screenReady = Promise.all([
      this.screenReady,
      globalScene.ui
        .setMode(
          UiMode.MODIFIER_SELECT,
          this.isPlayer(),
          this.typeOptions,
          this.sequencedCallback,
          this.getRerollCost(globalScene.lockModifierTiers),
          label,
          {
            trade: true,
            requested: session.tradeRequested,
            readOnly: !(this.picker === mySeat() || this.takingOver),
          } satisfies RewardScreenCoop,
        )
        .finally(() => this.screenSwitches--),
    ]);
  }

  private rewardHandler(): ModifierSelectUiHandler {
    return globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler;
  }

  /**
   * While the picker is slow (D17): a hint after 30 s, and after 90 s the offer to take over. The clock runs from the last
   * decision of the screen.
   */
  private watchPicker(): void {
    if (this.picker === mySeat() || this.takingOver) {
      return;
    }
    // A new step: the hint of the last one ("still choosing", "away") is over
    this.rewardHandler()?.setCoopLabel(
      coopText("pickerChoosing", "{{partner}} is choosing…", { partner: requireCoopSession().partnerName }),
    );
    this.watcher = new AfkWatcher({
      offerOver: [UiMode.MODIFIER_SELECT, UiMode.MESSAGE],
      showText: text => this.rewardHandler()?.setCoopLabel(text),
      onTakeOver: () => this.takeOver(),
    });
    this.watcher.start();
  }

  /** This player takes the picker's place for the rest of this screen: the pick, the skip, the reroll, the lock (D17) */
  private takeOver(): void {
    const session = requireCoopSession();
    this.takingOver = true;
    session.rewardTakeover = this.screen;
    this.rewardHandler()?.setCoopLabel(
      coopText("takingOver", "You are choosing for {{partner}}.", { partner: session.partnerName }),
    );
    this.rewardHandler()?.setCoopReadOnly(false);
  }

  /** The window of the open step, over and over until a decision closes the screen. */
  private async runWindow(): Promise<void> {
    const session = requireCoopSession();
    const sequencer = session.link!.sequencer;
    // What the legality check of a decision (D24) sees of this screen, while it is open
    session.rewardLegality = () => this.coopRewardView();
    while (!this.closed) {
      // While the partner is away, or a reload is due, the screen does not go on (D20, D13)
      await coopGate();
      const { waveIndex } = globalScene.currentBattle;
      const entries = rewardWindow(waveIndex, this.screen, session.rewardStep, this.picker);
      session.openWindow = [...session.openWindow, ...entries.map(entry => entry.key)];
      this.watchPicker();
      let decision: Awaited<ReturnType<typeof sequencer.awaitOneOf>>;
      try {
        decision = await sequencer.awaitOneOf(entries);
      } catch (error) {
        if (!this.closed) {
          reportBridgeError(error);
        }
        return;
      } finally {
        this.watcher?.stop();
        this.watcher = null;
        session.openWindow = session.openWindow.filter(open => !entries.some(entry => entry.key === open));
      }
      if (this.screenSwitches > 0) {
        // The pending flag holds the screen's input meanwhile, and the step still shows the decision as not taken
        await this.screenReady;
        if (this.closed) {
          return;
        }
      }
      session.rewardStep++;
      this.pending = false;
      if (this.editAfterStep) {
        // An edit of this player's that was too late for the step that just closed goes again now (D28)
        this.editAfterStep = false;
        this.sendPartyEdit();
      }
      if (decision.takeover === true && decision.author !== mySeat()) {
        // The partner chose for this player, who was away (D17)
        showTookOver();
      }
      if (decision.key.kind === "TRADE_REQUEST") {
        // Either player asked for a trade after this screen (D11): the screen stays as it is, the button says so
        session.tradeRequested = true;
        this.rewardHandler()?.setTradeRequested(true);
        continue;
      }
      if (decision.key.kind === "PARTY_EDIT") {
        // A player changed one of their own Pokémon (D28): both carry it out; the screen's options stay
        if (decision.author === mySeat()) {
          this.pendingEdit = null;
        }
        await applyPartyEdit(decision.payload as PartyEdit);
        continue;
      }
      if (!isRewardAction(decision.payload)) {
        reportBridgeError(new Error("co-op: an unreadable reward screen action"));
        return;
      }
      this.applyAction(decision.payload);
    }
  }

  /** Propose an action of this player in the open step. A refusal comes back through {@linkcode onRejected}. */
  private propose(action: RewardAction): void {
    const session = requireCoopSession();
    const key = rewardKey(globalScene.currentBattle.waveIndex, kindOfAction(action), this.screen, session.rewardStep);
    this.pending = true;
    // The picker's actions of a screen this player took over are proposed as a takeover (D17)
    const takeover =
      this.takingOver
      && this.picker !== mySeat()
      && (action.t === "pick" || action.t === "skip" || action.t === "reroll" || action.t === "lock");
    try {
      session.link!.sequencer.propose(key, action, takeover ? { takeover: true } : {});
    } catch (error) {
      if (error instanceof ProposalRejectedError) {
        this.onRejected(error.key, error.reason);
      } else {
        throw error;
      }
    }
  }

  /**
   * Propose a change of this player's own Pokémon from the party screen (D28). It does not hold the screen's input; if the
   * step moves on before it is sequenced, it is proposed again in the next one.
   */
  public proposePartyEdit(edit: PartyEdit): void {
    if (this.closed) {
      return;
    }
    this.pendingEdit = edit;
    this.editRetries = 0;
    this.sendPartyEdit();
  }

  private sendPartyEdit(): void {
    const session = requireCoopSession();
    if (this.pendingEdit === null || this.closed) {
      return;
    }
    try {
      session.link!.sequencer.propose(
        partyEditKey(globalScene.currentBattle.waveIndex, this.screen, session.rewardStep),
        this.pendingEdit,
      );
    } catch (error) {
      if (error instanceof ProposalRejectedError) {
        this.onRejected(error.key, error.reason);
      } else {
        throw error;
      }
    }
  }

  /** The host did not sequence a proposal of this player: the step moved on, or it was not theirs to make. */
  private onRejected(key: DecisionKey, reason: RejectReason): void {
    if (key.kind === "PARTY_EDIT") {
      // Another decision took the step first: the edit is still this player's to make, in the next one (once this client
      // has applied the decision that took it)
      if (
        !this.closed
        && this.pendingEdit !== null
        && (reason === "closed" || reason === "duplicate")
        && this.editRetries++ < 5
      ) {
        if (String(key.ref) === `${this.screen}:${requireCoopSession().rewardStep}`) {
          this.editAfterStep = true;
        } else {
          this.sendPartyEdit();
        }
      } else {
        this.pendingEdit = null;
      }
      return;
    }
    if (
      this.closed
      || !(isRewardKind(key.kind) || key.kind === "TRADE_REQUEST")
      || !String(key.ref).startsWith(`${this.screen}:`)
    ) {
      return;
    }
    this.pending = false;
    globalScene.ui.playError();
    this.resetSequenced();
    if (reason === "closed" || reason === "duplicate") {
      globalScene.ui.showText(coopText("rewardTooLate", "Too late: the screen has changed."), null, undefined, 1500);
    }
  }

  private deny(): boolean {
    globalScene.ui.playError();
    return false;
  }

  /** The player who is not picking pressed what only the picker may do: say who picks, and what this player can do (D9) */
  private denyNotPicker(): boolean {
    globalScene.ui.showText(
      coopText("notYourPick", "{{partner}} picks this time. You can still buy from the shop.", {
        partner: requireCoopSession().partnerName,
      }),
    );
    return this.deny();
  }

  /** What the player did on the screen: propose it, change nothing. Same return values as the solo callback. */
  private onSequencedInput(rowCursor: number, cursor: number): boolean {
    const { ui } = globalScene;
    const isPicker = this.picker === mySeat() || this.takingOver;
    if (this.closed) {
      return false;
    }
    if (rowCursor < 0 || cursor < 0) {
      // Cancel: the picker is asked whether to skip the reward; the screen stays as it was
      if (!isPicker || this.pending) {
        this.resetSequenced();
        return false;
      }
      ui.showText(i18next.t("battle:skipItemQuestion"), null, () => {
        ui.setOverlayMode(UiMode.CONFIRM, {
          yesHandler: () => {
            ui.revertMode();
            this.resetSequenced();
            this.propose({ t: "skip" });
          },
          noHandler: () => this.resetSequenced(),
        } satisfies ConfirmModeConfig);
      });
      return false;
    }
    if (this.pending) {
      return this.deny();
    }

    switch (rowCursor) {
      case 0:
        switch (cursor) {
          case 0: {
            const rerollCost = this.getRerollCost(globalScene.lockModifierTiers);
            if (!isPicker) {
              return this.denyNotPicker();
            }
            if (rerollCost < 0 || globalScene.money < rerollCost) {
              return this.deny();
            }
            this.propose({ t: "reroll" });
            return false;
          }
          case 1:
            return this.openSequencedTransfer();
          case 2:
            ui.setModeWithoutClear(UiMode.PARTY, PartyUiMode.CHECK, -1, () => this.resetSequenced());
            return true;
          case 3:
            if (!isPicker) {
              return this.denyNotPicker();
            }
            if (this.getRerollCost(globalScene.lockModifierTiers) < 0) {
              return this.deny();
            }
            this.propose({ t: "lock" });
            return false;
          case 4: {
            // The Trade button (D11): either player may ask, once
            const session = requireCoopSession();
            if (session.tradeRequested) {
              return this.deny();
            }
            this.pending = true;
            try {
              session.link!.sequencer.propose(
                tradeRequestKey(globalScene.currentBattle.waveIndex, this.screen, session.rewardStep),
                null,
              );
            } catch (error) {
              if (!(error instanceof ProposalRejectedError)) {
                throw error;
              }
              this.pending = false;
            }
            return false;
          }
          default:
            return false;
        }
      case 1: {
        if (!isPicker) {
          return this.denyNotPicker();
        }
        if (this.typeOptions.length === 0) {
          this.propose({ t: "skip" });
          return false;
        }
        return this.chooseTarget("pick", cursor, this.typeOptions[cursor].type);
      }
      default: {
        const shopOptions = getPlayerShopModifierTypeOptionsForWave(
          globalScene.currentBattle.waveIndex,
          globalScene.getWaveMoneyAmount(1),
        );
        const index =
          rowCursor > 2 || shopOptions.length <= SHOP_OPTIONS_ROW_LIMIT ? cursor : cursor + SHOP_OPTIONS_ROW_LIMIT;
        const cost = this.shopCost(shopOptions[index].cost);
        if (globalScene.money < cost && !activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
          return this.deny();
        }
        return this.chooseTarget("buy", index, shopOptions[index].type);
      }
    }
  }

  /** The price of a shop item, with Black Sludge applied */
  private shopCost(baseCost: number): number {
    const cost = new NumberHolder(baseCost);
    globalScene.applyModifier(HealShopCostModifier, true, cost);
    return cost.value;
  }

  /**
   * The player took an option of the rewards or the shop: an item that needs a Pokémon (or two, or a move) opens the
   * party screen first, and the answer is proposed with the Pokémon's id.
   * @returns Whether a screen was opened (the solo callback's meaning of `true`)
   */
  private chooseTarget(t: "pick" | "buy", index: number, modifierType: ModifierType): boolean {
    if (!(modifierType instanceof PokemonModifierType)) {
      this.propose({ t, index });
      return false;
    }
    const party = globalScene.getPlayerParty();
    if (modifierType instanceof FusePokemonModifierType) {
      globalScene.ui.setModeWithoutClear(
        UiMode.PARTY,
        PartyUiMode.SPLICE,
        -1,
        (fromSlotIndex: number, spliceSlotIndex: number) => {
          if (
            spliceSlotIndex !== undefined
            && fromSlotIndex < 6
            && spliceSlotIndex < 6
            && fromSlotIndex !== spliceSlotIndex
          ) {
            this.resetSequenced();
            this.propose({ t, index, target: party[fromSlotIndex].id, target2: party[spliceSlotIndex].id });
          } else {
            this.resetSequenced();
          }
        },
        modifierType.selectFilter,
      );
      return true;
    }
    const menu = this.getTargetMenu(modifierType);
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      menu.partyUiMode,
      -1,
      (slotIndex: number, option: PartyOption) => {
        if (slotIndex < 6) {
          const target: RewardTarget = { target: party[slotIndex].id };
          if (menu.isMove) {
            target.option = option - PartyOption.MOVE_1;
          } else if (menu.isRememberMove) {
            target.option = option as number;
          }
          this.resetSequenced();
          this.propose({ t, index, ...target });
        } else {
          this.resetSequenced();
        }
      },
      menu.selectFilter,
      menu.moveSelectFilter,
      menu.tmMoveId,
      menu.isPpRestore,
      menu.modifierItemId,
    );
    return true;
  }

  /**
   * Item transfer (D9): open to either player, but only from their own Pokémon (the party screen refuses the others). One
   * proposal carries every item of a transfer of "all".
   */
  private openSequencedTransfer(): boolean {
    const party = globalScene.getPlayerParty();
    let batch: { from: number; to: number; items: { index: number; quantity: number }[] } | null = null;
    globalScene.ui.setModeWithoutClear(
      UiMode.PARTY,
      PartyUiMode.MODIFIER_TRANSFER,
      -1,
      (fromSlotIndex: number, itemIndex: number, itemQuantity: number, toSlotIndex: number) => {
        if (
          toSlotIndex === undefined
          || fromSlotIndex >= 6
          || toSlotIndex >= 6
          || fromSlotIndex === toSlotIndex
          || itemIndex <= -1
        ) {
          this.resetSequenced();
          return;
        }
        if (batch === null) {
          batch = { from: party[fromSlotIndex].id, to: party[toSlotIndex].id, items: [] };
          // The party screen calls once per item of a transfer of "all": the proposal goes out when it is done
          queueMicrotask(() => {
            const action = batch;
            batch = null;
            this.resetSequenced();
            if (action !== null && !this.closed && !this.pending) {
              this.propose({ t: "transfer", ...action });
            }
          });
        }
        batch.items.push({ index: itemIndex, quantity: itemQuantity });
      },
      PartyUiHandler.FilterItemMaxStacks,
    );
    return true;
  }

  /** A decision of the screen, applied the same way on both clients. */
  private applyAction(action: RewardAction): void {
    switch (action.t) {
      case "skip":
        this.closeScreen();
        globalScene.ui.clearText();
        globalScene.ui.setMode(UiMode.MESSAGE);
        this.finishScreen();
        return;
      case "pick": {
        const option = this.typeOptions[action.index];
        const modifier = option && this.buildModifier(option.type, action);
        this.closeScreen();
        if (modifier) {
          this.applyModifier(modifier, -1, true);
        } else {
          globalScene.ui.clearText();
          globalScene.ui.setMode(UiMode.MESSAGE);
          this.finishScreen();
        }
        return;
      }
      case "buy": {
        const shopOptions = getPlayerShopModifierTypeOptionsForWave(
          globalScene.currentBattle.waveIndex,
          globalScene.getWaveMoneyAmount(1),
        );
        const option = shopOptions[action.index];
        const cost = option ? this.shopCost(option.cost) : 0;
        const modifier = option && this.buildModifier(option.type, action);
        if (modifier && (globalScene.money >= cost || activeOverrides.WAIVE_ROLL_FEE_OVERRIDE)) {
          this.applyModifier(modifier, cost, true);
        }
        return;
      }
      case "reroll": {
        const rerollCost = this.getRerollCost(globalScene.lockModifierTiers);
        if (rerollCost < 0 || globalScene.money < rerollCost) {
          return;
        }
        this.closeScreen();
        this.rerollModifiers();
        return;
      }
      case "lock":
        if (this.getRerollCost(globalScene.lockModifierTiers) >= 0) {
          this.toggleRerollLock();
        }
        return;
      case "transfer": {
        const from = globalScene.getPlayerParty().find(pokemon => pokemon.id === action.from);
        const to = globalScene.getPlayerParty().find(pokemon => pokemon.id === action.to);
        if (!from || !to) {
          return;
        }
        for (const { index, quantity } of action.items) {
          const itemModifiers = globalScene.findModifiers(
            m => m instanceof PokemonHeldItemModifier && m.isTransferable && m.pokemonId === from.id,
          ) as PokemonHeldItemModifier[];
          if (itemModifiers[index]) {
            globalScene.tryTransferHeldItemModifier(
              itemModifiers[index],
              to,
              true,
              quantity,
              undefined,
              undefined,
              false,
            );
          }
        }
      }
    }
  }

  /** The modifier a pick or a buy makes, for the Pokémon the decision names; `null` if there is none such */
  private buildModifier(modifierType: ModifierType, action: RewardTarget): Modifier | null {
    const party = globalScene.getPlayerParty();
    const pokemon = (id: number | undefined) => party.find(candidate => candidate.id === id);
    if (modifierType instanceof FusePokemonModifierType) {
      const first = pokemon(action.target);
      const second = pokemon(action.target2);
      return first && second ? modifierType.newModifier(first, second) : null;
    }
    if (modifierType instanceof PokemonModifierType) {
      const target = pokemon(action.target);
      if (!target) {
        return null;
      }
      return modifierType instanceof PokemonMoveModifierType || modifierType instanceof RememberMoveModifierType
        ? modifierType.newModifier(target, action.option ?? 0)
        : modifierType.newModifier(target);
    }
    return modifierType.newModifier();
  }

  /** What the legality check of a decision (D24) needs to know about this screen: what is on offer, what it costs, the money */
  private coopRewardView(): RewardView {
    const targetOf = (type: ModifierType): RewardOptionView["target"] => {
      if (type instanceof FusePokemonModifierType) {
        return "fuse";
      }
      if (type instanceof PokemonMoveModifierType || type instanceof RememberMoveModifierType) {
        return "move";
      }
      return type instanceof PokemonModifierType ? "pokemon" : "none";
    };
    const shop = getPlayerShopModifierTypeOptionsForWave(
      globalScene.currentBattle.waveIndex,
      globalScene.getWaveMoneyAmount(1),
    );
    return {
      options: this.typeOptions.map(option => ({ target: targetOf(option.type), cost: 0 })),
      shop: shop.map(option => ({ target: targetOf(option.type), cost: this.shopCost(option.cost) })),
      money: globalScene.money,
      rerollCost: this.getRerollCost(globalScene.lockModifierTiers),
      waived: !!activeOverrides.WAIVE_ROLL_FEE_OVERRIDE,
    };
  }

  /** The screen is over (a pick, a skip or a reroll): nothing is proposed or applied from now on. */
  private closeScreen(): void {
    this.closed = true;
    const handler = this.rewardHandler();
    if (globalScene.ui.mode !== UiMode.MODIFIER_SELECT && handler.active) {
      // The decision came while this player was in the party screen opened from this one (Check Team, a shop target, Manage
      // Items): leaving that screen will not close this one, so its items and buttons would stay drawn into the next battle
      handler.clear();
    }
    if (isLinked()) {
      requireCoopSession().rewardLegality = null;
    }
    this.pending = false;
    this.watcher?.stop();
    this.watcher = null;
    this.stopWatchingRejections?.();
    this.stopWatchingRejections = null;
    getCosmeticView()?.clearCursor();
  }

  /**
   * The pick or the skip is done: this phase ends. If either player asked for a trade, the trade phase is queued now, after
   * everything the pick queued (a learn-move, an evolution) and before the biome and the next battle (D11).
   */
  private finishScreen(): void {
    if (isLinked()) {
      const session = requireCoopSession();
      if (session.tradeRequested && !session.tradeQueued) {
        session.tradeQueued = true;
        globalScene.phaseManager.unshiftNew("CoopTradePhase");
      }
    }
    super.end();
  }

  // #endregion

  updateSeed(): void {
    globalScene.resetSeed();
  }

  isPlayer(): boolean {
    return true;
  }

  getRerollCost(lockRarities: boolean): number {
    let baseValue = 0;
    if (activeOverrides.WAIVE_ROLL_FEE_OVERRIDE) {
      return baseValue;
    }
    if (lockRarities) {
      const tierValues = [50, 125, 300, 750, 2000];
      for (const opt of this.typeOptions) {
        baseValue += tierValues[opt.type.tier ?? 0];
      }
    } else {
      baseValue = 250;
    }

    let multiplier = 1;
    if (this.customModifierSettings?.rerollMultiplier != null) {
      if (this.customModifierSettings.rerollMultiplier < 0) {
        // Completely overrides reroll cost to -1 and early exits
        return -1;
      }

      // Otherwise, continue with custom multiplier
      multiplier = this.customModifierSettings.rerollMultiplier;
    }

    const baseMultiplier = Math.min(
      Math.ceil(globalScene.currentBattle.waveIndex / 10) * baseValue * 2 ** this.rerollCount * multiplier,
      Number.MAX_SAFE_INTEGER,
    );

    // Apply Black Sludge to reroll cost
    const modifiedRerollCost = new NumberHolder(baseMultiplier);
    globalScene.applyModifier(HealShopCostModifier, true, modifiedRerollCost);
    return modifiedRerollCost.value;
  }

  getPoolType(): ModifierPoolType {
    return ModifierPoolType.PLAYER;
  }

  getModifierTypeOptions(modifierCount: number): ModifierTypeOption[] {
    return getPlayerModifierTypeOptions(
      modifierCount,
      globalScene.getPlayerParty(),
      globalScene.lockModifierTiers ? this.modifierTiers : undefined,
      this.customModifierSettings,
    );
  }

  copy(): SelectModifierPhase {
    return globalScene.phaseManager.create(
      "SelectModifierPhase",
      this.rerollCount,
      this.modifierTiers,
      {
        guaranteedModifierTypeOptions: this.typeOptions,
        rerollMultiplier: this.customModifierSettings?.rerollMultiplier,
        allowLuckUpgrades: false,
      },
      true,
    );
  }

  addModifier(modifier: Modifier): boolean {
    return globalScene.addModifier(modifier, false, true);
  }
}
