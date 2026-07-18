import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_WEBHOOK_SECRET: "secret_123",
    BOT_USERNAME: "@sigmabot",
    AI_API_KEY: "key",
    AI_MODEL: "kimi-k3",
    ALLOWED_USER_IDS: "1, 2",
    ALLOWED_GROUP_IDS: "-100",
    ...overrides,
  };
}

Deno.test("loadConfig parses required values and secure defaults", () => {
  const config = loadConfig(env());
  assert.equal(config.botUsername, "sigmabot");
  assert.equal(config.aiProvider, "moonshot");
  assert.equal(config.aiSupportsImages, "auto");
  assert.deepEqual([...config.allowedUserIds], ["1", "2"]);
  assert.equal(config.webSearch, false);
  assert.equal(config.maxOutputTokens, 131_072);
});

Deno.test("loadConfig fails closed without the webhook secret", () => {
  assert.throws(
    () => loadConfig(env({ TELEGRAM_WEBHOOK_SECRET: undefined })),
    /TELEGRAM_WEBHOOK_SECRET/,
  );
});

Deno.test("loadConfig validates IDs, bounds, and provider aliases", () => {
  assert.throws(() => loadConfig(env({ ALLOWED_USER_IDS: "alice" })), /numeric IDs/);
  assert.throws(() => loadConfig(env({ AI_TIMEOUT_MS: "999999" })), /between/);
  assert.throws(() => loadConfig(env({ MAX_MESSAGE_CHARS: "12001" })), /between/);
  assert.equal(
    loadConfig(env({ AI_MAX_OUTPUT_TOKENS: "131072" })).maxOutputTokens,
    131_072,
  );
  assert.throws(
    () => loadConfig(env({ AI_MAX_OUTPUT_TOKENS: "131073" })),
    /between 64 and 131072/,
  );
  assert.throws(
    () =>
      loadConfig(env({
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-5",
        AI_MAX_OUTPUT_TOKENS: "8193",
      })),
    /between 64 and 8192/,
  );
  assert.equal(loadConfig(env({ AI_PROVIDER: "anthropic" })).aiProvider, "claude");
  assert.equal(loadConfig(env({ AI_PROVIDER: "xai" })).aiProvider, "grok");
});

Deno.test("loadConfig requires Kimi K3 for Moonshot", () => {
  assert.equal(loadConfig(env()).aiModel, "kimi-k3");
  assert.throws(
    () => loadConfig(env({ AI_MODEL: "other-model" })),
    /AI_MODEL must be kimi-k3 when AI_PROVIDER is moonshot/,
  );
  assert.equal(
    loadConfig(env({ AI_PROVIDER: "openai", AI_MODEL: "other-model" })).aiModel,
    "other-model",
  );
});

Deno.test("loadConfig allows web search for Moonshot Kimi K3", () => {
  assert.equal(loadConfig(env({ WEB_SEARCH: "true" })).webSearch, true);
  assert.equal(
    loadConfig(
      env({
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-5",
        WEB_SEARCH: "true",
      }),
    ).webSearch,
    true,
  );
});

Deno.test("loadConfig parses image support discovery and overrides", () => {
  assert.equal(loadConfig(env({ AI_SUPPORTS_IMAGES: " auto " })).aiSupportsImages, "auto");
  assert.equal(loadConfig(env({ AI_SUPPORTS_IMAGES: "TRUE" })).aiSupportsImages, true);
  assert.equal(loadConfig(env({ AI_SUPPORTS_IMAGES: " false " })).aiSupportsImages, false);
  assert.throws(
    () => loadConfig(env({ AI_SUPPORTS_IMAGES: "yes" })),
    /AI_SUPPORTS_IMAGES must be auto, true, or false/,
  );
});

Deno.test("loadConfig rejects insecure remote base URLs", () => {
  assert.throws(
    () => loadConfig(env({ OPENAI_BASE_URL: "http://remote.example/v1" })),
    /HTTPS/,
  );
  assert.equal(
    loadConfig(env({ OPENAI_BASE_URL: "http://localhost:1234/v1/" })).openAIBaseUrl,
    "http://localhost:1234/v1",
  );
});

Deno.test("loadConfig rejects endpoint URL credentials, queries, and fragments", () => {
  for (
    const openAIBaseUrl of [
      "https://user:password@api.example/v1",
      "https://api.example/v1?key=value",
      "https://api.example/v1#models",
    ]
  ) {
    assert.throws(
      () => loadConfig(env({ OPENAI_BASE_URL: openAIBaseUrl })),
      /must not include/,
    );
  }

  for (
    const publicUrl of [
      "https://user:password@bot.example",
      "https://bot.example?timeline=production",
      "https://bot.example#webhook",
    ]
  ) {
    assert.throws(
      () => loadConfig(env({ PUBLIC_URL: publicUrl })),
      /must not include/,
    );
  }

  assert.throws(
    () => loadConfig(env({ PUBLIC_URL: "http://bot.example" })),
    /HTTPS/,
  );
  assert.equal(
    loadConfig(env({ PUBLIC_URL: "https://bot.example/" })).publicUrl,
    "https://bot.example",
  );
});

Deno.test("PUBLIC_URL is an origin on a Telegram-supported webhook port", () => {
  assert.throws(
    () => loadConfig(env({ PUBLIC_URL: "https://bot.example/base" })),
    /without a path/,
  );
  assert.throws(
    () => loadConfig(env({ PUBLIC_URL: "https://bot.example:444" })),
    /port 443, 80, 88, or 8443/,
  );

  for (
    const [value, expected] of [
      ["https://bot.example", "https://bot.example"],
      ["https://bot.example:443/", "https://bot.example"],
      ["https://bot.example:80", "https://bot.example:80"],
      ["https://bot.example:88", "https://bot.example:88"],
      ["https://bot.example:8443", "https://bot.example:8443"],
    ]
  ) {
    assert.equal(loadConfig(env({ PUBLIC_URL: value })).publicUrl, expected);
  }
});
