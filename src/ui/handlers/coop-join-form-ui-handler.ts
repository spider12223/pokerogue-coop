import { isValidRoomCode, normalizeRoomCode, ROOM_CODE_LENGTH } from "#app/multiplayer/network/room-code";
import { type FormModalConfig, FormModalUiHandler, type InputFieldConfig } from "#ui/form-modal-ui-handler";
import type { ModalConfig } from "#ui/modal-ui-handler";

export class CoopJoinFormUiHandler extends FormModalUiHandler {
  override getModalTitle(_config?: ModalConfig): string {
    return "Enter Co-op Code";
  }

  override getWidth(_config?: ModalConfig): number {
    return 160;
  }

  override getMargin(_config?: ModalConfig): [number, number, number, number] {
    return [0, 0, 48, 0];
  }

  override getButtonLabels(_config?: ModalConfig): string[] {
    return ["Join", "Cancel"];
  }

  override getInputFieldConfigs(): InputFieldConfig[] {
    return [{ label: `${ROOM_CODE_LENGTH}-character code` }];
  }

  override show(args: any[]): boolean {
    if (!super.show(args)) {
      return false;
    }
    if (this.inputs?.length > 0) {
      this.inputs.forEach(input => {
        input.text = "";
      });
    }
    const config = args[0] as FormModalConfig;
    this.submitAction = () => {
      this.sanitizeInputs();
      const raw = this.inputs[0].text;
      const code = normalizeRoomCode(raw);
      if (!isValidRoomCode(code)) {
        this.updateContainer({
          ...config,
          errorMessage: `Invalid code. Use ${ROOM_CODE_LENGTH} characters from A-Z and 2-9 (no I/O/0/1).`,
        } as FormModalConfig);
        return;
      }
      config.buttonActions[0](code);
    };
    return true;
  }
}
