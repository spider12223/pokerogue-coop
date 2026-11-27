import { settings } from "#app/global-settings-manager";
import { MouseCursor } from "#enums/mouse-cursor";
import { pointerControlsOn } from "#ui/pointer-input";

/**
 * The game's own mouse pointers (D49): pixel art drawn here, at twice their size, and given to the canvas as a CSS cursor.
 * @module
 */

/** One pointer: its pixels (a character per pixel, `.` clear) and the pixel that points */
interface CursorArt {
  rows: readonly string[];
  hotspot: readonly [number, number];
}

const PALETTE: Readonly<Record<string, string>> = {
  K: "#181818",
  W: "#f8f8f8",
  S: "#c4c4cc",
  R: "#e8343c",
  H: "#ff9aa0",
};

const ART: Readonly<Record<Exclude<MouseCursor, MouseCursor.SYSTEM>, CursorArt>> = {
  [MouseCursor.PIXEL_ARROW]: {
    rows: [
      "K..........",
      "KK.........",
      "KWK........",
      "KWWK.......",
      "KWWWK......",
      "KWWWWK.....",
      "KWWWWWK....",
      "KWWWWWWK...",
      "KWWWWWWWK..",
      "KWWWWWWWWK.",
      "KWWWWWKKKKK",
      "KWWKWWK....",
      "KWK.KWWK...",
      "KK..KWWK...",
      "K....KWWK..",
      ".....KWWK..",
      "......KK...",
    ],
    hotspot: [0, 0],
  },
  [MouseCursor.POKE_BALL]: {
    rows: [
      "....KKKK....",
      "..KKRRRRKK..",
      ".KRHRRRRRRK.",
      ".KRRRRRRRRK.",
      "KRRRRKKRRRRK",
      "KRRRKWWKRRRK",
      "KKKKKWWKKKKK",
      "KWWWWKKWWWWK",
      ".KWWWWWWWSK.",
      ".KWWWWWWSSK.",
      "..KKWWSSKK..",
      "....KKKK....",
    ],
    hotspot: [6, 6],
  },
  [MouseCursor.GLOVE]: {
    rows: [
      "..KK.........",
      ".KWWK........",
      ".KWWK........",
      ".KWWK........",
      ".KWWKKK......",
      ".KWWKWWKK....",
      ".KWWKWWKWKK..",
      "KKWWWWWKWWWK.",
      "KWKWWWWWWWWSK",
      "KWWWWWWWWWWSK",
      ".KWWWWWWWWWSK",
      ".KWWWWWWWWSK.",
      "..KWWWWWWSSK.",
      "..KSSSSSSSSK.",
      "..KKKKKKKKKK.",
    ],
    hotspot: [2, 0],
  },
};

/** Each pointer's CSS value, drawn once */
const drawn = new Map<MouseCursor, string | null>();

/** @returns The pointer's CSS image (`url(...) x y`), or `null` where nothing can be drawn (no 2D canvas) */
function cursorImage(choice: Exclude<MouseCursor, MouseCursor.SYSTEM>): string | null {
  const cached = drawn.get(choice);
  if (cached !== undefined) {
    return cached;
  }
  const { rows, hotspot } = ART[choice];
  const scale = 2;
  let css: string | null = null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(...rows.map(row => row.length)) * scale;
    canvas.height = rows.length * scale;
    const context = canvas.getContext("2d");
    if (context !== null) {
      rows.forEach((row, y) => {
        [...row].forEach((pixel, x) => {
          const color = PALETTE[pixel];
          if (color !== undefined) {
            context.fillStyle = color;
            context.fillRect(x * scale, y * scale, scale, scale);
          }
        });
      });
      css = `url("${canvas.toDataURL("image/png")}") ${hotspot[0] * scale} ${hotspot[1] * scale}`;
    }
  } catch {
    css = null;
  }
  drawn.set(choice, css);
  return css;
}

/**
 * @param state - What the pointer is over: an option it can press (`pointer`) or anything else (`default`)
 * @returns The canvas's CSS cursor: the game's own pointer with Click & Tap Controls on (the computer's as the fallback),
 * else the computer's
 */
export function cursorCss(state: "default" | "pointer"): string {
  const choice: MouseCursor | undefined = settings?.general?.mouseCursor;
  if (!pointerControlsOn() || choice === undefined || choice === MouseCursor.SYSTEM) {
    return state;
  }
  const image = cursorImage(choice);
  return image === null ? state : `${image}, ${state}`;
}
