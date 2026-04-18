/**
 * Inbound waitlist-opt-in orchestrator.
 *
 * Plugs the detector + the CRM together. The webhook calls this for every
 * inbound message (after the STOP handler has had its say); if the message
 * is an explicit waitlist confirmation, the contact is tagged with the
 * caller-chosen tag and opted-in for the `utility` purpose (so the
 * broadcast engine can reach them with a launch announcement).
 */
import {
  ContactChannel,
  ContactPurpose,
  ContactRecord,
  addTag,
  getContact,
  optIn,
  upsertContact,
} from './contacts.js';
import {
  WaitlistDetection,
  WaitlistLanguage,
  detectWaitlistConfirmation,
  waitlistAddedMessage,
} from './waitlist-detector.js';

export interface InboundWaitlistInput {
  businessSlug: string;
  channel: ContactChannel;
  phone: string;
  body: string;
  /** Tag to apply on success, e.g. "store-waitlist" or "services-waitlist". */
  waitlistTag: string;
  /** Human-readable business name for the confirmation reply. */
  businessName: string;
  /** Short product / list label for the confirmation copy. */
  productLabel?: string;
  /**
   * Which purpose to opt the contact into. Default `utility` — a launch
   * announcement is a utility message under WhatsApp's categorization
   * (informing the user about something they asked for), not marketing.
   */
  purpose?: ContactPurpose;
}

export interface InboundWaitlistResult {
  actedOn: boolean;
  reason?:
    | 'not-confirmation'
    | 'already-on-waitlist'
    | 'opted-out'
    | 'low-confidence';
  detection: WaitlistDetection;
  contact?: ContactRecord;
  confirmationMessage?: string;
}

/**
 * Detect + record a waitlist confirmation. Safe to call on every inbound —
 * early-returns when the body doesn't look like a waitlist keyword.
 *
 * Effects on actedOn=true:
 *   - Creates the contact row if missing (first-touch waitlist is common).
 *   - Calls `optIn` for the chosen purpose (default `utility`).
 *   - Adds `waitlistTag` to the contact's tag set.
 *   - Returns a localized confirmation string for the webhook to send back.
 *
 * Never overrides an opt-out. If the contact previously sent STOP, we
 * deliberately don't re-opt-them-in from a single AVISAR — that would be a
 * compliance landmine. Return `reason: 'opted-out'` so the webhook can
 * handle it (probably: ignore the message; operator reviews if it matters).
 */
export function handleInboundWaitlist(
  input: InboundWaitlistInput,
): InboundWaitlistResult {
  const detection = detectWaitlistConfirmation(input.body);
  if (!detection.isConfirmation) {
    return { actedOn: false, reason: 'not-confirmation', detection };
  }

  const existing = getContact(input.businessSlug, input.channel, input.phone);

  // Never lift a prior opt-out via a single waitlist keyword.
  if (existing?.optedOutAt) {
    return { actedOn: false, reason: 'opted-out', detection };
  }

  // Already on the list — no-op. Don't re-confirm (avoid spam loops).
  if (existing?.tags?.includes(input.waitlistTag)) {
    return { actedOn: false, reason: 'already-on-waitlist', detection };
  }

  // Create row if missing so optIn has something to update.
  if (!existing) {
    upsertContact({
      businessSlug: input.businessSlug,
      channel: input.channel,
      phone: input.phone,
    });
  }

  const purpose = input.purpose ?? 'utility';
  // If the contact is already opted-in, optIn() will add the purpose;
  // if not, it records a fresh opt-in with this purpose.
  const existingPurposes = existing?.purposes ?? [];
  const mergedPurposes = Array.from(new Set([...existingPurposes, purpose]));
  optIn({
    businessSlug: input.businessSlug,
    channel: input.channel,
    phone: input.phone,
    source: `waitlist:${input.waitlistTag}`,
    purposes: mergedPurposes,
  });

  const contact = addTag(
    input.businessSlug,
    input.channel,
    input.phone,
    input.waitlistTag,
  );

  const language: WaitlistLanguage | null = resolveLanguage(
    contact.language,
    detection.language,
  );
  const confirmationMessage = waitlistAddedMessage(language, {
    businessName: input.businessName,
    productLabel: input.productLabel,
  });

  return { actedOn: true, detection, contact, confirmationMessage };
}

function resolveLanguage(
  stored: string | null,
  detected: WaitlistLanguage | null,
): WaitlistLanguage | null {
  if (stored) {
    const lower = stored.toLowerCase();
    if (lower.startsWith('pt')) return 'pt-BR';
    if (lower.startsWith('es')) return 'es';
    if (lower.startsWith('en')) return 'en';
  }
  return detected;
}
