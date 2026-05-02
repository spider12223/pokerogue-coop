import { getGameMode } from "#app/game-mode";
import { globalScene } from "#app/global-scene";
import { CoopSession, type CoopState } from "#app/multiplayer/network/coop-session";
import Overrides from "#app/overrides";
import { Button } from "#enums/buttons";
import { GameModes } from "#enums/game-modes";
import { TextStyle } from "#enums/text-style";
import { UiMode } from "#enums/ui-mode";
import type { TitlePhase } from "#phases/title-phase";
import { addTextObject, getTextColor } from "#ui/text";
import type { TitleUiHandler } from "#ui/title-ui-handler";
import { UiHandler } from "#ui/ui-handler";
import { addWindow } from "#ui/ui-theme";
import { randomString } from "#utils/common";
import type Phaser from "phaser";

export class CoopLobbyUiHandler extends UiHandler {
  private container: Phaser.GameObjects.Container;
  private backdrop: Phaser.GameObjects.Rectangle;
  private bg: Phaser.GameObjects.NineSlice;
  private titleText: Phaser.GameObjects.Text;
  private statusText: Phaser.GameObjects.Text;
  private codeText: Phaser.GameObjects.Text;
  private hintText: Phaser.GameObjects.Text;
  private stateChangeListener: ((state: CoopState) => void) | null = null;

  constructor() {
    super(UiMode.COOP_LOBBY);
  }

  override setup(): void {
    const ui = this.getUi();
    const scaledWidth = globalScene.scaledCanvas.width;
    const scaledHeight = globalScene.scaledCanvas.height;
    const width = 240;
    const height = 96;
    const panelX = (scaledWidth - width) / 2;
    const panelTopY = -(scaledHeight - height) / 2 - height;

    this.container = globalScene.add.container(0, 0).setName("coop-lobby");
    this.container.setVisible(false);
    ui.add(this.container);

    this.backdrop = globalScene.add
      .rectangle(0, 0, scaledWidth, -scaledHeight, 0x000000, 0.85)
      .setOrigin(0, 0)
      .setName("coop-lobby-backdrop");
    this.container.add(this.backdrop);

    this.bg = addWindow(panelX, panelTopY, width, height);
    this.container.add(this.bg);

    this.titleText = addTextObject(panelX + width / 2, panelTopY + 8, "Co-op Lobby", TextStyle.WINDOW)
      .setOrigin(0.5, 0)
      .setColor(getTextColor(TextStyle.WINDOW));
    this.container.add(this.titleText);

    this.statusText = addTextObject(panelX + width / 2, panelTopY + 28, "", TextStyle.WINDOW).setOrigin(0.5, 0);
    this.container.add(this.statusText);

    this.codeText = addTextObject(panelX + width / 2, panelTopY + 44, "", TextStyle.MONEY, {
      fontSize: "96px",
    }).setOrigin(0.5, 0);
    this.container.add(this.codeText);

    this.hintText = addTextObject(panelX + width / 2, panelTopY + height - 14, "", TextStyle.WINDOW, {
      fontSize: "48px",
    }).setOrigin(0.5, 0);
    this.container.add(this.hintText);
  }

  override show(args: any[]): boolean {
    super.show(args);
    const ui = this.getUi();
    ui.bringToTop(this.container);
    this.container.setVisible(true);
    this.render(globalScene.coopSession.getState());
    this.stateChangeListener = (state: CoopState) => this.render(state);
    globalScene.coopSession.on(CoopSession.STATE_CHANGE, this.stateChangeListener);
    return true;
  }

  override processInput(button: Button): boolean {
    const state = globalScene.coopSession.getState();
    if (state.kind === "ERROR") {
      if (button === Button.ACTION && state.recoverable) {
        void globalScene.coopSession.retry();
        return true;
      }
      if (button === Button.CANCEL) {
        globalScene.coopSession.dismiss();
        this.exitToTitle();
        return true;
      }
      return false;
    }
    if (button === Button.ACTION && state.kind === "CONNECTED" && state.role === "host") {
      void this.startCoopRun();
      return true;
    }
    if (button === Button.CANCEL) {
      switch (state.kind) {
        case "HOSTING":
        case "JOINING":
          void globalScene.coopSession.cancel().then(() => this.exitToTitle());
          return true;
        case "CONNECTED":
          void globalScene.coopSession.disconnect().then(() => this.exitToTitle());
          return true;
        case "IDLE":
          this.exitToTitle();
          return true;
      }
    }
    return false;
  }

  private async startCoopRun(): Promise<void> {
    const seed = Overrides.SEED_OVERRIDE || randomString(24);
    globalScene.coopMode = "host";
    await globalScene.coopSession.sendEnvelope({
      type: "start-run",
      seed,
      startingWave: 1,
    });
    globalScene.gameMode = getGameMode(GameModes.CLASSIC);
    globalScene.setSeed(seed);
    globalScene.resetSeed();
    (globalScene.ui.handlers[UiMode.TITLE] as TitleUiHandler).clear();
    const phase = globalScene.phaseManager.getCurrentPhase();
    if (phase.is("TitlePhase")) {
      const titlePhase = phase as TitlePhase;
      titlePhase.gameMode = GameModes.CLASSIC;
      void globalScene.ui.setMode(UiMode.MESSAGE).then(() => {
        globalScene.ui.clearText();
        titlePhase.end();
      });
    }
  }

  override clear(): void {
    super.clear();
    if (this.stateChangeListener) {
      globalScene.coopSession.off(CoopSession.STATE_CHANGE, this.stateChangeListener);
      this.stateChangeListener = null;
    }
    this.container.setVisible(false);
  }

  private render(state: CoopState): void {
    switch (state.kind) {
      case "IDLE":
        this.statusText.setText("Idle");
        this.codeText.setText("");
        this.hintText.setText("CANCEL: back to title");
        break;
      case "HOSTING":
        this.statusText.setText("Waiting for joiner...");
        this.codeText.setText(state.code);
        this.hintText.setText("CANCEL: stop hosting");
        break;
      case "JOINING":
        this.statusText.setText("Connecting to host...");
        this.codeText.setText(state.code);
        this.hintText.setText("CANCEL: abort");
        break;
      case "CONNECTED":
        this.statusText.setText(`Connected (${state.role})`);
        this.codeText.setText(state.code);
        if (state.role === "host") {
          this.hintText.setText("ACTION: start run / CANCEL: disconnect");
        } else {
          this.hintText.setText("Waiting for host... / CANCEL: disconnect");
        }
        break;
      case "ERROR":
        this.statusText.setText("Error");
        this.codeText.setText(state.reason);
        this.hintText.setText(state.recoverable ? "ACTION: retry / CANCEL: back" : "CANCEL: back");
        break;
    }
  }

  private exitToTitle(): void {
    globalScene.phaseManager.toTitleScreen();
    globalScene.phaseManager.shiftPhase();
  }
}
