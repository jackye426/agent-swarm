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

  const send = async (parseMode?: "Markdown"): Promise<Response> =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

  try {
    let response = await send("Markdown");

    if (response.status === 400) {
      // Legacy Markdown treats any lone `_` or `*` as an unclosed entity —
      // task statuses (IN_PROGRESS), queue names, and env vars all trip it.
      // Delivery beats formatting: retry as plain text.
      const body = (await response.text()).slice(0, 200);
      if (/can't parse entities/i.test(body)) {
        response = await send();
      } else {
        return { ok: false, message: `Telegram sendMessage returned 400: ${body}` };
      }
    }

    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      return { ok: false, message: `Telegram sendMessage returned ${response.status}: ${body}` };
    }
    return { ok: true, message: "sent" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
