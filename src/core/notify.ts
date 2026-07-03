/**
 * Shared Telegram notification sender.
 *
 * Used by both the intake server (bot replies / Realtime forwarding) and the
 * standalone watchdog. Talks to the Telegram HTTP API directly with fetch so
 * consumers do not need to import the grammy bot (which throws at import time
 * when TELEGRAM_BOT_TOKEN is unset).
 *
 * Reads env at call time: safe to import in any process regardless of config.
 */

export interface NotifyResult {
  ok: boolean;
  message: string;
}

export async function sendTelegramMessage(text: string): Promise<NotifyResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  if (!token || !chatId) {
    return { ok: false, message: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured" };
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      return { ok: false, message: `Telegram sendMessage returned ${response.status}: ${body}` };
    }
    return { ok: true, message: "sent" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
