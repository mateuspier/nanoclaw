import { describe, it, expect, vi } from 'vitest';

import { createCheckout } from './checkout.js';
import { PaymentError, PaymentProvider } from './types.js';
import { PRODUCTS } from './products.js';

function mockProvider(url = 'https://pay.example/abc'): PaymentProvider {
  return {
    name: 'mock',
    createCheckoutSession: vi.fn(async () => ({
      url,
      sessionId: 'sess_1',
      provider: 'mock' as const,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })),
  };
}

// We flip an entry from the seed registry for these tests to a sellable
// state, then restore it. The seed defaults every product to active:false —
// that's the whole point.
function withActive<T>(key: string, fn: () => Promise<T> | T): Promise<T> | T {
  const target = PRODUCTS.find((p) => p.key === key)!;
  const prevActive = target.active;
  const prevRefs = target.providerRefs;
  target.active = true;
  target.providerRefs = { stripe_price_id: 'price_test_123' };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        target.active = prevActive;
        target.providerRefs = prevRefs;
      });
    }
    target.active = prevActive;
    target.providerRefs = prevRefs;
    return result;
  } catch (err) {
    target.active = prevActive;
    target.providerRefs = prevRefs;
    throw err;
  }
}

describe('createCheckout', () => {
  it('returns the provider URL on the happy path', async () => {
    const result = await withActive('guia-essencial-cork', async () => {
      return createCheckout({
        provider: mockProvider('https://pay.example/cs_123'),
        request: {
          businessSlug: 'biz-ie-01',
          productKey: 'guia-essencial-cork',
          successUrl: 'https://soudairlanda.com/thanks',
        },
      });
    });
    expect(result.url).toBe('https://pay.example/cs_123');
    expect(result.provider).toBe('mock');
  });

  it('throws unknown-product for a missing key', async () => {
    await expect(
      createCheckout({
        provider: mockProvider(),
        request: {
          businessSlug: 'biz-ie-01',
          productKey: 'does-not-exist',
          successUrl: 'https://x.com/ok',
        },
      }),
    ).rejects.toThrow(/no product/);
  });

  it('throws product-inactive for a registered but inactive product', async () => {
    try {
      await createCheckout({
        provider: mockProvider(),
        request: {
          businessSlug: 'biz-ie-01',
          productKey: 'guia-essencial-cork',
          successUrl: 'https://x.com/ok',
        },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      expect((err as PaymentError).code).toBe('product-inactive');
    }
  });

  it('passes metadata through to the provider', async () => {
    const providerImpl = mockProvider();
    await withActive('guia-essencial-cork', async () => {
      await createCheckout({
        provider: providerImpl,
        request: {
          businessSlug: 'biz-ie-01',
          productKey: 'guia-essencial-cork',
          successUrl: 'https://x.com/ok',
          contactId: 7,
          metadata: { broadcast_id: '12' },
        },
      });
    });
    const spy = providerImpl.createCheckoutSession as unknown as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0][0];
    expect(call.request.contactId).toBe(7);
    expect(call.request.metadata).toEqual({ broadcast_id: '12' });
  });
});
