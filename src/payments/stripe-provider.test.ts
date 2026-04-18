import { describe, it, expect, vi } from 'vitest';

import {
  buildStripeSessionForm,
  createStripeProvider,
  StripeTransport,
} from './stripe-provider.js';
import { Product, PaymentError } from './types.js';

const product: Product = {
  key: 'guia-cork',
  businessSlug: 'biz-ie-01',
  title: 'Guia',
  description: '',
  mode: 'one_time',
  priceCents: 900,
  currency: 'EUR',
  providerRefs: { stripe_price_id: 'price_123' },
  active: true,
};

// ── buildStripeSessionForm ────────────────────────────────────────────────

describe('buildStripeSessionForm', () => {
  it('builds a one-time payment form with line item + metadata', () => {
    const form = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://soudairlanda.com/thanks',
    });
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][price]')).toBe('price_123');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('metadata[business_slug]')).toBe('biz-ie-01');
    expect(form.get('metadata[product_key]')).toBe('guia-cork');
    // cancel_url defaults to successUrl
    expect(form.get('cancel_url')).toBe('https://soudairlanda.com/thanks');
  });

  it('picks subscription mode for recurring products', () => {
    const sub: Product = { ...product, mode: 'subscription_monthly' };
    const form = buildStripeSessionForm(sub, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/ok',
    });
    expect(form.get('mode')).toBe('subscription');
  });

  it('appends {CHECKOUT_SESSION_ID} to the success URL when absent', () => {
    const form = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/ok',
    });
    expect(form.get('success_url')).toBe('https://x.com/ok?session_id={CHECKOUT_SESSION_ID}');
  });

  it('uses "&" when success URL already has a query string', () => {
    const form = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/ok?utm=email',
    });
    expect(form.get('success_url')).toBe(
      'https://x.com/ok?utm=email&session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it('leaves success URL alone if caller already includes the placeholder', () => {
    const form = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/thanks/{CHECKOUT_SESSION_ID}',
    });
    expect(form.get('success_url')).toBe('https://x.com/thanks/{CHECKOUT_SESSION_ID}');
  });

  it('sets client_reference_id when contactId is provided', () => {
    const form = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/ok',
      contactId: 42,
    });
    expect(form.get('client_reference_id')).toBe('42');
  });

  it('does not set client_reference_id when contactId is null/undefined', () => {
    const f1 = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/ok',
      contactId: null,
    });
    expect(f1.has('client_reference_id')).toBe(false);
    const f2 = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/ok',
    });
    expect(f2.has('client_reference_id')).toBe(false);
  });

  it('passes custom metadata through', () => {
    const form = buildStripeSessionForm(product, {
      businessSlug: 'biz-ie-01',
      productKey: 'guia-cork',
      successUrl: 'https://x.com/ok',
      metadata: { broadcast_id: '17', campaign: 'cork-weekly' },
    });
    expect(form.get('metadata[broadcast_id]')).toBe('17');
    expect(form.get('metadata[campaign]')).toBe('cork-weekly');
    // standard metadata still present
    expect(form.get('metadata[business_slug]')).toBe('biz-ie-01');
  });

  it('throws missing-provider-ref when product lacks stripe_price_id', () => {
    const broken: Product = { ...product, providerRefs: {} };
    expect(() =>
      buildStripeSessionForm(broken, {
        businessSlug: 'b',
        productKey: 'k',
        successUrl: 'https://x.com/ok',
      }),
    ).toThrow(/stripe_price_id/);
  });

  it('rejects non-absolute successUrl', () => {
    expect(() =>
      buildStripeSessionForm(product, {
        businessSlug: 'b',
        productKey: 'k',
        successUrl: '/relative/thanks',
      }),
    ).toThrow(/successUrl must be absolute/);
  });

  it('rejects non-absolute cancelUrl', () => {
    expect(() =>
      buildStripeSessionForm(product, {
        businessSlug: 'b',
        productKey: 'k',
        successUrl: 'https://x.com/ok',
        cancelUrl: 'ftp://nope',
      }),
    ).toThrow(/cancelUrl must be absolute/);
  });
});

// ── createStripeProvider ──────────────────────────────────────────────────

function stubTransport(response: { status: number; text: string }): StripeTransport {
  return { post: vi.fn().mockResolvedValue(response) };
}

describe('createStripeProvider', () => {
  it('refuses to initialize without secretKey or transport', () => {
    expect(() => createStripeProvider({})).toThrow(/secretKey or transport/);
  });

  it('returns session URL + id from Stripe on 200', async () => {
    const transport = stubTransport({
      status: 200,
      text: JSON.stringify({
        id: 'cs_test_abc',
        url: 'https://checkout.stripe.com/pay/cs_test_abc',
        expires_at: 1700000000,
      }),
    });
    const provider = createStripeProvider({ transport });
    const result = await provider.createCheckoutSession({
      product,
      request: {
        businessSlug: 'biz-ie-01',
        productKey: 'guia-cork',
        successUrl: 'https://x.com/ok',
      },
    });
    expect(result.url).toBe('https://checkout.stripe.com/pay/cs_test_abc');
    expect(result.sessionId).toBe('cs_test_abc');
    expect(result.provider).toBe('stripe');
    expect(result.expiresAt).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('surfaces Stripe error messages on 4xx', async () => {
    const transport = stubTransport({
      status: 400,
      text: JSON.stringify({
        error: { message: 'No such price: price_123', type: 'invalid_request_error' },
      }),
    });
    const provider = createStripeProvider({ transport });
    try {
      await provider.createCheckoutSession({
        product,
        request: {
          businessSlug: 'biz-ie-01',
          productKey: 'guia-cork',
          successUrl: 'https://x.com/ok',
        },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      const e = err as PaymentError;
      expect(e.code).toBe('provider-error');
      expect(e.message).toMatch(/Stripe 400.*No such price/);
      expect(e.status).toBe(400);
    }
  });

  it('surfaces non-JSON response bodies without crashing', async () => {
    const transport = stubTransport({ status: 500, text: '<html>gateway error</html>' });
    const provider = createStripeProvider({ transport });
    await expect(
      provider.createCheckoutSession({
        product,
        request: {
          businessSlug: 'biz-ie-01',
          productKey: 'guia-cork',
          successUrl: 'https://x.com/ok',
        },
      }),
    ).rejects.toThrow(/Stripe 500/);
  });

  it('POSTs to /v1/checkout/sessions', async () => {
    const post = vi.fn().mockResolvedValue({
      status: 200,
      text: JSON.stringify({ id: 'x', url: 'https://y', expires_at: 1 }),
    });
    const provider = createStripeProvider({ transport: { post } });
    await provider.createCheckoutSession({
      product,
      request: {
        businessSlug: 'biz-ie-01',
        productKey: 'guia-cork',
        successUrl: 'https://x.com/ok',
      },
    });
    expect(post).toHaveBeenCalledWith('/v1/checkout/sessions', expect.any(URLSearchParams));
  });
});
