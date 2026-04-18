/**
 * Opt-out keyword detector.
 *
 * Recognizes the standard "stop" messages in pt-BR, en, and es and returns a
 * structured decision. Used by the webhook to turn inbound "STOP" / "PARE"
 * / "BAJA" into a CRM `optOut()` call + a localized confirmation reply.
 *
 * Pure function. No I/O, no side effects.
 *
 * WhatsApp (via Twilio) does NOT auto-handle opt-out keywords — we have to
 * implement it ourselves for compliance. Twilio's built-in SMS auto-opt-out
 * handles STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT at the carrier
 * level in the US; even then we still want to record it in our CRM so the
 * broadcast segment skips them. Calling this from the webhook covers both
 * channels uniformly.
 */

export type OptOutLanguage = 'pt-BR' | 'en' | 'es';

export interface OptOutDetection {
  isOptOut: boolean;
  /** The keyword we matched (normalized uppercase), null when no match. */
  keyword: string | null;
  language: OptOutLanguage | null;
  /**
   * 0–1. 1.0 for bare-word opt-outs ("STOP"). Decays when surrounded by
   * other words that suggest context rather than command ("stop the war").
   */
  confidence: number;
}

// Keywords, grouped by language. Normalized to uppercase; we normalize input.
const KEYWORDS_PT_BR = [
  'PARE',
  'PARAR',
  'SAIR',
  'SAI',
  'CANCELAR',
  'CANCELA',
  'DESCADASTRAR',
  'DESINSCREVER',
  'REMOVA',
  'REMOVER',
];

const KEYWORDS_EN = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'END',
  'QUIT',
  'CANCEL',
  'REMOVE',
];

const KEYWORDS_ES = [
  'BAJA',
  'PARA', // ambiguous with preposition; handled via length guard below
  'CANCELAR',
];

const ALL: Array<{ keyword: string; language: OptOutLanguage }> = [
  ...KEYWORDS_PT_BR.map((k) => ({ keyword: k, language: 'pt-BR' as const })),
  ...KEYWORDS_EN.map((k) => ({ keyword: k, language: 'en' as const })),
  ...KEYWORDS_ES.map((k) => ({ keyword: k, language: 'es' as const })),
];

// Ambiguous keywords that require a bare-word (or near-bare) match to count.
// "para" alone = opt-out; "para mim" or "para você" = preposition.
// "remove" alone = opt-out; "remove me" or "remove from list" also qualify;
// "remove the reservation" should not.
const AMBIGUOUS = new Set(['PARA', 'REMOVE', 'END', 'CANCEL']);

/**
 * Normalize an inbound body for keyword matching:
 *   - lowercase → uppercase
 *   - strip accents (é → e, ã → a)
 *   - collapse whitespace
 *   - strip punctuation
 */
export function normalizeBody(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,;:!?'"()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function tokenize(normalized: string): string[] {
  return normalized.split(' ').filter((t) => t.length > 0);
}

/**
 * Detect an opt-out keyword. Conservative by design — we prefer to miss a
 * legitimate opt-out (which the user will retry) over to falsely mark a
 * paying customer as opted out. High-confidence only.
 *
 * Rules:
 *   - Single-token exact match (e.g. "STOP", "PARE") → confidence 1.0
 *   - 2–4 token message with a keyword in it → confidence 0.85
 *   - Keyword in a longer message (≥ 5 tokens) → confidence 0.0 unless
 *     the surrounding tokens are themselves opt-out-adjacent ("remove me
 *     from list"). Kept simple: we just bail on long messages.
 *   - Ambiguous keywords (PARA, REMOVE, END, CANCEL) require bare-word
 *     or ≤ 2-token message.
 */
export function detectOptOut(body: string): OptOutDetection {
  if (!body || typeof body !== 'string') {
    return { isOptOut: false, keyword: null, language: null, confidence: 0 };
  }
  const normalized = normalizeBody(body);
  if (normalized.length === 0) {
    return { isOptOut: false, keyword: null, language: null, confidence: 0 };
  }
  const tokens = tokenize(normalized);

  // Best match wins: prefer non-ambiguous, prefer shorter message.
  let best: OptOutDetection = {
    isOptOut: false,
    keyword: null,
    language: null,
    confidence: 0,
  };

  for (const { keyword, language } of ALL) {
    if (!tokens.includes(keyword)) continue;

    const ambiguous = AMBIGUOUS.has(keyword);
    let confidence = 0;
    if (tokens.length === 1) {
      confidence = 1.0;
    } else if (tokens.length <= 4 && !ambiguous) {
      confidence = 0.85;
    } else if (tokens.length <= 2 && ambiguous) {
      confidence = 0.85;
    } else {
      // Too long / too ambiguous — bail. Some examples we want to miss:
      //   "por favor, não pare de enviar"
      //   "stop by tomorrow to pick up"
      //   "cancel the reservation I made"
      confidence = 0;
    }

    if (confidence > best.confidence) {
      best = {
        isOptOut: confidence >= 0.85,
        keyword,
        language,
        confidence,
      };
    }
  }

  return best;
}

/**
 * Localized opt-out confirmation. Falls back to English if we don't know
 * the language. Intentionally short — SMS-friendly, safe for WhatsApp.
 */
export function confirmationMessage(language: OptOutLanguage | null): string {
  switch (language) {
    case 'pt-BR':
      return 'Você foi descadastrado. Responda ENTRAR a qualquer momento para reativar.';
    case 'es':
      return 'Te diste de baja. Responde ALTA para reactivar.';
    case 'en':
    default:
      return 'You have been unsubscribed. Reply JOIN anytime to re-subscribe.';
  }
}
