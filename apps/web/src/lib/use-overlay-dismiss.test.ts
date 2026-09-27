import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Mirror of useOverlayDismiss decision logic for unit testing without React.
 * Keep in sync with apps/web/src/lib/use-overlay-dismiss.ts.
 */
function shouldDismissOverlay(input: {
  readonly enabled: boolean;
  readonly startedOnOverlay: boolean;
  readonly clickOnOverlay: boolean;
}): boolean {
  return input.enabled && input.startedOnOverlay && input.clickOnOverlay;
}

describe("overlay dismiss", () => {
  it("closes only when pointer down and click both happen on the overlay", () => {
    assert.equal(
      shouldDismissOverlay({
        enabled: true,
        startedOnOverlay: true,
        clickOnOverlay: true,
      }),
      true,
    );
  });

  it("does not close when text selection starts inside the dialog", () => {
    assert.equal(
      shouldDismissOverlay({
        enabled: true,
        startedOnOverlay: false,
        clickOnOverlay: true,
      }),
      false,
    );
  });
});
