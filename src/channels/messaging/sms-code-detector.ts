/**
 * SMS verification-code detector.
 *
 * Every active business has a Twilio SMS number that's used to sign the
 * business up for third-party services (WhatsApp Business, Stripe, PayPal,
 * Meta Ads). Those services send verification codes via SMS. Without
 * detection, the code just gets logged alongside customer conversations in
 * Telegram and is easy to miss.
 *
 * This module pattern-matches inbound SMS bodies against common verification
 * shapes and returns a structured signal callers can use to raise a
 * prominent alert (Telegram pin, separate channel, push, etc.).
 *
 * Pure function. No I/O, no side effects.
 */

export interface CodeDetection {
  /** The extracted code (digits only, no separators). Null if no code found. */
  code: string | null;
  /** 0–1: how confident we are it's a verification code (not a tracking number). */
  confidence: number;
  /** Service name inferred from the body (WhatsApp, Stripe, Meta, etc.), if any. */
  service: string | null;
  /** Reason(s) the pattern matched, useful for logs + tuning. */
  signals: string[];
}

// Common service keywords → canonical service name.
const SERVICE_HINTS: Array<[RegExp, string]> = [
  [/\bwhatsapp\b/i, 'WhatsApp'],
  [/\bmeta\b/i, 'Meta'],
  [/\bfacebook\b/i, 'Facebook'],
  [/\binstagram\b/i, 'Instagram'],
  [/\bstripe\b/i, 'Stripe'],
  [/\bpaypal\b/i, 'PayPal'],
  [/\brevolut\b/i, 'Revolut'],
  [/\bwise\b/i, 'Wise'],
  [/\btwilio\b/i, 'Twilio'],
  [/\bsendgrid\b/i, 'SendGrid'],
  [/\bgoogle\b/i, 'Google'],
  [/\bmicrosoft\b/i, 'Microsoft'],
  [/\bapple\b/i, 'Apple'],
  [/\bdiscord\b/i, 'Discord'],
  [/\bslack\b/i, 'Slack'],
  [/\btelegram\b/i, 'Telegram'],
  [/\bsignal\b/i, 'Signal'],
  [/\bvercel\b/i, 'Vercel'],
  [/\bcloudflare\b/i, 'Cloudflare'],
  [/\buber\b/i, 'Uber'],
  [/\bairbnb\b/i, 'Airbnb'],
  [/\bshopify\b/i, 'Shopify'],
];

// Phrases that strongly signal "this is a verification SMS".
const VERIFICATION_PHRASES: RegExp[] = [
  /\b(c[oó]digo|code|pin|otp|passcode|senha)\b/i,
  /\bverif(y|ication|icar)\b/i,
  /\b(confirm|confirme|confirmar)\b/i,
  /\bauthenticat/i,
  /\b(sign[\s-]?in|login|log[\s-]?in)\b/i,
  /\btwo[\s-]?factor\b/i,
  /\b2fa\b/i,
];

// Anti-signals — patterns that usually mean "this is not a code".
const ANTI_SIGNALS: RegExp[] = [
  /\b(tracking|rastre|entrega|shipment|pedido)\b/i,
  /\b(ticket|reserva|booking)\b/i,
  /\b(pagamento|payment|invoice|fatura|total|R\$|€|\$)/i, // money amounts
];

/**
 * Detect a verification code in an SMS body.
 *
 * Returns `code: null` + `confidence: 0` when no plausible code is found.
 * Confidence tiers (rule-of-thumb):
 *   ≥ 0.8  — strong: verification phrase AND a digit group of 4–8 chars
 *   ≥ 0.5  — medium: either phrase or digit group alone, no anti-signals
 *   < 0.5  — weak/none
 *
 * Callers should alert loudly on ≥ 0.8 and subtly on 0.5–0.8.
 */
export function detectVerificationCode(body: string): CodeDetection {
  if (!body || typeof body !== 'string') {
    return { code: null, confidence: 0, service: null, signals: [] };
  }
  const signals: string[] = [];

  // Anti-signal: money amounts / tracking look like codes but aren't.
  const isAntiSignal = ANTI_SIGNALS.some((re) => re.test(body));
  if (isAntiSignal) {
    signals.push('anti-signal');
  }

  const hasVerificationPhrase = VERIFICATION_PHRASES.some((re) => re.test(body));
  if (hasVerificationPhrase) signals.push('verification-phrase');

  // Digit group: 4–8 consecutive digits, optionally split by `-` or ` `.
  // We reject ≥ 9 digits (phone numbers, order IDs).
  const digitMatch =
    body.match(/\b(\d{3}[\s-]?\d{3})\b/) ?? // 123-456 or 123 456 (6-digit codes, the common case)
    body.match(/\b(\d{4,8})\b/); // 4–8 consecutive digits

  let code: string | null = null;
  if (digitMatch) {
    const raw = digitMatch[1];
    const digitsOnly = raw.replace(/[\s-]/g, '');
    if (digitsOnly.length >= 4 && digitsOnly.length <= 8) {
      code = digitsOnly;
      signals.push(`digits:${digitsOnly.length}`);
    }
  }

  let service: string | null = null;
  for (const [re, name] of SERVICE_HINTS) {
    if (re.test(body)) {
      service = name;
      signals.push(`service:${name.toLowerCase()}`);
      break;
    }
  }

  // Score.
  let confidence = 0;
  if (code) confidence += 0.4;
  if (hasVerificationPhrase) confidence += 0.4;
  if (service) confidence += 0.15;
  // Short bodies (< 140 chars) with a code are almost always verifications.
  if (code && body.length <= 140) confidence += 0.15;
  // Anti-signals penalize heavily.
  if (isAntiSignal) confidence = Math.max(0, confidence - 0.5);
  // Clamp.
  if (confidence > 1) confidence = 1;

  // Return code only when confidence clears the medium bar.
  if (confidence < 0.5) {
    return { code: null, confidence, service: null, signals };
  }

  return { code, confidence, service, signals };
}

/**
 * Format a Telegram-friendly alert for a detected code. The output is a single
 * string using Telegram's HTML parse mode (escape-safe for the fields we pass).
 */
export function formatCodeAlert(input: {
  businessSlug: string;
  businessName: string;
  fromNumber: string;
  body: string;
  detection: CodeDetection;
}): string {
  const { businessSlug, businessName, fromNumber, body, detection } = input;
  const tier = detection.confidence >= 0.8 ? '🔐' : detection.confidence >= 0.5 ? '🔎' : 'ℹ️';
  const lines = [
    `${tier} <b>SMS verification code</b> — [${businessSlug}] ${businessName}`,
    `from <code>${escapeHtml(fromNumber)}</code>${detection.service ? ` · service: <b>${detection.service}</b>` : ''}`,
    '',
    `code: <code>${detection.code ?? '—'}</code>  confidence: ${detection.confidence.toFixed(2)}`,
    '',
    `<i>${escapeHtml(body.slice(0, 500))}</i>`,
  ];
  return lines.join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
