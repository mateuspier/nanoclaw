/**
 * Checkout orchestrator.
 *
 * Resolves (business, productKey) from the registry, picks a provider,
 * and returns the hosted checkout URL. Single entry point for anything
 * that wants to sell — scripts, agent tools, the future launch-day
 * broadcast.
 */
import {
  CheckoutRequest,
  CheckoutResult,
  PaymentError,
  PaymentProvider,
} from './types.js';
import { findProduct, assertProductIsSellable } from './products.js';

export interface CreateCheckoutParams {
  request: CheckoutRequest;
  /** Provider to use. Selected by the caller (usually by env). */
  provider: PaymentProvider;
}

/**
 * Look up the product, validate, then ask the provider for a URL.
 */
export async function createCheckout(
  params: CreateCheckoutParams,
): Promise<CheckoutResult> {
  const { request, provider } = params;
  const product = findProduct(request.businessSlug, request.productKey);
  if (!product) {
    throw new PaymentError(
      'unknown-product',
      `no product ${request.businessSlug}/${request.productKey} in registry`,
    );
  }
  assertProductIsSellable(product);
  return provider.createCheckoutSession({ product, request });
}
