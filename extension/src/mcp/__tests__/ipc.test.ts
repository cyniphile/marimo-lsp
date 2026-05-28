import { describe, expect, it } from "vitest";

import { isMcpRunEnabledFromInspection } from "../ipc.ts";

describe("isMcpRunEnabledFromInspection", () => {
  it("enables run only when the global user setting is true", () => {
    expect(
      isMcpRunEnabledFromInspection({
        globalValue: true,
      }),
    ).toBe(true);
  });

  it("ignores workspace and workspace-folder values", () => {
    expect(
      isMcpRunEnabledFromInspection({
        workspaceValue: true,
      }),
    ).toBe(false);
    expect(
      isMcpRunEnabledFromInspection({
        workspaceFolderValue: true,
      }),
    ).toBe(false);
    expect(
      isMcpRunEnabledFromInspection({
        globalValue: false,
        workspaceValue: true,
        workspaceFolderValue: true,
      }),
    ).toBe(false);
  });

  it("tolerates missing inspection data", () => {
    expect(isMcpRunEnabledFromInspection(undefined)).toBe(false);
    expect(isMcpRunEnabledFromInspection(null)).toBe(false);
  });
});
