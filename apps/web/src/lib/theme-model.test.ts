import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseThemePreference,
  resolveTheme,
} from "./theme-model.ts";

describe("resolveTheme", () => {
  it("honors explicit light and dark preferences", () => {
    assert.equal(resolveTheme("light", true), "light");
    assert.equal(resolveTheme("light", false), "light");
    assert.equal(resolveTheme("dark", true), "dark");
    assert.equal(resolveTheme("dark", false), "dark");
  });

  it("follows system when preference is system", () => {
    assert.equal(resolveTheme("system", true), "dark");
    assert.equal(resolveTheme("system", false), "light");
  });
});

describe("parseThemePreference", () => {
  it("accepts known values and defaults to system", () => {
    assert.equal(parseThemePreference("light"), "light");
    assert.equal(parseThemePreference("dark"), "dark");
    assert.equal(parseThemePreference("system"), "system");
    assert.equal(parseThemePreference(null), "system");
    assert.equal(parseThemePreference("nope"), "system");
  });
});
