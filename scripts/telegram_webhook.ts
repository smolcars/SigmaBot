import { validatePublicUrl } from "../src/config.ts";
import { TelegramClient } from "../src/telegram.ts";

function required(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const action = Deno.args[0] ?? "set";
  const dropPending = Deno.args.includes("--drop-pending");
  const client = new TelegramClient(required("TELEGRAM_BOT_TOKEN"));

  if (action === "set") {
    const publicUrl = validatePublicUrl(required("PUBLIC_URL"));
    const webhookUrl = `${publicUrl}/api/telegram-webhook`;
    await client.setWebhook(
      webhookUrl,
      required("TELEGRAM_WEBHOOK_SECRET"),
      dropPending,
    );
    await client.setMyCommands();
    console.log(JSON.stringify({ ok: true, action, webhookUrl, commandsUpdated: true }));
    return;
  }

  if (action === "info") {
    const result = await client.getWebhookInfo();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (action === "delete") {
    await client.deleteWebhook(dropPending);
    console.log(JSON.stringify({ ok: true, action }));
    return;
  }

  throw new Error("Usage: deno task webhook|webhook:info|webhook:delete [--drop-pending]");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Webhook command failed");
    Deno.exit(1);
  }
}
