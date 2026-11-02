export enum FieldPosition {
  CENTER,
  LEFT,
  RIGHT,
}

/** Co-op (D40): where our Pokémon of field slot `fieldIndex` stands in a battle of three: left, centre, right */
export function threeSlotPosition(fieldIndex: number): FieldPosition {
  if (fieldIndex === 0) {
    return FieldPosition.LEFT;
  }
  return fieldIndex === 1 ? FieldPosition.CENTER : FieldPosition.RIGHT;
}
