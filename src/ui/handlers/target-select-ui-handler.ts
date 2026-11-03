import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { sendIntent } from "#coop/cosmetic-view";
import { teammateTarget } from "#coop/teammate-hit";
import { coopText } from "#coop/text";
import { SubstituteTag } from "#data/battler-tags";
import { allMoves } from "#data/data-lists";
import { BattlerIndex, isPlayerBattler } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import type { MoveId } from "#enums/move-id";
import { UiMode } from "#enums/ui-mode";
import type { Pokemon } from "#field/pokemon";
import type { ModifierBar } from "#modifiers/modifier";
import { getMoveTargets } from "#moves/move-utils";
import type { TargetSelectCallback } from "#types/ui-types";
import { UiHandler } from "#ui/ui-handler";
import { fixedInt } from "#utils/common";

export class TargetSelectUiHandler extends UiHandler {
  private fieldIndex: number;
  private move: MoveId;
  private targetSelectCallback: TargetSelectCallback;
  private cursor0: number; // associated with BattlerIndex.PLAYER
  private cursor1: number; // associated with BattlerIndex.PLAYER_2
  private cursor2: number; // associated with BattlerIndex.PLAYER_3 (co-op, D40)

  private isMultipleTargets = false;
  /** Co-op (D8, amended): the player is asked whether to hit a teammate's Pokémon */
  private asking = false;
  private targets: BattlerIndex[];
  private targetsHighlighted: Pokemon[];
  private targetFlashTween: Phaser.Tweens.Tween | null;
  private enemyModifiers: ModifierBar;
  private targetBattleInfoMoveTween: Phaser.Tweens.Tween[] = [];

  constructor() {
    super();

    this.cursor = -1;
  }

  setup(): void {}

  show(
    args: [fieldIndex: number, moveId: MoveId, callback: TargetSelectCallback, defaultTargets?: BattlerIndex[]],
  ): boolean {
    if (args.length < 3) {
      return false;
    }

    super.show(args);

    [this.fieldIndex, this.move, this.targetSelectCallback] = args;
    const user = globalScene.getPlayerField()[this.fieldIndex];

    const moveTargets = getMoveTargets(user, this.move);
    this.targets = moveTargets.targets;
    this.isMultipleTargets = moveTargets.multiple;

    if (this.targets.length === 0) {
      return false;
    }

    this.enemyModifiers = globalScene.getModifierBar(true);

    // If default targets are specified, use them instead
    // TODO: This logic should emphatically _not_ be done inside a UI handler
    const defaultTargets = args[3];
    if (defaultTargets && defaultTargets.length > 0 && this.targets.includes(defaultTargets[0])) {
      this.setCursor(defaultTargets[0]);
      return true;
    }

    if (this.fieldIndex === BattlerIndex.PLAYER) {
      this.resetCursor(this.cursor0, user);
    } else if (this.fieldIndex === BattlerIndex.PLAYER_2) {
      this.resetCursor(this.cursor1, user);
    } else if (this.fieldIndex === 2) {
      // Co-op (D40): the third slot of ours in a battle of three
      this.resetCursor(this.cursor2, user);
    }
    return true;
  }

  /**
   * Determines what value to assign the main cursor based on the previous turn's target or the user's status
   * @param cursorN the cursor associated with the user's field index
   * @param user the Pokemon using the move
   */
  resetCursor(cursorN: number, user: Pokemon): void {
    if (cursorN != null && (isPlayerBattler(cursorN) || user.summonData.waveTurnCount === 1)) {
      // Reset cursor on the first turn of a fight or if an ally was targeted last turn
      cursorN = -1;
    }
    this.setCursor(this.targets.includes(cursorN) ? cursorN : this.targets[0]);
  }

  /**
   * Co-op (D8, amended): a move that could hit an enemy is aimed at a teammate's Pokémon: the player is asked first
   * @returns Whether the question is open (the press is not a choice yet)
   */
  private askTeammateHit(): boolean {
    const hit = this.isMultipleTargets ? null : teammateTarget(this.fieldIndex, this.cursor, this.targets);
    if (hit === null) {
      return false;
    }
    const ui = this.getUi();
    this.asking = true;
    const done = (hitIt: boolean): void => {
      ui.revertMode().then(() => {
        this.asking = false;
        ui.clearText();
        if (hitIt) {
          this.choose(Button.ACTION);
        }
      });
    };
    ui.showText(
      coopText("hitTeammate", "Use {{move}} on {{owner}}'s {{pokemon}}?", {
        move: allMoves[this.move].name,
        owner: hit.owner,
        pokemon: getPokemonNameWithAffix(hit.pokemon, false),
      }),
      null,
      () => ui.setOverlayMode(UiMode.CONFIRM, { yesHandler: () => done(true), noHandler: () => done(false) }),
    );
    return true;
  }

  /** The player chose the target (`ACTION`) or went back (`CANCEL`) */
  private choose(button: Button.ACTION | Button.CANCEL): void {
    const targetIndexes: BattlerIndex[] = this.isMultipleTargets ? this.targets : [this.cursor];
    this.targetSelectCallback(button === Button.ACTION ? targetIndexes : []);
    if (this.fieldIndex === BattlerIndex.PLAYER) {
      if (this.cursor0 == null || this.cursor0 !== this.cursor) {
        this.cursor0 = this.cursor;
      }
    } else if (this.fieldIndex === BattlerIndex.PLAYER_2 && (this.cursor1 == null || this.cursor1 !== this.cursor)) {
      this.cursor1 = this.cursor;
    } else if (this.fieldIndex === 2) {
      this.cursor2 = this.cursor;
    }
  }

  processInput(button: Button): boolean {
    const ui = this.getUi();

    let success = false;

    if (this.asking) {
      // (the question about a teammate's Pokémon is on screen: its own menu takes the keys)
      return false;
    }
    if (button === Button.ACTION && this.askTeammateHit()) {
      success = true;
    } else if (button === Button.ACTION || button === Button.CANCEL) {
      this.choose(button);
      success = true;
    } else if (this.isMultipleTargets) {
      success = false;
    } else if (globalScene.currentBattle.playerSlots === 3) {
      success = this.moveCursorOfThree(button);
    } else {
      switch (button) {
        case Button.UP:
          if (this.cursor < BattlerIndex.ENEMY && this.targets.findIndex(t => t >= BattlerIndex.ENEMY) > -1) {
            success = this.setCursor(this.targets.find(t => t >= BattlerIndex.ENEMY)!); // TODO: is the bang correct here?
          }
          break;
        case Button.DOWN:
          if (this.cursor >= BattlerIndex.ENEMY && this.targets.findIndex(t => t < BattlerIndex.ENEMY) > -1) {
            success = this.setCursor(this.targets.find(t => t < BattlerIndex.ENEMY)!); // TODO: is the bang correct here?
          }
          break;
        case Button.LEFT:
          if (this.cursor % 2 && this.targets.findIndex(t => t === this.cursor - 1) > -1) {
            success = this.setCursor(this.cursor - 1);
          }
          break;
        case Button.RIGHT:
          if (!(this.cursor % 2) && this.targets.findIndex(t => t === this.cursor + 1) > -1) {
            success = this.setCursor(this.cursor + 1);
          }
          break;
      }
    }

    if (success) {
      ui.playSelect();
    }

    return success;
  }

  /**
   * Co-op (D40): the cursor of a battle of three of ours. The enemies are one row, ours the other, each in the order they
   * stand on screen: up and down change rows, left and right move along one
   */
  private moveCursorOfThree(button: Button): boolean {
    const rows: BattlerIndex[][] = [
      [BattlerIndex.ENEMY, BattlerIndex.ENEMY_2],
      [BattlerIndex.PLAYER, BattlerIndex.PLAYER_2, BattlerIndex.PLAYER_3],
    ];
    const ours = isPlayerBattler(this.cursor);
    const row = rows[ours ? 1 : 0].filter(target => this.targets.includes(target));
    const other = rows[ours ? 0 : 1].filter(target => this.targets.includes(target));
    const at = row.indexOf(this.cursor);
    switch (button) {
      case Button.UP:
        return ours && other.length > 0 && this.setCursor(other[0]);
      case Button.DOWN:
        return !ours && other.length > 0 && this.setCursor(other[0]);
      case Button.LEFT:
        return at > 0 && this.setCursor(row[at - 1]);
      case Button.RIGHT:
        return at >= 0 && at < row.length - 1 && this.setCursor(row[at + 1]);
      default:
        return false;
    }
  }

  setCursor(cursor: number): boolean {
    const singleTarget = globalScene.getField()[cursor];
    const multipleTargets = this.targets.map(index => globalScene.getField()[index]);

    this.targetsHighlighted = this.isMultipleTargets ? multipleTargets : [singleTarget];

    const ret = super.setCursor(cursor);

    // Co-op (D16): the partner sees the move and the target this player is looking at
    const user = globalScene.getPlayerField()[this.fieldIndex];
    if (user !== undefined) {
      sendIntent(user.id, this.move, cursor);
    }

    if (this.targetFlashTween) {
      this.targetFlashTween.stop();
      for (const pokemon of multipleTargets) {
        pokemon.setAlpha(pokemon.getTag(SubstituteTag) ? 0.5 : 1);
        this.highlightItems(pokemon.id, 1);
      }
    }

    this.targetFlashTween = globalScene.tweens.add({
      targets: this.targetsHighlighted,
      key: { start: 1, to: 0.25 },
      loop: -1,
      loopDelay: 150,
      duration: fixedInt(450),
      ease: "Sine.easeInOut",
      yoyo: true,
      onUpdate: t => {
        for (const target of this.targetsHighlighted) {
          target.setAlpha(t.getValue() ?? 1);
          this.highlightItems(target.id, t.getValue() ?? 1);
        }
      },
    });

    if (this.targetBattleInfoMoveTween.length > 0) {
      this.targetBattleInfoMoveTween.filter(t => t !== undefined).forEach(tween => tween.stop());
      for (const pokemon of multipleTargets) {
        pokemon.getBattleInfo().resetY();
      }
    }

    const targetsBattleInfo = this.targetsHighlighted.map(target => target.getBattleInfo());

    targetsBattleInfo.map(info => {
      this.targetBattleInfoMoveTween.push(
        globalScene.tweens.add({
          targets: [info],
          y: { start: info.getBaseY(), to: info.getBaseY() + 1 },
          loop: -1,
          duration: fixedInt(250),
          ease: "Linear",
          yoyo: true,
        }),
      );
    });
    return ret;
  }

  eraseCursor() {
    if (this.targetFlashTween) {
      this.targetFlashTween.stop();
      this.targetFlashTween = null;
    }

    for (const pokemon of this.targetsHighlighted) {
      pokemon.setAlpha(pokemon.getTag(SubstituteTag) ? 0.5 : 1);
      this.highlightItems(pokemon.id, 1);
    }

    if (this.targetBattleInfoMoveTween.length > 0) {
      this.targetBattleInfoMoveTween.filter(t => t !== undefined).forEach(tween => tween.stop());
      this.targetBattleInfoMoveTween = [];
    }
    for (const pokemon of this.targetsHighlighted) {
      pokemon.getBattleInfo().resetY();
    }
  }

  private highlightItems(targetId: number, val: number): void {
    const targetItems = this.enemyModifiers.getAll("name", targetId.toString());
    for (const item of targetItems as Phaser.GameObjects.Container[]) {
      item.setAlpha(val);
    }
  }

  clear() {
    super.clear();
    this.eraseCursor();
  }
}
