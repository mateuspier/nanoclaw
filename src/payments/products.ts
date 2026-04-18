/**
 * Product registry.
 *
 * Hard-coded seed entries for the two active businesses, with `active:false`
 * so nothing is sellable yet. Flip `active:true` + fill in `providerRefs`
 * once the Stripe products are actually created.
 *
 * Kept in code, not in DB: product catalogs are small (≤ 20 per business
 * for years) and live edits should go through review. Runtime lookup is a
 * cheap array scan. If and when the catalog outgrows this, move to
 * `data/products.json` (gitignored, same pattern as businesses.json).
 */
import { Product, PaymentError } from './types.js';

export const PRODUCTS: Product[] = [
  // ── biz 01 — Sou da Irlanda ──────────────────────────────────────────
  {
    key: 'guia-essencial-cork',
    businessSlug: 'biz-ie-01',
    title: 'Guia Essencial Cork',
    description:
      'Guia em PDF com mercado de aluguel, visto, trabalho, saúde, transporte, comunidade brasileira em Cork. ~40 páginas, atualizado trimestralmente.',
    mode: 'one_time',
    priceCents: 900, // €9.00
    currency: 'EUR',
    pitchLine: 'Guia Essencial Cork — €9 · tudo que eu queria saber antes de vir',
    providerRefs: {
      // Fill once Stripe product + price are created:
      // stripe_price_id: 'price_...',
    },
    active: false,
  },
  {
    key: 'guia-essencial-dublin',
    businessSlug: 'biz-ie-01',
    title: 'Guia Essencial Dublin',
    description:
      'Guia em PDF: aluguel por bairro, vistos, empregos em tech/hospitalidade, bancos, transporte, comunidade. ~40 páginas.',
    mode: 'one_time',
    priceCents: 900,
    currency: 'EUR',
    pitchLine: 'Guia Essencial Dublin — €9',
    providerRefs: {},
    active: false,
  },
  {
    key: 'sdi-weekly-digest',
    businessSlug: 'biz-ie-01',
    title: 'Sou da Irlanda Weekly Digest',
    description:
      'Resumo semanal por WhatsApp: 5 imóveis novos na sua cidade, prazos de visto, eventos da comunidade brasileira. Toda sexta, 18:00 IST.',
    mode: 'subscription_monthly',
    priceCents: 200, // €2/month
    currency: 'EUR',
    pitchLine: 'Weekly Digest — €2/mês, 5 imóveis + prazos + eventos',
    providerRefs: {},
    active: false,
  },

  // ── biz 02 — MiauPop ─────────────────────────────────────────────────
  {
    key: 'drops-preview',
    businessSlug: 'biz-br-01',
    title: 'MiauPop Drops Preview',
    description:
      'Alerta antecipado por WhatsApp de drops de PopMart, K-pop, sneakers e colecionáveis. 24h antes do público geral. Toda semana.',
    mode: 'subscription_monthly',
    priceCents: 1000, // R$ 10/month (using BRL)
    currency: 'BRL',
    pitchLine: 'Drops Preview — R$10/mês, 24h de antecedência',
    providerRefs: {},
    active: false,
  },
  {
    key: 'miaupop-premium-newsletter',
    businessSlug: 'biz-br-01',
    title: 'MiauPop Premium Newsletter',
    description:
      'Newsletter semanal sem ads, com análises mais longas, entrevistas exclusivas, calendário completo de lançamentos.',
    mode: 'subscription_monthly',
    priceCents: 1500, // R$ 15/month
    currency: 'BRL',
    pitchLine: 'Premium Newsletter — R$15/mês, sem ads, análises longas',
    providerRefs: {},
    active: false,
  },
];

export function findProduct(
  businessSlug: string,
  productKey: string,
): Product | undefined {
  return PRODUCTS.find(
    (p) => p.businessSlug === businessSlug && p.key === productKey,
  );
}

export function listProductsForBusiness(businessSlug: string): Product[] {
  return PRODUCTS.filter((p) => p.businessSlug === businessSlug);
}

export function listActiveProductsForBusiness(businessSlug: string): Product[] {
  return PRODUCTS.filter((p) => p.businessSlug === businessSlug && p.active);
}

/**
 * Shape-check a product. Throws PaymentError with a specific code on
 * failure. Callers use this before touching a payment provider so we
 * catch catalog mistakes before hitting a live API.
 */
export function assertProductIsSellable(product: Product): void {
  if (!product.active) {
    throw new PaymentError(
      'product-inactive',
      `product ${product.businessSlug}/${product.key} is not active`,
    );
  }
  if (product.priceCents <= 0) {
    throw new PaymentError(
      'invalid-price',
      `product ${product.key} priceCents must be > 0`,
    );
  }
  // The caller's provider validates its own providerRefs; we just check
  // something is in the map.
  if (Object.keys(product.providerRefs).length === 0) {
    throw new PaymentError(
      'missing-provider-ref',
      `product ${product.key} has no providerRefs — cannot checkout`,
    );
  }
}
