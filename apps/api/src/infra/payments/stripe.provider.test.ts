import { beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { StripePaymentProvider } from "./stripe.provider.js";

/**
 * Asserts what we send to Stripe, not what Stripe sends back.
 *
 * The platform-fee promise (plan §18.6) is a claim about the *absence* of a
 * field in an outbound request, which no amount of inspecting a response can
 * demonstrate. So the SDK's HTTP client is replaced and the request body is
 * read directly.
 */

interface CapturedRequest {
  method: string;
  path: string;
  body: Record<string, string>;
  headers: Record<string, string>;
}

let captured: CapturedRequest[] = [];
let nextResponse: unknown = {};
let provider: StripePaymentProvider;

/**
 * A Stripe `HttpClient` that answers from memory.
 *
 * Implements the SDK's real interface rather than monkey-patching internals,
 * so it keeps working across SDK versions and exercises the same encoding path
 * production uses — which matters, because the assertion is about exactly what
 * appears in the encoded body.
 */
class RecordingHttpClient extends Stripe.HttpClient {
  override getClientName(): string {
    return "recording";
  }

  override async makeRequest(
    _host: string,
    _port: string,
    path: string,
    method: string,
    headers: Record<string, string | number | string[]>,
    requestData: string,
  ): Promise<Stripe.HttpClientResponse> {
    const flat: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) flat[name] = String(value);
    captured.push({ method, path, body: decodeForm(requestData), headers: flat });

    const payload = nextResponse;
    return {
      getStatusCode: () => 200,
      getHeaders: () => ({ "content-type": "application/json" }),
      getRawResponse: () => ({}),
      toStream: () => ({}),
      toJSON: () => Promise.resolve(payload),
    } as unknown as Stripe.HttpClientResponse;
  }
}

/** Stripe posts `a[b]=c&d=e`; this turns that back into flat keys. */
function decodeForm(data: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(data ?? "")) out[key] = value;
  return out;
}

function respondWith(payload: unknown): void {
  nextResponse = payload;
}

beforeEach(() => {
  captured = [];
  nextResponse = {};
  provider = new StripePaymentProvider("sk_test_fake", "whsec_fake", new RecordingHttpClient());
});

describe("the platform fee promise", () => {
  it("never sends application_fee_amount when creating a payment", async () => {
    // The commitment is public and unconditional: BBA takes no cut of any
    // sale. If this test ever fails, the product has broken a promise, not
    // just a convention.
    respondWith({
      id: "pi_test",
      client_secret: "pi_test_secret_x",
      status: "requires_payment_method",
    });

    await provider.createIntent({
      storeId: "store-1",
      orderId: "order-1",
      orderNumber: "MOR-1000",
      amountCents: 2371,
      currency: "USD",
      destinationAccountId: "acct_store1",
      idempotencyKey: "key-1",
    });

    const request = captured[0]!;
    const feeKeys = Object.keys(request.body).filter((k) => k.includes("application_fee"));

    expect(feeKeys).toEqual([]);
  });

  it("does not send an explicit zero fee either", async () => {
    // A zero `application_fee_amount` is NOT equivalent to omitting it: Stripe
    // prints a fee line on the connected account's statement either way, and a
    // "$0.00 platform fee" line contradicts the promise just as loudly as a
    // real one would.
    respondWith({
      id: "pi_test",
      client_secret: "pi_test_secret_x",
      status: "requires_payment_method",
    });

    await provider.createIntent({
      storeId: "store-1",
      orderId: "order-1",
      orderNumber: "MOR-1000",
      amountCents: 5000,
      currency: "USD",
      destinationAccountId: "acct_store1",
      idempotencyKey: "key-2",
    });

    expect(captured[0]!.body).not.toHaveProperty("application_fee_amount");
    expect(JSON.stringify(captured[0]!.body)).not.toContain("application_fee");
  });
});

describe("destination charges", () => {
  beforeEach(() => {
    respondWith({
      id: "pi_test",
      client_secret: "pi_test_secret_x",
      status: "requires_payment_method",
    });
  });

  it("sends the money to the store's connected account", async () => {
    await provider.createIntent({
      storeId: "store-1",
      orderId: "order-1",
      orderNumber: "MOR-1000",
      amountCents: 2371,
      currency: "USD",
      destinationAccountId: "acct_the_bakery",
      idempotencyKey: "key-3",
    });

    expect(captured[0]!.body["transfer_data[destination]"]).toBe("acct_the_bakery");
  });

  it("carries the store and order in metadata so a webhook can find them", async () => {
    await provider.createIntent({
      storeId: "store-42",
      orderId: "order-99",
      orderNumber: "MOR-1042",
      amountCents: 800,
      currency: "USD",
      destinationAccountId: "acct_x",
      idempotencyKey: "key-4",
    });

    expect(captured[0]!.body["metadata[storeId]"]).toBe("store-42");
    expect(captured[0]!.body["metadata[orderId]"]).toBe("order-99");
  });

  it("passes the idempotency key so a retry cannot charge twice", async () => {
    await provider.createIntent({
      storeId: "store-1",
      orderId: "order-1",
      orderNumber: "MOR-1000",
      amountCents: 800,
      currency: "USD",
      destinationAccountId: "acct_x",
      idempotencyKey: "the-key",
    });

    // Stripe's SDK cases this header itself, so match case-insensitively
    // rather than pinning a spelling it is free to change.
    const idempotencyHeader = Object.entries(captured[0]!.headers).find(
      ([name]) => name.toLowerCase() === "idempotency-key",
    );
    expect(idempotencyHeader?.[1]).toBe("the-key");
  });

  it("puts the order number on the customer's statement", async () => {
    // It is what they will quote when they ring the shop about a charge.
    await provider.createIntent({
      storeId: "store-1",
      orderId: "order-1",
      orderNumber: "MOR-1042",
      amountCents: 800,
      currency: "USD",
      destinationAccountId: "acct_x",
      idempotencyKey: "key-5",
    });

    expect(captured[0]!.body["statement_descriptor_suffix"]).toBe("MOR-1042");
  });

  it("refuses a zero-amount payment before calling Stripe", async () => {
    await expect(
      provider.createIntent({
        storeId: "store-1",
        orderId: "order-1",
        orderNumber: "MOR-1000",
        amountCents: 0,
        currency: "USD",
        destinationAccountId: "acct_x",
        idempotencyKey: "key-6",
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(captured).toHaveLength(0);
  });
});

describe("refunds", () => {
  beforeEach(() => {
    respondWith({ id: "re_test", status: "succeeded", amount: 500 });
  });

  it("reverses the transfer so the money comes back out of the store's account", async () => {
    // Without this the platform absorbs the refund and the store keeps funds
    // for a sale that was returned.
    await provider.refund({
      intentId: "pi_x",
      amountCents: 500,
      accountId: "acct_the_bakery",
      idempotencyKey: "refund-1",
    });

    expect(captured[0]!.body["reverse_transfer"]).toBe("true");
  });

  it("does not try to refund a platform fee that was never charged", async () => {
    await provider.refund({
      intentId: "pi_x",
      amountCents: 500,
      accountId: "acct_x",
      idempotencyKey: "refund-2",
    });

    expect(captured[0]!.body["refund_application_fee"]).toBe("false");
  });

  it("omits the amount for a full refund rather than guessing one", async () => {
    await provider.refund({ intentId: "pi_x", accountId: "acct_x", idempotencyKey: "refund-3" });
    expect(captured[0]!.body).not.toHaveProperty("amount");
  });
});

describe("webhook verification", () => {
  it("rejects a body that was not signed with our secret", async () => {
    await expect(
      provider.parseWebhook(Buffer.from('{"id":"evt_1"}'), "t=1,v1=nonsense"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unsigned request", async () => {
    // Without signature verification this endpoint is an unauthenticated way
    // to mark any order paid.
    await expect(
      provider.parseWebhook(Buffer.from('{"id":"evt_1"}'), ""),
    ).rejects.toMatchObject({ status: 403 });
  });
});
