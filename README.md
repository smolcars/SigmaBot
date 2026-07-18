# SigmaBot

A Telegram AI chat bot built for the current Deno runtime and the new Deno Deploy platform.
It is a Deno/KV port of NerdBot's AI chat features.

## Features

- Private chats plus mention/reply activation in groups and supergroups
- Forum-topic isolation through Telegram's `message_thread_id`
- Persistent, bounded conversation context in Deno KV
- Claude, OpenAI, Moonshot (Kimi K3), and Grok providers
- Optional provider-native web search for OpenAI, Moonshot Kimi K3, and Grok
- Image questions for vision-capable provider/model combinations
- `/help` and topic-scoped `/reset` commands
- User/group allowlists, atomic rate limiting, update deduplication, and retry recovery
- Structured logs suitable for Deno Deploy logs, traces, and metrics

## Requirements

- Deno 2.x
- A Telegram bot token from [BotFather](https://t.me/BotFather)
- An API key and model ID for one supported AI provider
- A new-platform Deno Deploy app and assigned Deno KV database for production

## Local Setup

```bash
cp .env.example .env
```

Fill in the required values in `.env`, then start the bot:

```bash
deno task dev
```

Empty allowlists deny access by design. Private chats require the sender in
`ALLOWED_USER_IDS`. Group chats require the chat in `ALLOWED_GROUP_IDS`; set
`REQUIRE_ALLOWED_GROUP_USER=true` to require both lists.

The local webhook endpoint is:

```text
POST http://localhost:8000/api/telegram-webhook
```

The liveness endpoint is `GET /healthz`. Telegram itself requires a public HTTPS URL, so
local testing either needs a tunnel or direct HTTP test requests.

## BotFather Setup

For group conversation context, disable privacy mode with `/setprivacy`. With privacy
disabled, allowed group messages can be stored in KV and sent to the configured AI provider
as context, including participant display names. Keep privacy enabled if that data flow is
not acceptable; mentions and replies will still work with less context.

Set these commands, or let `deno task webhook` set them:

```text
help - Show help
reset - Clear this conversation
```

## Deno Deploy

This project targets the new Deno Deploy at [`console.deno.com`](https://console.deno.com/).
Deno Deploy Classic and `deployctl` are being retired, so use the `deno deploy` CLI.

Create the dynamic app without waiting for its initial deployment, then provision and assign
its KV database. The `deploy.org` and `deploy.app` values in `deno.json` bind subsequent CLI
commands to this app:

```bash
deno deploy create . --org sjoberg --app sigmabot --source local --runtime-mode dynamic --entrypoint main.ts --region global --no-wait
deno deploy database provision sigmabot-kv --kind denokv
deno deploy database assign sigmabot-kv --app sigmabot
```

If the create command reports that the app was created but publishing failed, do not create
the app again. Correct the local deploy configuration, attach KV and environment variables,
then run `deno task deploy`.

The initial deployment may fail startup until KV and the required variables are attached.
Add the production variables in the Deploy console, or load a production env file, then
create the production deployment:

```bash
deno deploy env load .env.production
deno task deploy
```

Treat `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, and `AI_API_KEY` as secrets. Use
separate Telegram bots/tokens for production and preview timelines because one Telegram bot
can have only one active webhook.

After the production URL is live, set `PUBLIC_URL` locally and register the webhook:

```bash
deno task webhook
deno task webhook:info
```

`--drop-pending` is accepted by the script but should be used only for an intentional reset
because it discards queued Telegram updates.

The source-controlled `deploy.runtime` configuration in `deno.json` makes `main.ts` the
dynamic entrypoint. An assigned KV database is selected automatically by Deploy for each
timeline when the application calls `Deno.openKv()`.

## Configuration

| Variable                | Default           | Purpose                                             |
| ----------------------- | ----------------- | --------------------------------------------------- |
| `AI_PROVIDER`           | `moonshot`        | `claude`, `openai`, `moonshot` (Kimi K3), or `grok` |
| `OPENAI_BASE_URL`       | OpenAI API        | Alternate OpenAI-compatible base URL                |
| `AI_SUPPORTS_IMAGES`    | `auto`            | Detect image input support, or force true/false     |
| `WEB_SEARCH`            | `false`           | Enable provider-native search                       |
| `AI_MAX_OUTPUT_TOKENS`  | Provider-specific | Completion budget; K3 defaults to `131072`          |
| `AI_TIMEOUT_MS`         | `35000`           | Total bounded provider request time                 |
| `RATE_LIMIT_PER_MINUTE` | `10`              | Triggered requests per user/chat fixed window       |
| `MAX_CONTEXT_MESSAGES`  | `20`              | Maximum model context message count                 |
| `MAX_CONTEXT_CHARS`     | `30000`           | Approximate context character budget                |
| `MAX_RETAINED_MESSAGES` | `100`             | Stored messages per chat/topic epoch                |
| `MAX_IMAGE_BYTES`       | `5242880`         | Maximum downloaded Telegram image size              |

See [`.env.example`](.env.example) for every setting. `AI_MODEL`, API keys, bot identity,
and the webhook secret are always required and validated at startup. Use `AI_MODEL=kimi-k3`
with `AI_PROVIDER=moonshot`.

Moonshot search uses Kimi K3's built-in `$web_search` tool. Moonshot currently labels web
search as being updated and does not recommend it for production use in the near term. Its
larger completion budget covers K3's always-on reasoning as well as the visible answer.

In `auto` mode, Moonshot, Claude, and Grok image support is discovered from provider model
metadata. Current chat models on official global and regional OpenAI API hosts are assumed
to support image input. Custom OpenAI-compatible endpoints are queried at `/models`;
documented model aliases and explicit `input_modalities`, `architecture.input_modalities`,
`capabilities.vision`, and `supports_vision` extensions are honored. Missing, invalid, or
conflicting capability metadata fails open, so image requests are attempted unless
`AI_SUPPORTS_IMAGES=false` is configured. Successful discovery is cached for one hour;
transport and retryable HTTP failures are retried by the next image request after one
minute.

## Reliability Model

The webhook authenticates before reading its body and atomically records each Telegram
`update_id`. Webhook registration uses one Telegram connection to preserve update order;
accepted updates are also ordered per conversation and protected by ownership leases. AI
work runs inline under a hard timeout because the new Deno Deploy does not support Deno KV
queues and post-response background work is not durable. A response is persisted before
Telegram delivery, so retries do not repeat a completed model call. Non-terminal webhook
attempts return a non-2xx response, causing Telegram to redeliver the update; Telegram
flood-control deadlines remain stored in KV so early redeliveries do not consume the failure
budget. Assistant text enters conversation history only after Telegram accepts it. Permanent
Telegram failures and repeated actual failures are terminalized.

The bot intentionally has no periodic cron task, allowing an idle Deno Deploy runtime to
scale down without consuming memory time. Exactly-once external delivery cannot be
guaranteed across a crash between Telegram accepting a message and KV recording that
acceptance, but the remaining retry windows are explicitly minimized.

For strict EU-only data residency, note that Deno documents current Deno KV data as stored
primarily in Northern Virginia and transiting the US.

## Development

```bash
deno task test
deno task check
deno task fmt
```

Relevant platform references:

- [New Deno Deploy migration guide](https://docs.deno.com/deploy/migration_guide/)
- [Deno Deploy KV](https://docs.deno.com/deploy/reference/deno_kv/)
- [Deno Deploy runtime lifecycle](https://docs.deno.com/deploy/reference/runtime/)
- [Telegram Bot API `setWebhook`](https://core.telegram.org/bots/api#setwebhook)
