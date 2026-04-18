import { describe, it, expect } from 'vitest';

import {
  PRODUCTS,
  findProduct,
  listProductsForBusiness,
  listActiveProductsForBusiness,
  assertProductIsSellable,
} from './products.js';
import { PaymentError, Product } from './types.js';

describe('PRODUCTS seed', () => {
  it('has entries for both active businesses', () => {
    expect(listProductsForBusiness('biz-ie-01').length).toBeGreaterThan(0);
    expect(listProductsForBusiness('biz-br-01').length).toBeGreaterThan(0);
  });

  it('every product has the required shape', () => {
    for (const p of PRODUCTS) {
      expect(typeof p.key).toBe('string');
      expect(p.key).toMatch(/^[a-z0-9-]+$/);
      expect(p.priceCents).toBeGreaterThan(0);
      expect(['EUR', 'USD', 'BRL', 'GBP']).toContain(p.currency);
      expect(['one_time', 'subscription_monthly', 'subscription_annual']).toContain(p.mode);
    }
  });

  it('every product starts `active:false` — operator has to flip explicitly', () => {
    for (const p of PRODUCTS) {
      expect(p.active).toBe(false);
    }
  });
});

describe('findProduct', () => {
  it('returns the matching product', () => {
    const p = findProduct('biz-ie-01', 'guia-essencial-cork');
    expect(p?.title).toBe('Guia Essencial Cork');
    expect(p?.priceCents).toBe(900);
  });

  it('is undefined when business does not match', () => {
    expect(findProduct('biz-br-01', 'guia-essencial-cork')).toBeUndefined();
  });

  it('is undefined when product key does not exist', () => {
    expect(findProduct('biz-ie-01', 'nope')).toBeUndefined();
  });
});

describe('listActiveProductsForBusiness', () => {
  it('returns empty when nothing is active', () => {
    expect(listActiveProductsForBusiness('biz-ie-01')).toHaveLength(0);
    expect(listActiveProductsForBusiness('biz-br-01')).toHaveLength(0);
  });
});

describe('assertProductIsSellable', () => {
  const good: Product = {
    key: 'x',
    businessSlug: 'b',
    title: 'Test',
    description: '',
    mode: 'one_time',
    priceCents: 500,
    currency: 'EUR',
    providerRefs: { stripe_price_id: 'price_123' },
    active: true,
  };

  it('passes on a fully ready product', () => {
    expect(() => assertProductIsSellable(good)).not.toThrow();
  });

  it('throws product-inactive when active:false', () => {
    expect(() => assertProductIsSellable({ ...good, active: false })).toThrow(
      /not active/,
    );
  });

  it('throws invalid-price when priceCents <= 0', () => {
    expect(() =>
      assertProductIsSellable({ ...good, priceCents: 0 }),
    ).toThrow(/priceCents/);
  });

  it('throws missing-provider-ref when providerRefs is empty', () => {
    expect(() =>
      assertProductIsSellable({ ...good, providerRefs: {} }),
    ).toThrow(/providerRefs/);
  });

  it('error carries a stable code', () => {
    try {
      assertProductIsSellable({ ...good, active: false });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      expect((err as PaymentError).code).toBe('product-inactive');
    }
  });
});
