# Payments

Checkout-URL generation for the launching stores. Takes a
(businessSlug, productKey, optional contactId + metadata), looks up the
product in the registry, calls the selected payment provider, returns a
hosted checkout URL the user can click.

**Status:** module + tests shipped. No products are `active` yet — every
entry in the registry has `active: false`. Flip `active: true` + fill
`providerRefs.stripe_price_id` in `products.ts` once you've created the
Stripe Price. Nothing is live until those two changes ship.

## What's here

| File | Role |
|---|---|
| `types.ts` | Types shared across providers — `Product`, `CheckoutRequest`, `CheckoutResult`, `PaymentError`, `PaymentProvider` interface. |
| `products.ts` | Seed catalog (5 products across both businesses). `findProduct`, `listProductsForBusiness`, `listActiveProductsForBusiness`, `assertProductIsSellable`. All seed products start `active:false` — operator has to opt in explicitly. |
| `stripe-provider.ts` | `createStripeProvider({secretKey})` — returns a `PaymentProvider`. `buildStripeSessionForm` exported for tests so URL + metadata shape can be verified without hitting Stripe. |
| `checkout.ts` | `createCheckout({request, provider})` — the single entry point. Resolves the product, validates it, calls the provider. |
| `*.test.ts` | 32 vitest cases — product shape, validation, Stripe form builder, error surfacing, happy path. |

## Seed catalog

Five seed products live in `products.ts`, all inactive:

**biz 01 — Sou da Irlanda**
- `guia-essencial-cork` — €9 one-time (Guia Essencial Cork PDF)
- `guia-essencial-dublin` — €9 one-time
- `sdi-weekly-digest` — €2/month subscription

**biz 02 — MiauPop**
- `drops-preview` — R$10/month subscription
- `miaupop-premium-newsletter` — R$15/month subscription

To activate a product:

1. Create the Product + Price in the Stripe dashboard (or via `stripe products create` CLI).
2. Copy the Price ID (`price_...`).
3. Edit `src/payments/products.ts`:
   - Set `providerRefs: { stripe_price_id: 'price_...' }`
   - Set `active: true`
4. Commit + deploy.

Keeping the registry in code (not in DB) is deliberate: catalogs are
small (<20 items per business for years) and live edits should go
through review. If it outgrows, move to `data/products.json` (gitignored)
— same pattern as `data/businesses.json`.

## Typical usage

```ts
import { createCheckout } from './payments/checkout.js';
import { createStripeProvider } from './payments/stripe-provider.js';

const provider = createStripeProvider({
  secretKey: process.env.STRIPE_SECRET_KEY_SDI!, // per-business Stripe accounts
});

const result = await createCheckout({
  provider,
  request: {
    businessSlug: 'biz-ie-01',
    productKey: 'guia-essencial-cork',
    contactId: 12345,                                // CRM contact id (optional)
    successUrl: 'https://soudairlanda.com/guia-cork/sucesso',
    cancelUrl: 'https://soudairlanda.com/guia-cork',
    metadata: {
      broadcast_id: '17',
      campaign: 'cork-weekly-2026-04-25',
    },
  },
});

// result.url → "https://checkout.stripe.com/pay/cs_test_..."
// result.sessionId → "cs_test_..." (store for webhook correlation)
```

Hand `result.url` to the user via the existing reply path
(TwilioChannel.sendMessage or a future MCP tool the agent calls).

## Multi-business Stripe accounts

MiauPop and Sou da Irlanda are separate legal entities in different
countries — they need **separate Stripe accounts** (one in Brazil
accepting BRL/PIX, one in Ireland accepting EUR). That means **separate
secret keys**. The recommended env-var layout:

```
STRIPE_SECRET_KEY_BR_01=sk_live_...     # MiauPop
STRIPE_SECRET_KEY_IE_01=sk_live_...     # Sou da Irlanda
```

Caller code picks the right key by business:

```ts
const keyByBusiness: Record<string, string> = {
  'biz-br-01': process.env.STRIPE_SECRET_KEY_BR_01!,
  'biz-ie-01': process.env.STRIPE_SECRET_KEY_IE_01!,
};
const provider = createStripeProvider({ secretKey: keyByBusiness[slug] });
```

Until the accounts exist, keep all keys unset and nothing sells — safer
than a single shared key.

## Running the tests

```bash
sudo -u nanoclaw -i
cd ~/nanoclaw-workspace/nanoclaw
npx vitest run src/payments/
```

Or from any user via the scratch env-override config (same pattern used
by cache / circuit-breaker / broadcast).

Expected: **32 passing**. Under 100 ms. Stripe HTTP is stubbed — the
tests never hit the network.

## What's next (explicitly out of scope for this commit)

- **Webhook endpoint** to receive `checkout.session.completed` from
  Stripe, verify signature, mark the order as paid in a new `orders`
  table, and (for subscriptions) link to a local subscription row.
- **Customer portal** links (`/v1/billing_portal/sessions`) so
  subscribers can self-manage (cancel / update card).
- **Revolut Merchant** provider — mirrors `stripe-provider.ts` shape,
  plugs in behind the same `PaymentProvider` interface.
- **PIX via Mercado Pago** for MiauPop — dominant BR payment rail;
  Stripe supports it through international-pricing-rules but a
  native Mercado Pago provider is simpler for BRL.
- **Agent MCP tool** — expose `create_checkout_link(product_key)` so
  the agent can paste the URL directly into a conversation when the
  user asks to buy.
- **Attribution queries** — scripts/custos.ts or /presidencia extension
  that joins `broadcast_deliveries` → Stripe metadata → revenue per
  campaign.

Each of those is a separate commit once the happy-path sale works.
