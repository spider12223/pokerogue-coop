import type { BattleScene } from "#app/battle-scene";
import type { InputsController } from "#app/inputs-controller";
import type { PlayerSlot } from "#app/multiplayer/input-role";
import { TouchControl } from "#app/touch-controls";
import { PAD_XBOX360 } from "#inputs/pad-xbox360";
import { holdOn } from "#test/utils/game-manager-utils";
import fs from "node:fs";
import { JSDOM } from "jsdom";
import Phaser from "phaser";

interface LogEntry {
  type: string;
  button: any;
}

export class InputsHandler {
  private scene: BattleScene;
  private events: Phaser.Events.EventEmitter;
  private inputController: InputsController;
  public log: LogEntry[] = [];
  public logUp: LogEntry[] = [];
  private fakePad: Fakepad;
  private fakeMobile: FakeMobile | null = null;
  private readonly onDownListener: (event: any) => void;
  private readonly onUpListener: (event: any) => void;

  constructor(scene: BattleScene) {
    this.scene = scene;
    this.inputController = this.scene.inputController;
    this.fakePad = new Fakepad(PAD_XBOX360);
    this.scene.input.gamepad?.gamepads.push(this.fakePad);
    this.onDownListener = event => {
      this.log.push({ type: "input_down", button: event.button });
    };
    this.onUpListener = event => {
      this.logUp.push({ type: "input_up", button: event.button });
    };
    this.init();
  }

  destroy(): void {
    this.events?.off("input_down", this.onDownListener);
    this.events?.off("input_up", this.onUpListener);
    const gamepads = this.scene.input.gamepad?.gamepads;
    if (gamepads) {
      const idx = gamepads.indexOf(this.fakePad);
      if (idx >= 0) {
        gamepads.splice(idx, 1);
      }
    }
    this.fakeMobile?.destroy();
    this.fakeMobile = null;
  }

  private getFakeMobile(): FakeMobile {
    if (!this.fakeMobile) {
      this.fakeMobile = new FakeMobile();
      new TouchControl();
    }
    return this.fakeMobile;
  }

  pressTouch(button: string, duration: number): Promise<void> {
    return new Promise(async resolve => {
      const mobile = this.getFakeMobile();
      mobile.touchDown(button);
      await holdOn(duration);
      mobile.touchUp(button);
      resolve();
    });
  }

  pressGamepadButton(button: number, duration: number): Promise<void> {
    return new Promise(async resolve => {
      this.scene.input.gamepad?.emit("down", this.fakePad, { index: button });
      await holdOn(duration);
      this.scene.input.gamepad?.emit("up", this.fakePad, { index: button });
      resolve();
    });
  }

  pressKeyboardKeyForSlot(slot: PlayerSlot, key: number, duration: number): Promise<void> {
    return new Promise(async resolve => {
      const otherIds = this.inputController
        .getAllSources()
        .filter(s => s.kind === "keyboard" && s.playerSlot !== slot)
        .map(s => s.id);
      for (const id of otherIds) {
        this.inputController.setSourceEnabled(id, false);
      }
      this.scene.input.keyboard?.emit("keydown", { keyCode: key });
      await holdOn(duration);
      this.scene.input.keyboard?.emit("keyup", { keyCode: key });
      for (const id of otherIds) {
        this.inputController.setSourceEnabled(id, true);
      }
      resolve();
    });
  }

  init(): void {
    const touchControl = new TouchControl();
    touchControl.deactivatePressedKey(); //test purpose
    this.events = this.inputController.events;
    this.scene.input.gamepad?.emit("connected", this.fakePad);
    this.listenInputs();
  }

  listenInputs(): void {
    this.events.on("input_down", this.onDownListener);
    this.events.on("input_up", this.onUpListener);
  }
}

class Fakepad extends Phaser.Input.Gamepad.Gamepad {
  public id: string;
  public index: number;

  constructor(pad) {
    //@ts-expect-error
    super(undefined, { ...pad, buttons: pad.deviceMapping, axes: [] }); //TODO: resolve ts-ignore
    this.id = "xbox_360_fakepad";
    this.index = 0;
  }
}

class FakeMobile {
  private readonly originalDocument: Document;

  constructor() {
    this.originalDocument = window.document;
    const fakeMobilePage = fs.readFileSync("./test/utils/fakeMobile.html", { encoding: "utf8", flag: "r" });
    const dom = new JSDOM(fakeMobilePage);
    Object.defineProperty(window, "document", {
      value: dom.window.document,
      configurable: true,
      writable: true,
    });
  }

  destroy(): void {
    Object.defineProperty(window, "document", {
      value: this.originalDocument,
      configurable: true,
      writable: true,
    });
  }

  touchDown(button: string) {
    const node = document.querySelector(`[data-key][id='${button}']`);
    if (!node) {
      return;
    }
    const event = new Event("pointerdown");
    node.dispatchEvent(event);
  }

  touchUp(button: string) {
    const node = document.querySelector(`[data-key][id='${button}']`);
    if (!node) {
      return;
    }
    const event = new Event("pointerup");
    node.dispatchEvent(event);
  }
}
