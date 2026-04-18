/**
 * Inbound opt-out orchestrator.
 *
 * Plugs the detector + the CRM together. The webhook calls this for every
 * inbound message; if the message is an opt-out, the contact is recorded as
 * such and a localized confirmation string is returned for the caller to
 * send back through the existing reply path.
 *
 * Idempotent: calling it on a contact who is already opted out returns
 * `actedOn: false` with reason `already-opted-out` — the caller can skip
 * the confirmation so we don't spam the user.
 */
import {
  ContactChannel,
  ContactRecord,
  getContact,
  optOut,
  upsertContact,
} from './contacts.js';
import {
  confirmationMessage,
  detectOptOut,
  OptOutDetection,
  OptOutLanguage,
} from './opt-out-detector.js';

export interface InboundOptOutInput {
  businessSlug: string;
  channel: ContactChannel;
  phone: string;
  body: string;
}

export interface InboundOptOutResult {
  /** True when we recorded a new opt-out on this call. */
  actedOn: boolean;
  /** Short machine-readable reason when actedOn is false. */
  reason?: 'not-opt-out' | 'already-opted-out' | 'low-confidence';
  detection: OptOutDetection;
  /** Contact after the opt-out, when actedOn is true. */
  contact?: ContactRecord;
  /** Send this string back to the user on actedOn=true. Omit on false. */
  confirmationMessage?: string;
}

/**
 * Detect + record opt-out from an inbound message. Safe to call on every
 * inbound — it early-returns when the body doesn't look like an opt-out.
 *
 * Side effects:
 *   - Calls `upsertContact` if the contact didn't exist (so we have a row
 *     to attach the opt-out to). Covers the case where the user's first
 *     ever message is "STOP" — we still log it.
 *   - Calls `optOut` on the CRM row.
 *
 * Returns a `confirmationMessage` localized to the detected (or stored)
 * language; the caller passes it back via the existing reply path.
 */
export function handleInboundOptOut(
  input: InboundOptOutInput,
): InboundOptOutResult {
  const detection = detectOptOut(input.body);
  if (!detection.isOptOut) {
    return { actedOn: false, reason: 'not-opt-out', detection };
  }

  const existing = getContact(input.businessSlug, input.channel, input.phone);

  // Already opted out — no-op + don't re-confirm, so we don't spam.
  if (existing?.optedOutAt) {
    return { actedOn: false, reason: 'already-opted-out', detection };
  }

  // Make sure a row exists so optOut has something to update.
  if (!existing) {
    upsertContact({
      businessSlug: input.businessSlug,
      channel: input.channel,
      phone: input.phone,
    });
  }

  const reason = detection.keyword
    ? `inbound:${detection.keyword.toLowerCase()}`
    : 'inbound:opt-out';

  const contact = optOut({
    businessSlug: input.businessSlug,
    channel: input.channel,
    phone: input.phone,
    reason,
  });

  // Prefer the stored language (most specific); fall back to detection.
  const language: OptOutLanguage | null = resolveLanguage(
    contact.language,
    detection.language,
  );

  return {
    actedOn: true,
    detection,
    contact,
    confirmationMessage: confirmationMessage(language),
  };
}

function resolveLanguage(
  stored: string | null,
  detected: OptOutLanguage | null,
): OptOutLanguage | null {
  // Stored language may be a longer locale like "pt-BR" or "pt" or "en-GB".
  // Match on the language prefix.
  if (stored) {
    const lower = stored.toLowerCase();
    if (lower.startsWith('pt')) return 'pt-BR';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
  }
  return detected;
}
