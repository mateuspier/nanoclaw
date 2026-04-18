/**
 * Stripe checkout-session provider.
 *
 * Calls Stripe's /v1/checkout/sessions endpoint and returns the hosted
 * checkout URL. Supports one_time + recurring-price modes via
 * product.mode. Recurring prices MUST already be configured in Stripe
 * with the matching price_id + interval; we don't create prices here.
 *
 * HTTP client is injectable — tests substitute a stub. The real client is
 * a tiny keep-alive https.request wrapper, same pattern as
 * outbound-twilio.ts.
 */
import https from 'https';

import {
  CheckoutRequest,
  CheckoutResult,
  PaymentError,
  PaymentProvider,
  Product,
} from './types.js';

// ── Transport ────────────────────────────────────────────────────────────

export interface StripeTransport {
  post(
    path: string,
    form: URLSearchParams,
  ): Promise<{ status: number; text: string }>;
}

export function createStripeTransport(secretKey: string): StripeTransport {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });
  return {
    post(path, form) {
      const payload = form.toString();
      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.stripe.com',
            path,
            method: 'POST',
            auth: `${secretKey}:`,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(payload),
            },
            agent,
          },
          (res) => {
            let text = '';
            res.on('data', (c: Buffer) => (text += c.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    },
  };
}

// ── Validation ───────────────────────────────────────────────────────────

const URL_RE = /^https?:\/\/[^\s]+$/;

function assertValidUrl(name: 'successUrl' | 'cancelUrl', url: string): void {
  if (!URL_RE.test(url)) {
    throw new PaymentError('invalid-url', `${name} must be absolute http(s): got "${url}"`);
  }
}

function priceIdFor(product: Product): string {
  const id = product.providerRefs.stripe_price_id;
  if (!id) {
    throw new PaymentError(
      'missing-provider-ref',
      `product ${product.key} has no providerRefs.stripe_price_id — create a Price in Stripe + fill it in`,
    );
  }
  return id;
}

function stripeMode(product: Product): 'payment' | 'subscription' {
  return product.mode === 'one_time' ? 'payment' : 'subscription';
}

// ── Form builder (exported for tests) ─────────────────────────────────────

/**
 * Build the URL-encoded form body for the Stripe API call. Pure; no I/O.
 * Exposed so tests can verify what we send without stubbing HTTP.
 */
export function buildStripeSessionForm(
  product: Product,
  request: CheckoutRequest,
): URLSearchParams {
  assertValidUrl('successUrl', request.successUrl);
  if (request.cancelUrl) assertValidUrl('cancelUrl', request.cancelUrl);

  const form = new URLSearchParams();
  form.set('mode', stripeMode(product));
  form.set('success_url', appendSessionIdTemplate(request.successUrl));
  form.set('cancel_url', request.cancelUrl ?? request.successUrl);
  form.set('line_items[0][price]', priceIdFor(product));
  form.set('line_items[0][quantity]', '1');

  if (request.contactId !== undefined && request.contactId !== null) {
    form.set('client_reference_id', String(request.contactId));
  }

  const metadataEntries = Object.entries(request.metadata ?? {});
  metadataEntries.push(
    ['business_slug', product.businessSlug],
    ['product_key', product.key],
  );
  for (const [k, v] of metadataEntries) {
    form.set(`metadata[${k}]`, String(v));
  }

  return form;
}

/**
 * If the caller's successUrl doesn't already carry Stripe's {CHECKOUT_SESSION_ID}
 * placeholder, append one so webhook-less confirmation pages can still read
 * the session id. Idempotent.
 */
function appendSessionIdTemplate(url: string): string {
  if (url.includes('{CHECKOUT_SESSION_ID}')) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}session_id={CHECKOUT_SESSION_ID}`;
}

// ── Provider ──────────────────────────────────────────────────────────────

export interface StripeProviderOptions {
  secretKey?: string;
  transport?: StripeTransport;
}

/**
 * Build a Stripe provider. Either pass `secretKey` and we'll create the
 * transport, or pass a pre-built `transport` (tests).
 */
export function createStripeProvider(opts: StripeProviderOptions): PaymentProvider {
  if (!opts.transport && !opts.secretKey) {
    throw new PaymentError(
      'no-api-key',
      'createStripeProvider: provide secretKey or transport',
    );
  }
  const transport = opts.transport ?? createStripeTransport(opts.secretKey!);

  return {
    name: 'stripe',
    async createCheckoutSession({ product, request }) {
      const form = buildStripeSessionForm(product, request);
      const { status, text } = await transport.post(
        '/v1/checkout/sessions',
        form,
      );
      if (status >= 400) {
        let message = text;
        try {
          const parsed = JSON.parse(text);
          message = parsed?.error?.message ?? text;
        } catch {
          /* keep raw */
        }
        throw new PaymentError('provider-error', `Stripe ${status}: ${message}`, status);
      }
      let parsed: {
        id: string;
        url: string;
        expires_at: number;
      };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new PaymentError(
          'provider-error',
          `Stripe ${status} returned non-JSON: ${text.slice(0, 120)}`,
          status,
        );
      }

      return {
        url: parsed.url,
        sessionId: parsed.id,
        provider: 'stripe',
        // Stripe returns expires_at as unix seconds.
        expiresAt: new Date(parsed.expires_at * 1000).toISOString(),
      };
    },
  };
}
