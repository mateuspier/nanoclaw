#!/usr/bin/env tsx
/**
 * scripts/checkout-link.ts — generate a Stripe checkout URL from the shell.
 *
 * Uses the in-repo product registry + per-business Stripe secret keys
 * from env vars. Good for smoke-testing a newly activated product before
 * handing the URL to the agent. No writes — stateless call to Stripe.
 *
 * Usage:
 *   STRIPE_SECRET_KEY_IE_01=sk_test_... \
 *   npx tsx scripts/checkout-link.ts \
 *     --business biz-ie-01 \
 *     --product guia-essencial-cork \
 *     --success-url https://soudairlanda.com/guia-cork/sucesso \
 *     [--contact 42] [--metadata key=value,key2=value2]
 *
 * Env vars:
 *   STRIPE_SECRET_KEY_BR_01   MiauPop Stripe key
 *   STRIPE_SECRET_KEY_IE_01   Sou da Irlanda Stripe key
 */
import {
  listProductsForBusiness,
  listActiveProductsForBusiness,
} from '../src/payments/products.js';
import { createCheckout } from '../src/payments/checkout.js';
import { createStripeProvider } from '../src/payments/stripe-provider.js';

const STRIPE_KEY_ENV: Record<string, string> = {
  'biz-br-01': 'STRIPE_SECRET_KEY_BR_01',
  'biz-ie-01': 'STRIPE_SECRET_KEY_IE_01',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    business: get('business'),
    product: get('product'),
    successUrl: get('success-url'),
    cancelUrl: get('cancel-url'),
    contactId: get('contact'),
    metadata: get('metadata'),
    list: args.includes('--list'),
  };
}

function parseMetadata(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(
    raw.split(',').map((pair) => {
      const [k, v] = pair.split('=');
      return [k.trim(), (v ?? '').trim()];
    }),
  );
}

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npx tsx scripts/checkout-link.ts --list --business <slug>\n' +
      '  npx tsx scripts/checkout-link.ts \\\n' +
      '    --business <slug> --product <key> --success-url <url> \\\n' +
      '    [--cancel-url <url>] [--contact <id>] [--metadata k=v,k=v]\n\n' +
      'Env var: ' + Object.values(STRIPE_KEY_ENV).join(' or ') + ' must be set.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const opts = parseArgs();

  if (opts.list) {
    if (!opts.business) usage();
    const all = listProductsForBusiness(opts.business!);
    if (all.length === 0) {
      console.log(`no products for ${opts.business}`);
      return;
    }
    console.log(`products for ${opts.business}:`);
    for (const p of all) {
      const tag = p.active ? '✓ active  ' : '  inactive';
      const price = `${(p.priceCents / 100).toFixed(2)} ${p.currency}`;
      console.log(`  ${tag}  ${p.key.padEnd(28)}  ${price.padEnd(14)}  ${p.title}`);
    }
    return;
  }

  if (!opts.business || !opts.product || !opts.successUrl) usage();

  const envName = STRIPE_KEY_ENV[opts.business!];
  if (!envName) {
    console.error(`unknown business: ${opts.business}`);
    process.exit(1);
  }
  const secretKey = process.env[envName];
  if (!secretKey) {
    console.error(`env var ${envName} is not set`);
    process.exit(1);
  }

  const provider = createStripeProvider({ secretKey });
  const result = await createCheckout({
    provider,
    request: {
      businessSlug: opts.business!,
      productKey: opts.product!,
      successUrl: opts.successUrl!,
      cancelUrl: opts.cancelUrl,
      contactId: opts.contactId ? Number(opts.contactId) : null,
      metadata: parseMetadata(opts.metadata),
    },
  });

  console.log(`session: ${result.sessionId}`);
  console.log(`expires: ${result.expiresAt}`);
  console.log(`url:     ${result.url}`);
}

const invokedDirectly =
  typeof import.meta !== 'undefined' &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
