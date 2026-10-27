/*
 * SPDX-FileCopyrightText: 2026 pokerogue-coop contributors
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { retryKey } from "#coop/decision-keys";
import { checkDecisionLegal } from "#coop/legal";
import { DECISION_KINDS, isDecisionKey } from "#coop/protocol";
import { isResyncMessage, isResyncRequest, RESYNC_REASONS } from "#coop/resync";
import { isRetryPayload } from "#coop/retry";
import { canTakeOver, takeoverPlan } from "#coop/takeover";
import { validateProposal } from "#coop/validate";
import { describe, expect, it } from "vitest";
import { view } from "./legal-fixtures";

/** The retry after a wipe (DECISIONS D4a, amended): the host retries the wave or ends the run; a retry is a reload of D13 */

describe("the retry after a wipe", () => {
  it("is one per wave, and the last decision kind (the kinds before it keep their place)", () => {
    expect(retryKey(14)).toEqual({ wave: 14, turn: 0, kind: "RETRY", ref: -1 });
    expect(isDecisionKey(retryKey(14))).toBe(true);
    expect(DECISION_KINDS.at(-1)).toBe("RETRY");
    expect(DECISION_KINDS.indexOf("SIDE_PICK")).toBe(DECISION_KINDS.length - 2);
  });

  it.each([{ retry: true }, { retry: false }])("reads %o", payload => {
    expect(isRetryPayload(payload)).toBe(true);
  });

  it.each<unknown>([null, undefined, {}, true, { retry: 1 }, { retry: "yes" }, { retry: null }, { accept: true }])(
    "drops %o",
    payload => {
      expect(isRetryPayload(payload)).toBe(false);
    },
  );

  it("is legal as a yes or a no, from whoever made it (a takeover is the guest's) (D24)", () => {
    for (const author of ["host", "guest"] as const) {
      expect(checkDecisionLegal(view(), retryKey(2), { retry: true }, author)).toBeNull();
      expect(checkDecisionLegal(view(), retryKey(2), { retry: false }, author)).toBeNull();
      expect(checkDecisionLegal(view(), retryKey(2), { retry: "yes" }, author)).toMatch(/cannot be read/);
      expect(checkDecisionLegal(view(), retryKey(2), null, author)).toMatch(/cannot be read/);
    }
  });

  it("is checked by the host before it is sequenced", () => {
    expect(validateProposal(retryKey(2), { retry: true }, "host")).toBe(true);
    expect(validateProposal(retryKey(2), { retry: false }, "guest")).toBe(true);
    expect(validateProposal(retryKey(2), { pokemonId: 1 }, "host")).toBe(false);
  });

  it("is taken over with the host's menu (D17)", () => {
    expect(canTakeOver("RETRY")).toBe(true);
    expect(takeoverPlan(retryKey(2))).toEqual({ mode: "ask" });
  });
});

describe("the reload of a retry (D13)", () => {
  const save = '{"waveIndex":3}';

  it("is a RESYNC with the reason retry", () => {
    expect(RESYNC_REASONS).toContain("retry");
    expect(isResyncMessage({ epoch: 2, seq: 40, wave: 3, reason: "retry", save })).toBe(true);
    expect(isResyncMessage({ epoch: 2, seq: 40, wave: 3, reason: "retry", save: "" })).toBe(false);
    expect(isResyncMessage({ epoch: 2, seq: 40, wave: 3, reason: "again", save })).toBe(false);
  });

  it("is never asked for by the guest: the host decides it", () => {
    expect(isResyncRequest({ reason: "retry", wave: 3, mismatch: null })).toBe(false);
  });
});
