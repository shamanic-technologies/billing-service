/**
 * Owner Telegram messages: a plain `sendMessage` to the Bot API, HTML parse mode.
 * Same bot and chat the dashboard's visit recap uses (`TELEGRAM_BOT_TOKEN`,
 * `TELEGRAM_OWNER_CHAT_ID`, in the service's env file on the box).
 *
 * Never throws: an owner notification must never fail the money path that
 * triggered it. Every failure is returned AND logged loudly by the caller.
 */

const SEND_TIMEOUT_MS = 10_000;

export interface TelegramConfig {
  token: string;
  chatId: string;
}

export function getTelegramConfig(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** Loud boot warning when the owner alerts cannot be sent. Never crashes the boot. */
export function warnIfTelegramUnconfigured(): void {
  if (!getTelegramConfig()) {
    console.warn(
      "[billing-service] TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not set: the owner will NOT be told when a customer pays"
    );
  }
}

export type TelegramSendResult =
  | { ok: true; messageId: number | null }
  | { ok: false; error: string };

export async function sendOwnerTelegram(html: string): Promise<TelegramSendResult> {
  const config = getTelegramConfig();
  if (!config) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID not configured" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; description?: string; result?: { message_id?: number } }
      | null;
    if (!res.ok || body?.ok !== true) {
      return { ok: false, error: `telegram ${res.status}: ${body?.description ?? "no body"}` };
    }
    return { ok: true, messageId: body.result?.message_id ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Escape a value interpolated into an HTML-mode message (customer-typed names). */
export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
