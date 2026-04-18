/**
 * Waitlist-confirmation keyword detector.
 *
 * Mirrors the STOP-handler pattern, but for *opt-in* to a pre-launch
 * waitlist (store launch, paid services). We deliberately do NOT match
 * generic confirmations like "sim" / "yes" — those are too ambiguous
 * mid-conversation. Instead, the agent's CLAUDE.md tells users:
 *
 *    "Responda *AVISAR* para entrar na lista de espera"
 *
 * and this detector matches only the specific keywords. Price of being
 * explicit: one extra line of copy in the agent reply. Benefit: no
 * ambiguity, zero false positives from a user saying "sim, pode enviar
 * amanhã" in an unrelated context.
 *
 * Pure function, no I/O.
 */

export type WaitlistLanguage = 'pt-BR' | 'en' | 'es';

export interface WaitlistDetection {
  isConfirmation: boolean;
  keyword: string | null;
  language: WaitlistLanguage | null;
  confidence: number;
}

// Keywords per language. Uppercase; input is normalized the same way.
const KEYWORDS_PT_BR = ['AVISAR', 'AVISE', 'AVISA', 'NOTIFICAR', 'NOTIFIQUE'];
const KEYWORDS_EN = ['NOTIFY', 'WAITLIST', 'SUBSCRIBE'];
const KEYWORDS_ES = ['APUNTAR', 'AVISAME', 'AVISENME'];

const ALL: Array<{ keyword: string; language: WaitlistLanguage }> = [
  ...KEYWORDS_PT_BR.map((k) => ({ keyword: k, language: 'pt-BR' as const })),
  ...KEYWORDS_EN.map((k) => ({ keyword: k, language: 'en' as const })),
  ...KEYWORDS_ES.map((k) => ({ keyword: k, language: 'es' as const })),
];

function normalize(input: string): string {
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
 * Detect an explicit waitlist confirmation.
 *
 * Rules:
 *   - Single-token exact match → confidence 1.0
 *   - Short message (≤ 4 tokens) containing the keyword → confidence 0.85
 *   - Anything longer → 0 (too much context; could be narrative)
 *
 * Returns `isConfirmation: true` only at confidence ≥ 0.85.
 */
export function detectWaitlistConfirmation(body: string): WaitlistDetection {
  if (!body || typeof body !== 'string') {
    return {
      isConfirmation: false,
      keyword: null,
      language: null,
      confidence: 0,
    };
  }
  const normalized = normalize(body);
  if (normalized.length === 0) {
    return {
      isConfirmation: false,
      keyword: null,
      language: null,
      confidence: 0,
    };
  }
  const tokens = tokenize(normalized);

  let best: WaitlistDetection = {
    isConfirmation: false,
    keyword: null,
    language: null,
    confidence: 0,
  };

  for (const { keyword, language } of ALL) {
    if (!tokens.includes(keyword)) continue;
    let confidence = 0;
    if (tokens.length === 1) {
      confidence = 1.0;
    } else if (tokens.length <= 4) {
      confidence = 0.85;
    } else {
      confidence = 0;
    }
    if (confidence > best.confidence) {
      best = {
        isConfirmation: confidence >= 0.85,
        keyword,
        language,
        confidence,
      };
    }
  }

  return best;
}

/**
 * Localized waitlist-add confirmation. Short — fits an SMS, safe for WhatsApp.
 */
export function waitlistAddedMessage(
  language: WaitlistLanguage | null,
  context: { businessName: string; productLabel?: string },
): string {
  const product = context.productLabel ?? 'a lista de espera';
  switch (language) {
    case 'pt-BR':
      return `Você entrou em ${product} da ${context.businessName}. Vamos te avisar primeiro quando abrir.`;
    case 'es':
      return `Te apuntamos a ${product} de ${context.businessName}. Te avisaremos primero cuando abra.`;
    case 'en':
    default:
      return `You're on ${context.businessName}'s waitlist. We'll notify you first when it opens.`;
  }
}
