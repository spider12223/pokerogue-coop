import { globalScene } from "#app/global-scene";
import { CoopCommandPanelLogic } from "#app/multiplayer/coop-command-panel-logic";
import { CoopSession } from "#app/multiplayer/network/coop-session";
import type {
  CancelCommandRequestMessage,
  ChooseCommandMessage,
  RequestCommandMessage,
} from "#app/multiplayer/network/messages";
import type { BattleSnapshot } from "#app/multiplayer/network/snapshot";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import { UiMode } from "#enums/ui-mode";
import { addTextObject } from "#ui/text";
import { UiHandler } from "#ui/ui-handler";
import { addWindow } from "#ui/ui-theme";
import type Phaser from "phaser";

export class CoopCommandPanelUiHandler extends UiHandler {
  private container: Phaser.GameObjects.Container;
  private backdrop: Phaser.GameObjects.Rectangle;
  private bg: Phaser.GameObjects.NineSlice;
  private titleText: Phaser.GameObjects.Text;
  private selfText: Phaser.GameObjects.Text;
  private foesText: Phaser.GameObjects.Text;
  private allyText: Phaser.GameObjects.Text;
  private optionsText: Phaser.GameObjects.Text;
  private logText: Phaser.GameObjects.Text;
  private hintText: Phaser.GameObjects.Text;

  private logic: CoopCommandPanelLogic | null = null;
  private cursor = 0;
  private snapshotListener: ((snapshot: BattleSnapshot, turn: number) => void) | null = null;
  private requestListener: ((envelope: RequestCommandMessage) => void) | null = null;
  private cancelListener: ((envelope: CancelCommandRequestMessage) => void) | null = null;

  constructor() {
    super(UiMode.COOP_COMMAND_PANEL);
  }

  override setup(): void {
    const ui = this.getUi();
    const scaledWidth = globalScene.scaledCanvas.width;
    const scaledHeight = globalScene.scaledCanvas.height;
    const width = Math.min(scaledWidth - 20, 280);
    const height = Math.min(scaledHeight - 20, 200);
    const panelX = (scaledWidth - width) / 2;
    const panelTopY = -(scaledHeight - height) / 2 - height;

    this.container = globalScene.add.container(0, 0).setName("coop-command-panel");
    this.container.setVisible(false);
    ui.add(this.container);

    this.backdrop = globalScene.add
      .rectangle(0, 0, scaledWidth, -scaledHeight, 0x000000, 0.85)
      .setOrigin(0, 0)
      .setName("coop-command-panel-backdrop");
    this.container.add(this.backdrop);

    this.bg = addWindow(panelX, panelTopY, width, height);
    this.container.add(this.bg);

    this.titleText = addTextObject(panelX + width / 2, panelTopY + 4, "Co-op — your turn", TextStyle.WINDOW).setOrigin(
      0.5,
      0,
    );
    this.container.add(this.titleText);

    this.foesText = addTextObject(panelX + 6, panelTopY + 18, "", TextStyle.WINDOW, { fontSize: "48px" }).setOrigin(
      0,
      0,
    );
    this.container.add(this.foesText);

    this.selfText = addTextObject(panelX + 6, panelTopY + 50, "", TextStyle.WINDOW, { fontSize: "48px" }).setOrigin(
      0,
      0,
    );
    this.container.add(this.selfText);

    this.optionsText = addTextObject(panelX + 6, panelTopY + 82, "", TextStyle.WINDOW, { fontSize: "48px" }).setOrigin(
      0,
      0,
    );
    this.container.add(this.optionsText);

    this.allyText = addTextObject(panelX + 6, panelTopY + height - 50, "", TextStyle.WINDOW, {
      fontSize: "48px",
    }).setOrigin(0, 0);
    this.container.add(this.allyText);

    this.logText = addTextObject(panelX + 6, panelTopY + height - 38, "", TextStyle.WINDOW, {
      fontSize: "48px",
    }).setOrigin(0, 0);
    this.container.add(this.logText);

    this.hintText = addTextObject(panelX + width / 2, panelTopY + height - 10, "", TextStyle.WINDOW, {
      fontSize: "48px",
    }).setOrigin(0.5, 0);
    this.container.add(this.hintText);
  }

  override show(args: any[]): boolean {
    super.show(args);
    const ui = this.getUi();
    ui.bringToTop(this.container);
    this.container.setVisible(true);

    this.logic = new CoopCommandPanelLogic({
      sendChooseCommand: (command, requestId) => this.sendChooseCommand(command, requestId),
    });

    const stored = globalScene.coopSession.getSnapshotStore().getCurrent();
    if (stored) {
      this.logic.onSnapshotUpdate(stored.snapshot);
    }

    this.snapshotListener = (snapshot: BattleSnapshot, _turn: number) => {
      this.logic?.onSnapshotUpdate(snapshot);
      this.render();
    };
    this.requestListener = (envelope: RequestCommandMessage) => {
      this.logic?.onRequestCommand(envelope);
      this.cursor = 0;
      this.render();
    };
    this.cancelListener = (envelope: CancelCommandRequestMessage) => {
      this.logic?.onCancelRequest(envelope);
      this.cursor = 0;
      this.render();
    };
    globalScene.coopSession.on(CoopSession.SNAPSHOT_UPDATE, this.snapshotListener);
    globalScene.coopSession.on(CoopSession.REQUEST_COMMAND_RECEIVED, this.requestListener);
    globalScene.coopSession.on(CoopSession.CANCEL_COMMAND_REQUEST_RECEIVED, this.cancelListener);

    this.cursor = 0;
    this.render();
    return true;
  }

  override processInput(button: Button): boolean {
    if (!this.logic) {
      return false;
    }
    const state = this.logic.getState();
    if (state.kind !== "request-active") {
      return false;
    }
    if (state.substate === "move-select") {
      return this.handleMoveSelectInput(button);
    }
    return this.handleTargetSelectInput(button);
  }

  override clear(): void {
    super.clear();
    if (this.snapshotListener) {
      globalScene.coopSession.off(CoopSession.SNAPSHOT_UPDATE, this.snapshotListener);
      this.snapshotListener = null;
    }
    if (this.requestListener) {
      globalScene.coopSession.off(CoopSession.REQUEST_COMMAND_RECEIVED, this.requestListener);
      this.requestListener = null;
    }
    if (this.cancelListener) {
      globalScene.coopSession.off(CoopSession.CANCEL_COMMAND_REQUEST_RECEIVED, this.cancelListener);
      this.cancelListener = null;
    }
    this.logic = null;
    this.container.setVisible(false);
  }

  private handleMoveSelectInput(button: Button): boolean {
    const moveCount = this.snapshotMoveCount();
    const optionCount = moveCount + 1; // +1 for RUN
    if (button === Button.UP) {
      this.cursor = (this.cursor - 1 + optionCount) % optionCount;
      this.render();
      return true;
    }
    if (button === Button.DOWN) {
      this.cursor = (this.cursor + 1) % optionCount;
      this.render();
      return true;
    }
    if (button === Button.ACTION) {
      if (this.cursor < moveCount) {
        this.logic?.onMoveSelected(this.cursor);
      } else {
        this.logic?.onRunSelected();
      }
      this.cursor = 0;
      this.render();
      return true;
    }
    return false;
  }

  private handleTargetSelectInput(button: Button): boolean {
    const targets = this.targetOptions();
    const optionCount = targets.length + 1; // +1 for back
    if (optionCount <= 1) {
      if (button === Button.CANCEL) {
        this.logic?.onTargetBack();
        this.cursor = 0;
        this.render();
        return true;
      }
      return false;
    }
    if (button === Button.UP) {
      this.cursor = (this.cursor - 1 + optionCount) % optionCount;
      this.render();
      return true;
    }
    if (button === Button.DOWN) {
      this.cursor = (this.cursor + 1) % optionCount;
      this.render();
      return true;
    }
    if (button === Button.ACTION) {
      if (this.cursor < targets.length) {
        this.logic?.onTargetSelected(targets[this.cursor].battlerIndex);
      } else {
        this.logic?.onTargetBack();
      }
      this.cursor = 0;
      this.render();
      return true;
    }
    if (button === Button.CANCEL) {
      this.logic?.onTargetBack();
      this.cursor = 0;
      this.render();
      return true;
    }
    return false;
  }

  private sendChooseCommand(command: ChooseCommandMessage["command"], requestId: string): void {
    void globalScene.coopSession.sendEnvelope({
      type: "choose-command",
      requestId,
      command,
    });
  }

  private snapshotMoveCount(): number {
    return this.logic?.getSnapshot()?.field.slot1?.moves.length ?? 0;
  }

  private targetOptions(): { battlerIndex: number; label: string }[] {
    const snapshot = this.logic?.getSnapshot();
    if (!snapshot) {
      return [];
    }
    const out: { battlerIndex: number; label: string }[] = [];
    if (snapshot.field.foe0 && snapshot.field.foe0.hp > 0) {
      out.push({ battlerIndex: 2, label: snapshot.field.foe0.name });
    }
    if (snapshot.field.foe1 && snapshot.field.foe1.hp > 0) {
      out.push({ battlerIndex: 3, label: snapshot.field.foe1.name });
    }
    return out;
  }

  private render(): void {
    if (!this.logic) {
      return;
    }
    const state = this.logic.getState();
    const snapshot = this.logic.getSnapshot();

    this.foesText.setText(this.renderFoesLine(snapshot));
    this.selfText.setText(this.renderSelfLine(snapshot));
    this.allyText.setText(this.renderAllyLine(snapshot));
    this.logText.setText(this.renderLogLines(snapshot));

    if (state.kind === "idle") {
      this.titleText.setText("Co-op — waiting for host");
      this.optionsText.setText("");
      this.hintText.setText("");
      return;
    }
    if (state.kind === "submitted") {
      this.titleText.setText("Co-op — waiting for next turn");
      this.optionsText.setText("");
      this.hintText.setText("");
      return;
    }
    this.titleText.setText("Co-op — your turn");
    if (state.substate === "move-select") {
      this.optionsText.setText(this.renderMoveSelect(snapshot));
      this.hintText.setText("UP/DOWN: select   ACTION: confirm");
      return;
    }
    this.optionsText.setText(this.renderTargetSelect());
    this.hintText.setText("UP/DOWN: select   ACTION: confirm   CANCEL: back");
  }

  private renderFoesLine(snapshot: BattleSnapshot | null): string {
    if (!snapshot) {
      return "";
    }
    const foe0 = snapshot.field.foe0;
    const foe1 = snapshot.field.foe1;
    const parts: string[] = [];
    if (foe0) {
      parts.push(`Foe1 ${foe0.name} L${foe0.level} HP ${foe0.hp}/${foe0.maxHp}`);
    }
    if (foe1) {
      parts.push(`Foe2 ${foe1.name} L${foe1.level} HP ${foe1.hp}/${foe1.maxHp}`);
    }
    return parts.join("    ");
  }

  private renderSelfLine(snapshot: BattleSnapshot | null): string {
    const self = snapshot?.field.slot1;
    if (!self) {
      return "";
    }
    return `You: ${self.name} L${self.level} HP ${self.hp}/${self.maxHp}`;
  }

  private renderAllyLine(snapshot: BattleSnapshot | null): string {
    const ally = snapshot?.field.slot0;
    if (!ally) {
      return "";
    }
    return `Ally: ${ally.name} L${ally.level} HP ${ally.hp}/${ally.maxHp}`;
  }

  private renderLogLines(snapshot: BattleSnapshot | null): string {
    if (!snapshot || snapshot.recentLog.length === 0) {
      return "";
    }
    return snapshot.recentLog.slice(-3).join("\n");
  }

  private renderMoveSelect(snapshot: BattleSnapshot | null): string {
    const moves = snapshot?.field.slot1?.moves ?? [];
    const lines: string[] = [];
    for (let i = 0; i < moves.length; i++) {
      const prefix = this.cursor === i ? "> " : "  ";
      lines.push(`${prefix}${moves[i].name}  ${moves[i].ppRemaining}/${moves[i].ppMax}`);
    }
    const runPrefix = this.cursor === moves.length ? "> " : "  ";
    lines.push(`${runPrefix}RUN`);
    return lines.join("\n");
  }

  private renderTargetSelect(): string {
    const targets = this.targetOptions();
    const lines: string[] = ["Select target:"];
    for (let i = 0; i < targets.length; i++) {
      const prefix = this.cursor === i ? "> " : "  ";
      lines.push(`${prefix}${targets[i].label}`);
    }
    const backPrefix = this.cursor === targets.length ? "> " : "  ";
    lines.push(`${backPrefix}back`);
    return lines.join("\n");
  }
}
