import { globalScene } from "#app/global-scene";
import type { CommandSource } from "#app/multiplayer/command-source";
import { LocalUiCommandSource } from "#app/multiplayer/command-source";
import type { FieldSlotRole, InputOwner, InputRole, PlayerSlot } from "#app/multiplayer/input-role";
import type { InputEvent } from "#app/multiplayer/input-source";
import Overrides from "#app/overrides";
import type { BattlerIndex } from "#enums/battler-index";

export class TurnCommandManager {
  public setOrder: readonly BattlerIndex[] | undefined;

  private fieldSlotOwners: Record<0 | 1, InputOwner> = { 0: 0, 1: 0 };
  private readonly partySlotOwners: Map<number, InputOwner> = new Map();
  private readonly commandSources: Map<PlayerSlot, CommandSource> = new Map();
  private lastRole: InputRole = { kind: "shared" };

  public resetTurnOrder(): void {
    this.setOrder = undefined;
  }

  public initSinglePlayer(): void {
    this.fieldSlotOwners = { 0: 0, 1: 0 };
    this.partySlotOwners.clear();
    this.commandSources.clear();
    this.commandSources.set(0, new LocalUiCommandSource(0));
  }

  public initHotseat(): void {
    this.fieldSlotOwners = { 0: 0, 1: 1 };
    this.partySlotOwners.clear();
    this.commandSources.clear();
    this.commandSources.set(0, new LocalUiCommandSource(0));
    this.commandSources.set(1, new LocalUiCommandSource(1));
  }

  public refreshFromOverrides(): void {
    if (Overrides.LOCAL_HOTSEAT_OVERRIDE) {
      this.initHotseat();
    } else {
      this.initSinglePlayer();
    }
  }

  public registerCommandSource(slot: PlayerSlot, source: CommandSource): void {
    this.commandSources.set(slot, source);
  }

  public getCommandSource(role: FieldSlotRole): CommandSource {
    const owner = this.fieldSlotOwners[role.fieldIndex];
    const source = this.commandSources.get(owner);
    if (!source) {
      throw new Error(`No CommandSource registered for slot ${owner}`);
    }
    return source;
  }

  public getOwnerForRole(role: InputRole): InputOwner {
    switch (role.kind) {
      case "field-slot":
        return this.fieldSlotOwners[role.fieldIndex];
      case "party-slot":
        return this.partySlotOwners.get(role.partyMemberIndex) ?? 0;
      case "shared":
        return 0;
    }
  }

  public bindPartySlotOwner(partyMemberIndex: number, owner: InputOwner): void {
    this.partySlotOwners.set(partyMemberIndex, owner);
  }

  public unbindPartySlotOwner(partyMemberIndex: number): void {
    this.partySlotOwners.delete(partyMemberIndex);
  }

  public getCurrentInputRole(): InputRole {
    const phase = globalScene.phaseManager.getCurrentPhase();
    if (phase.is("CommandPhase")) {
      return { kind: "field-slot", fieldIndex: phase.getFieldIndex() as PlayerSlot };
    }
    if (phase.is("SelectTargetPhase")) {
      return { kind: "field-slot", fieldIndex: phase.fieldIndex as PlayerSlot };
    }
    if (phase.is("CheckSwitchPhase")) {
      return { kind: "field-slot", fieldIndex: phase.getFieldIndex() as PlayerSlot };
    }
    if (phase.is("SwitchPhase")) {
      return { kind: "field-slot", fieldIndex: phase.getFieldIndex() as PlayerSlot };
    }
    return { kind: "shared" };
  }

  public shouldAcceptInput(event: InputEvent): boolean {
    const role = this.getCurrentInputRole();
    this.detectRoleChange(role);
    if (role.kind === "shared") {
      return true;
    }
    const owner = this.getOwnerForRole(role);
    return event.playerSlot === owner;
  }

  private detectRoleChange(current: InputRole): void {
    if (this.rolesEqual(this.lastRole, current)) {
      return;
    }
    const lapsedOwners = this.lapsedOwners(this.lastRole, current);
    this.lastRole = current;
    if (lapsedOwners.size === 0) {
      return;
    }
    for (const source of globalScene.inputController.getAllSources()) {
      if (lapsedOwners.has(source.playerSlot)) {
        source.releaseAll();
      }
    }
  }

  private rolesEqual(a: InputRole, b: InputRole): boolean {
    if (a.kind !== b.kind) {
      return false;
    }
    if (a.kind === "field-slot" && b.kind === "field-slot") {
      return a.fieldIndex === b.fieldIndex;
    }
    if (a.kind === "party-slot" && b.kind === "party-slot") {
      return a.partyMemberIndex === b.partyMemberIndex;
    }
    return true;
  }

  private lapsedOwners(prev: InputRole, current: InputRole): Set<InputOwner> {
    const prevOwners = this.permittedOwners(prev);
    const currentOwners = this.permittedOwners(current);
    const lapsed = new Set<InputOwner>();
    for (const owner of prevOwners) {
      if (!currentOwners.has(owner)) {
        lapsed.add(owner);
      }
    }
    return lapsed;
  }

  private permittedOwners(role: InputRole): Set<InputOwner> {
    if (role.kind === "shared") {
      return new Set<InputOwner>([0, 1]);
    }
    return new Set<InputOwner>([this.getOwnerForRole(role)]);
  }
}
