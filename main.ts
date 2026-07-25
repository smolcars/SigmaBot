import { ProviderAIClient } from "./src/ai.ts";
import { BotApplication } from "./src/bot.ts";
import { type AppConfig, loadConfig } from "./src/config.ts";
import { GitHubClient } from "./src/github.ts";
import { Logger } from "./src/logger.ts";
import { BotStore } from "./src/store.ts";
import { TelegramClient } from "./src/telegram.ts";

interface Runtime {
  app: BotApplication;
  config: AppConfig;
}

const log = new Logger("runtime");
let runtimePromise: Promise<Runtime> | undefined;

function getRuntime(): Promise<Runtime> {
  if (!runtimePromise) {
    runtimePromise = createRuntime().catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
  }
  return runtimePromise;
}

async function createRuntime(): Promise<Runtime> {
  const config = loadConfig();
  const kv = await Deno.openKv(config.kvPath);
  const store = new BotStore(kv);
  const app = new BotApplication(
    config,
    store,
    new TelegramClient(config.telegramToken),
    new ProviderAIClient(config),
    {
      ...(config.github && { github: new GitHubClient(config.github) }),
    },
  );

  return { app, config };
}

if (import.meta.main) {
  const { app, config } = await getRuntime();
  Deno.serve({ port: config.port }, app.fetch);
  log.info({ action: "started", port: config.port });
}
