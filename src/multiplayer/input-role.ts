export type PlayerSlot = 0 | 1;

export type InputOwner = PlayerSlot;

export interface FieldSlotRole {
  readonly kind: "field-slot";
  readonly fieldIndex: PlayerSlot;
}

export interface PartySlotRole {
  readonly kind: "party-slot";
  readonly partyMemberIndex: number;
}

export interface SharedRole {
  readonly kind: "shared";
}

export type InputRole = FieldSlotRole | PartySlotRole | SharedRole;
