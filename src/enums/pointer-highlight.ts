/** How a menu marks the option under the mouse while it is used (Click & Tap Controls, D49) */
export enum PointerHighlight {
  /** Short lines at the option's four corners */
  CORNERS,
  /** Longer lines at the corners */
  CORNERS_LONG,
  /** Short corner lines that step out and back */
  CORNERS_PULSE,
  /** The menu's own arrow follows the mouse, as the classic Pokémon games' cursor */
  CLASSIC,
  /** A pulsing outline, in the spirit of the Nintendo Switch HOME menu */
  GLOW,
  /** A soft bar behind the option, in the spirit of Sword and Shield */
  BAR,
}
