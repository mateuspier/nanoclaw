/**
 * Payment checkout — provider-agnostic types.
 *
 * V1 goal: given a business + product + (optional) contact, produce a
 * checkout URL the user can click to pay. Keep the interface narrow so
 * we can plug additional providers (Revolut, PIX via Mercado Pago, PayPal)
 * later without rewriting callers.
 *
 * Scope deliberately excludes:
 *   - Payment-success webhooks (separate work — needs a signed endpoint)
 *   - Subscription management (upgrade/downgrade/cancel flows)
 *   - Refunds
 * All of the above are separate concerns and should ride on top of this
 * base once the first happy-path sale is live.
 */

export type Currency =
  | 'EUR'
  | 'USD'
  | 'BRL'
  | 'GBP';

export type PaymentMode =
  /** Single charge. Used for guides, one-off consultations, ticketed events. */
  | 'one_time'
  /** Recurring monthly. Drops Preview (MiauPop), Weekly Digest Premium (SDI). */
  | 'subscription_monthly'
  /** Recurring annual. Same but 12-month. */
  | 'subscription_annual';

/**
 * Minimum shape of a product in the registry. Kept intentionally flat —
 * provider-specific fields (Stripe price ID, Revolut merchant order ref) live
 * in `providerRefs` so the core registry stays portable.
 */
export interface Product {
  /** Stable key. Part of URLs / analytics. e.g. "guia-cork", "drops-preview". */
  key: string;
  businessSlug: string;
  title: string;
  /** Short human description for the agent to include in its pitch. */
  description: string;
  mode: PaymentMode;
  priceCents: number;
  currency: Currency;
  /** Agent-visible pitch line. Plain text, < 120 chars preferred. */
  pitchLine?: string;
  /**
   * Provider-specific identifiers. Each provider plugin looks up its own
   * key here. Shape is intentionally loose — we validate at the provider
   * boundary, not in the registry.
   */
  providerRefs: Record<string, string>;
  /** `true` when the product is live and can be sold. Default `false`. */
  active: boolean;
}

/**
 * Input to `createCheckout` — what the caller needs to supply to get a URL.
 */
export interface CheckoutRequest {
  businessSlug: string;
  productKey: string;
  /**
   * Optional — when present, the URL carries this as a `client_reference_id`
   * so Stripe's webhook can attribute the payment back to the contact in
   * our CRM. Pass `null` if unknown (anonymous purchase from website).
   */
  contactId?: number | null;
  /**
   * Free-form metadata stored alongside the checkout. e.g. the broadcast
   * ID that drove the click, the referring URL, a utm_campaign. Provider
   * surfaces this on its webhook for attribution.
   */
  metadata?: Record<string, string>;
  /**
   * Where to send the user after a successful payment. Provider will
   * append its own session id to this URL.
   */
  successUrl: string;
  /**
   * Where to send the user if they abandon checkout. Defaults to successUrl
   * if omitted.
   */
  cancelUrl?: string;
}

export interface CheckoutResult {
  /** The URL to hand to the user. */
  url: string;
  /** Provider's session id — useful for logging/attribution. */
  sessionId: string;
  /** Which provider served this. */
  provider: 'stripe' | 'revolut' | 'mock';
  /** When the link expires (ISO). Providers typically cap at 24 h. */
  expiresAt: string;
}

export class PaymentError extends Error {
  constructor(
    public readonly code:
      | 'no-api-key'
      | 'unknown-business'
      | 'unknown-product'
      | 'product-inactive'
      | 'invalid-price'
      | 'missing-provider-ref'
      | 'provider-error'
      | 'invalid-url',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

/**
 * What every provider plugin must implement. Keep it tiny — callers
 * orchestrate through `checkout.ts`, not directly.
 */
export interface PaymentProvider {
  readonly name: 'stripe' | 'revolut' | 'mock';
  createCheckoutSession(params: {
    product: Product;
    request: CheckoutRequest;
  }): Promise<CheckoutResult>;
}
