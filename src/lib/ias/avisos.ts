/**
 * Envío de emails con Resend (https://resend.com) y, opcionalmente, del lead a un webhook
 * (Google Sheets con Apps Script, Make, Zapier, n8n...). Sin claves configuradas no se envía nada.
 */
import { env } from "./red.ts";

export function emailConfigurado(): boolean {
  return Boolean(env("RESEND_API_KEY") && env("EMAIL_REMITENTE"));
}

export async function enviarEmail(destino: string, asunto: string, texto: string, responderA?: string): Promise<boolean> {
  if (!emailConfigurado()) return false;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env("EMAIL_REMITENTE"), to: [destino], subject: asunto, text: texto,
        ...(responderA ? { reply_to: responderA } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) console.error("Resend:", r.status, await r.text());
    return r.ok;
  } catch (e) {
    console.error("Resend:", e);
    return false;
  }
}

export async function enviarWebhook(datos: Record<string, unknown>): Promise<void> {
  const url = env("LEADS_WEBHOOK_URL");
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(datos),
      signal: AbortSignal.timeout(10000) });
  } catch (e) {
    console.error("Webhook de leads:", e);
  }
}
