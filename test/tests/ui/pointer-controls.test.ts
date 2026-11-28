import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { Button } from "#enums/buttons";
import { MouseCursor } from "#enums/mouse-cursor";
import { PointerHighlight } from "#enums/pointer-highlight";
import { GameManager } from "#test/framework/game-manager";
import { installGlobalPointerRouter } from "#ui/global-pointer-router";
import { applySiteCursor, cursorCss } from "#ui/mouse-cursors";
import { PointerHitAreaManager } from "#ui/pointer-hit-areas";
import { enterKeyMode, enterPointerMode, hasHoverBox, syncMenuArrow } from "#ui/pointer-mode";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Click & Tap Controls (D49): off (the default), a click or a tap on the game does nothing; on, it does what a key does */
describe("UI - Click & Tap Controls", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    new GameManager(phaserGame);
  });

  afterEach(() => {
    settings.update("general", "pointerControls", false);
    settings.update("general", "pointerHighlight", PointerHighlight.CORNERS);
    settings.update("general", "mouseCursor", MouseCursor.PIXEL_ARROW);
    vi.restoreAllMocks();
  });

  /** A 2D canvas that draws (the test page's draws nothing) */
  function canvasThatDraws(): void {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      fillStyle: "",
      fillRect: () => undefined,
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
  }

  it("uses the chosen mouse pointer whatever Click & Tap Controls is, and the computer's with System", () => {
    canvasThatDraws();
    settings.update("general", "mouseCursor", MouseCursor.GLOVE);
    // (the glove points with its finger: 2 pixels in, drawn at twice the size)
    expect(cursorCss("pointer")).toMatch(/^url\("data:image\/png[^"]*"\) 4 0, pointer$/);

    settings.update("general", "mouseCursor", MouseCursor.SYSTEM);
    expect(cursorCss("pointer")).toBe("pointer");
  });

  it("puts the chosen pointer on the whole page, and takes it off with System", () => {
    canvasThatDraws();
    settings.update("general", "mouseCursor", MouseCursor.POKE_BALL);
    applySiteCursor();
    expect(document.getElementById("coop-mouse-cursor")?.textContent).toMatch(
      /^html, body, body \* \{ cursor: url\("data:image\/png[^"]*"\) 12 12, auto !important; \}$/,
    );

    settings.update("general", "mouseCursor", MouseCursor.SYSTEM);
    applySiteCursor();
    expect(document.getElementById("coop-mouse-cursor")).toBeNull();
  });

  const leftClick = { wasTouch: false, button: 0, leftButtonDown: () => true, rightButtonDown: () => false };
  const rightClick = { wasTouch: false, button: 2, isDown: true, rightButtonDown: () => true, getDistance: () => 0 };

  /** A menu row whose zone keeps its listeners (the mock rectangle keeps none) */
  function menuRow(onActivate: () => void, onHover: () => void): Phaser.Events.EventEmitter {
    const zone = new Phaser.Events.EventEmitter();
    Object.assign(zone, { setOrigin: () => zone, setInteractive: () => zone, scene: {}, destroy: () => undefined });
    vi.spyOn(globalScene.add, "rectangle").mockReturnValue(zone as unknown as Phaser.GameObjects.Rectangle);
    const parent = { add: vi.fn() } as unknown as Phaser.GameObjects.Container;
    new PointerHitAreaManager(parent, () => undefined).setRows([
      { x: 0, y: 0, width: 10, height: 10, onActivate, onHover },
    ]);
    return zone;
  }

  /** The empty-space router's listeners, as it registers them (the test scene has no input plugin) */
  function routerListeners(): Record<string, (...args: unknown[]) => void> {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const input = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        listeners[event] = listener;
        return input;
      },
    };
    const scene = globalScene as unknown as { input: unknown; game: { canvas: HTMLCanvasElement | null } };
    const realInput = scene.input;
    const realCanvas = scene.game.canvas;
    scene.input = input;
    scene.game.canvas ??= document.createElement("canvas");
    try {
      installGlobalPointerRouter();
    } finally {
      scene.input = realInput;
      scene.game.canvas = realCanvas;
    }
    return listeners;
  }

  it("is off by default: a hover or a click on a menu row does nothing", () => {
    expect(settings.general.pointerControls).toBe(false);
    const onActivate = vi.fn();
    const onHover = vi.fn();
    const zone = menuRow(onActivate, onHover);

    zone.emit("pointerover");
    zone.emit("pointerdown", leftClick);

    expect(onHover).not.toHaveBeenCalled();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("on, a hover selects a menu row and a click activates it", () => {
    settings.update("general", "pointerControls", true);
    const onActivate = vi.fn();
    const onHover = vi.fn();
    const zone = menuRow(onActivate, onHover);

    zone.emit("pointerover");
    zone.emit("pointerdown", leftClick);

    expect(onHover).toHaveBeenCalledOnce();
    expect(onActivate).toHaveBeenCalledOnce();
  });

  describe("mouse mode: a box on the hovered option instead of the arrow", () => {
    afterEach(() => {
      enterKeyMode();
    });

    /** A menu whose arrow is a plain object with an alpha */
    function menuWithArrow(alpha: number): { alpha: number; setAlpha(value: number): unknown } {
      const arrow = {
        alpha,
        setAlpha(value: number) {
          arrow.alpha = value;
          return arrow;
        },
      };
      vi.spyOn(globalScene.ui, "getHandler").mockReturnValue({ cursorObj: arrow } as never);
      return arrow;
    }

    it("puts a box over the hovered option, and takes it away when the pointer leaves", () => {
      settings.update("general", "pointerControls", true);
      const zone = menuRow(vi.fn(), vi.fn());

      zone.emit("pointerover");
      expect(hasHoverBox()).toBe(true);
      zone.emit("pointerout");
      expect(hasHoverBox()).toBe(false);
    });

    it("hides the arrow of the menu that is up while the pointer is used; a key brings it back as it was", () => {
      settings.update("general", "pointerControls", true);
      const arrow = menuWithArrow(0.8);

      enterPointerMode();
      syncMenuArrow();
      expect(arrow.alpha).toBe(0);

      enterKeyMode();
      expect(arrow.alpha).toBe(0.8);
      expect(hasHoverBox()).toBe(false);
    });

    it("with the Classic highlight marks nothing: the menu's own arrow stays and follows the pointer", () => {
      settings.update("general", "pointerControls", true);
      settings.update("general", "pointerHighlight", PointerHighlight.CLASSIC);
      const zone = menuRow(vi.fn(), vi.fn());
      const arrow = menuWithArrow(1);

      zone.emit("pointerover");
      syncMenuArrow();

      expect(hasHoverBox()).toBe(false);
      expect(arrow.alpha).toBe(1);
    });

    it("marks the option with each other highlight", () => {
      settings.update("general", "pointerControls", true);
      for (const style of [
        PointerHighlight.CORNERS,
        PointerHighlight.CORNERS_LONG,
        PointerHighlight.CORNERS_PULSE,
        PointerHighlight.GLOW,
        PointerHighlight.BAR,
      ]) {
        settings.update("general", "pointerHighlight", style);
        const zone = menuRow(vi.fn(), vi.fn());
        zone.emit("pointerover");
        expect(hasHoverBox(), PointerHighlight[style]).toBe(true);
        zone.emit("pointerout");
        expect(hasHoverBox(), PointerHighlight[style]).toBe(false);
      }
    });

    it("with the setting off: no box, and the arrow stays", () => {
      const zone = menuRow(vi.fn(), vi.fn());
      const arrow = menuWithArrow(1);

      zone.emit("pointerover");
      enterPointerMode();
      syncMenuArrow();

      expect(hasHoverBox()).toBe(false);
      expect(arrow.alpha).toBe(1);
    });
  });

  it("makes a right click on empty space Back only when it is on", () => {
    const listeners = routerListeners();
    const emit = vi.spyOn(globalScene.game.events, "emit");

    listeners["pointerdown"](rightClick, []);
    expect(emit).not.toHaveBeenCalledWith("input_down", expect.anything());

    settings.update("general", "pointerControls", true);
    listeners["pointerdown"](rightClick, []);
    expect(emit).toHaveBeenCalledWith("input_down", expect.objectContaining({ button: Button.CANCEL }));
  });
});
