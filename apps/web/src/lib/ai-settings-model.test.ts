import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertSafeCredentialPayload,
  buildByokPreferencePayload,
  buildManagedPreferencePayload,
  clearedApiKeyAfterSuccess,
  credentialStatusByProvider,
  filterManagedModels,
  findManagedModel,
  formatUsdFromMicros,
  isManagedModelUnavailable,
  isProviderConnected,
  managedModelMetaLine,
  modeFromPreference,
  trialDisplay,
  type AiPreference,
  type ManagedAiModel,
  type PublicProviderCredential,
} from "./ai-settings-model.ts";

const sampleModels: ManagedAiModel[] = [
  {
    id: "openai/gpt-4.1",
    name: "GPT-4.1",
    author: "openai",
    contextLength: 128_000,
    supportedParameters: ["tools"],
    pricing: { prompt: "0.000002", completion: "0.000008" },
  },
  {
    id: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    author: "anthropic",
    contextLength: 200_000,
    supportedParameters: ["tools"],
    pricing: { prompt: "0.000003", completion: "0.000015" },
  },
];

describe("credential status", () => {
  it("loads connected providers without inventing secrets", () => {
    const credentials: PublicProviderCredential[] = [
      {
        provider: "openai",
        connected: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const byProvider = credentialStatusByProvider(credentials);
    assert.equal(byProvider.openai?.connected, true);
    assert.equal(byProvider.anthropic, null);
    assert.equal(isProviderConnected(credentials, "openai"), true);
    assert.equal(isProviderConnected(credentials, "anthropic"), false);
    assertSafeCredentialPayload(credentials[0]!);
  });

  it("rejects leaked secret fields in credential payloads", () => {
    assert.throws(() =>
      assertSafeCredentialPayload({
        provider: "openai",
        connected: true,
        apiKey: "sk-secret",
      }),
    );
  });
});

describe("preference payloads", () => {
  it("saves managed preference with exact OpenRouter model id", () => {
    assert.deepEqual(buildManagedPreferencePayload("openai/gpt-4.1"), {
      provider: "openrouter",
      model: "openai/gpt-4.1",
      credentialSource: "managed",
    });
  });

  it("saves BYOK provider/model preference correctly", () => {
    assert.deepEqual(buildByokPreferencePayload("anthropic", "claude-sonnet-4-5"), {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      credentialSource: "byok",
    });
  });

  it("derives mode from preference", () => {
    const byok: AiPreference = {
      provider: "openai",
      model: "gpt-4.1",
      credentialSource: "byok",
      createdAt: "",
      updatedAt: "",
    };
    assert.equal(modeFromPreference(byok), "byok");
    assert.equal(modeFromPreference(null), "managed");
  });
});

describe("managed catalog", () => {
  it("searches models by name and id", () => {
    const hits = filterManagedModels(sampleModels, "claude");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "anthropic/claude-sonnet-4");
    assert.equal(findManagedModel(sampleModels, "openai/gpt-4.1")?.name, "GPT-4.1");
  });

  it("marks disappeared selected model as unavailable", () => {
    assert.equal(
      isManagedModelUnavailable(sampleModels, true, "gone/model"),
      true,
    );
    assert.equal(
      isManagedModelUnavailable(sampleModels, true, "openai/gpt-4.1"),
      false,
    );
    assert.equal(
      isManagedModelUnavailable(sampleModels, false, "gone/model"),
      false,
    );
  });

  it("builds concise metadata without clutter", () => {
    const line = managedModelMetaLine(sampleModels[0]!);
    assert.match(line, /openai/);
    assert.match(line, /128K ctx/);
    assert.match(line, /\/M/);
  });
});

describe("trial status", () => {
  it("renders available balance from micros", () => {
    const display = trialDisplay({
      enabled: true,
      originalGrantMicros: 5_000_000,
      balanceMicros: 2_500_000,
      exhausted: false,
    });
    assert.equal(display.kind, "available");
    assert.match(display.balanceLabel, /\$2\.50 remaining/);
    assert.equal(formatUsdFromMicros(1_000_000), "$1.00");
  });

  it("renders exhausted / overshoot as $0.00", () => {
    const display = trialDisplay({
      enabled: true,
      originalGrantMicros: 1_000_000,
      balanceMicros: -40_000,
      exhausted: true,
    });
    assert.equal(display.kind, "exhausted");
    assert.equal(display.balanceLabel, "$0.00 remaining");
    assert.equal(display.statusLabel, "Trial exhausted");
  });

  it("renders disabled managed trial", () => {
    const display = trialDisplay({
      enabled: false,
      originalGrantMicros: 0,
      balanceMicros: 0,
      exhausted: true,
    });
    assert.equal(display.kind, "disabled");
    assert.equal(display.statusLabel, "Managed AI unavailable");
  });
});

describe("API key handling", () => {
  it("clears submitted key after successful connect", () => {
    let draft = "sk-live-example";
    draft = clearedApiKeyAfterSuccess();
    assert.equal(draft, "");
  });
});
