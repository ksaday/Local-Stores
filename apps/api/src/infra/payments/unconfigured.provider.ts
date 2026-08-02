import { AppError } from "../../common/errors/app-error.js";
import {
  PaymentProvider,
  type AccountStatus,
  type OnboardingLink,
  type PaymentIntentResult,
  type ProviderEvent,
  type RefundResult,
} from "./payment.provider.js";

/**
 * Stands in when no payment provider is configured.
 *
 * Running without Stripe is a supported state, not a broken one: a shop can
 * take cash over the counter and cash on collection, which is the whole
 * Phase 7 experience. What must not happen is a `null` provider that throws
 * `TypeError: cannot read property of undefined` at the moment a customer
 * tries to pay.
 *
 * So every method fails deliberately, with a message that names the actual
 * problem. `getAccountStatus` is the exception — it answers honestly that
 * nothing is connected, because the settings page needs to render that state
 * rather than error on it.
 */
export class UnconfiguredPaymentProvider extends PaymentProvider {
  async createOnboardingLink(): Promise<OnboardingLink> {
    throw unconfigured();
  }

  async getAccountStatus(accountId: string): Promise<AccountStatus> {
    return {
      accountId,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsDue: [],
      disabledReason: "platform.payments_not_configured",
    };
  }

  async createIntent(): Promise<PaymentIntentResult> {
    throw unconfigured();
  }

  async refund(): Promise<RefundResult> {
    throw unconfigured();
  }

  async parseWebhook(): Promise<ProviderEvent> {
    // Refusing rather than accepting is the safe default: without a signing
    // secret there is no way to tell Stripe from anyone else who found the
    // URL, and that caller could otherwise mark orders paid.
    throw AppError.forbidden("Webhooks are not configured.");
  }
}

function unconfigured(): AppError {
  return AppError.validation(
    "Card payments aren't set up on this platform yet. Cash payments still work.",
  );
}
