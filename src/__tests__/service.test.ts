import {
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import XenditProviderService from "../service"
import { XenditOptions } from "../types"

// ── test harness ────────────────────────────────────────────────────────────

const CALLBACK_TOKEN = "callback_token_abcdef"

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }
}

function makeService(overrides: Partial<XenditOptions> = {}) {
  const logger = makeLogger()
  const options: XenditOptions = {
    secretKey: "xnd_test_secret",
    callbackToken: CALLBACK_TOKEN,
    baseUrl: "https://api.test.xendit",
    ...overrides,
  }
  const service = new XenditProviderService(
    { logger } as any,
    options as any
  )
  return { service, logger }
}

const fetchMock = jest.fn()

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as any
})

// Queue the next fetch() to resolve as a successful Xendit invoice response.
function mockInvoiceOnce(overrides: Record<string, unknown> = {}) {
  const invoice = {
    id: "inv_123",
    external_id: "sess_123",
    status: "PENDING",
    amount: 10000,
    invoice_url: "https://checkout.xendit/inv_123",
    currency: "IDR",
    ...overrides,
  }
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => invoice,
  })
  return invoice
}

// Inspect the body/headers of the Nth fetch call (default: last).
function fetchCall(n?: number) {
  const calls = fetchMock.mock.calls
  const call = calls[n ?? calls.length - 1]
  const [url, init] = call
  return {
    url: url as string,
    method: init.method as string,
    headers: init.headers as Record<string, string>,
    body: init.body ? JSON.parse(init.body as string) : undefined,
  }
}

function initiateInput(
  amount: number,
  currency_code: string,
  extra: Record<string, unknown> = {}
) {
  return {
    amount,
    currency_code,
    data: { session_id: "sess_123" },
    ...extra,
  } as any
}

// ── validateOptions ──────────────────────────────────────────────────────────

describe("validateOptions", () => {
  it("throws when secretKey is missing", () => {
    expect(() =>
      XenditProviderService.validateOptions({ callbackToken: "x" })
    ).toThrow(MedusaError)
  })

  it("does not require callbackToken (boot-safe)", () => {
    expect(() =>
      XenditProviderService.validateOptions({ secretKey: "xnd_test" })
    ).not.toThrow()
  })
})

describe("constructor", () => {
  it("warns when callbackToken is not configured", () => {
    const { logger } = makeService({ callbackToken: undefined as any })
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("XENDIT_CALLBACK_TOKEN is not set")
    )
  })
})

// ── P2: currency-aware amount conversion ─────────────────────────────────────

describe("amount conversion (initiatePayment)", () => {
  // [amount, currency, expected amount sent to Xendit]
  const cases: Array<[number, string, number]> = [
    // IDR: zero-decimal — whole rupiah, rounds fractions away
    [10000, "IDR", 10000],
    [10000.4, "IDR", 10000],
    [10000.6, "IDR", 10001],
    // USD: two decimals — cents preserved, rounds to 2 places
    [10.5, "USD", 10.5],
    [10.555, "USD", 10.56],
    [99.994, "USD", 99.99],
    // PHP: two decimals (centavos)
    [99.99, "PHP", 99.99],
    // JPY: zero-decimal
    [1500.6, "JPY", 1501],
    // VND: zero-decimal
    [25000.2, "VND", 25000],
    // Unknown currency falls back to 2 decimals
    [10.555, "XYZ", 10.56],
  ]

  it.each(cases)(
    "%p %s -> %p",
    async (amount, currency, expected) => {
      mockInvoiceOnce()
      const { service } = makeService()
      await service.initiatePayment(initiateInput(amount, currency))
      expect(fetchCall().body.amount).toBe(expected)
    }
  )

  it("uppercases a lowercase currency code in the request", async () => {
    mockInvoiceOnce()
    const { service } = makeService()
    await service.initiatePayment(initiateInput(10.5, "usd"))
    const { body } = fetchCall()
    expect(body.currency).toBe("USD")
    expect(body.amount).toBe(10.5)
  })

  it("posts to the create-invoice endpoint with external_id = session id", async () => {
    mockInvoiceOnce()
    const { service } = makeService()
    await service.initiatePayment(initiateInput(10000, "IDR"))
    const { url, method, body } = fetchCall()
    expect(method).toBe("POST")
    expect(url).toBe("https://api.test.xendit/v2/invoices")
    expect(body.external_id).toBe("sess_123")
  })
})

// ── P2: idempotency key ──────────────────────────────────────────────────────

describe("idempotency key", () => {
  it("sends X-IDEMPOTENCY-KEY when context.idempotency_key is present", async () => {
    mockInvoiceOnce()
    const { service } = makeService()
    await service.initiatePayment(
      initiateInput(10000, "IDR", {
        context: { idempotency_key: "idem_key_1" },
      })
    )
    expect(fetchCall().headers["X-IDEMPOTENCY-KEY"]).toBe("idem_key_1")
  })

  it("omits the header when no idempotency_key is provided", async () => {
    mockInvoiceOnce()
    const { service } = makeService()
    await service.initiatePayment(initiateInput(10000, "IDR"))
    expect(fetchCall().headers["X-IDEMPOTENCY-KEY"]).toBeUndefined()
  })

  it("suffixes the key with the new amount on updatePayment re-create", async () => {
    // First fetch = expire stale invoice, second = create fresh invoice.
    mockInvoiceOnce({ status: "EXPIRED" })
    mockInvoiceOnce({ amount: 20000 })
    const { service } = makeService()

    await service.updatePayment({
      amount: 20000,
      currency_code: "IDR",
      data: {
        session_id: "sess_123",
        invoice_id: "inv_old",
        amount: 10000,
        status: "PENDING",
      },
      context: { idempotency_key: "idem_key_1" },
    } as any)

    // Expire call first
    expect(fetchCall(0).url).toBe(
      "https://api.test.xendit/invoices/inv_old/expire!"
    )
    // Create call carries the amount-suffixed key so Xendit doesn't dedupe
    // back to the now-expired invoice.
    const create = fetchCall(1)
    expect(create.url).toBe("https://api.test.xendit/v2/invoices")
    expect(create.headers["X-IDEMPOTENCY-KEY"]).toBe("idem_key_1:20000")
  })

  it("short-circuits updatePayment when the amount is unchanged", async () => {
    const { service } = makeService()
    const res = await service.updatePayment({
      amount: 10000,
      currency_code: "IDR",
      data: {
        session_id: "sess_123",
        invoice_id: "inv_old",
        amount: 10000,
        status: "PENDING",
      },
    } as any)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.status).toBe(PaymentSessionStatus.PENDING)
  })
})

// ── status mapping ───────────────────────────────────────────────────────────

describe("status mapping (getPaymentStatus)", () => {
  const cases: Array<[string, PaymentSessionStatus]> = [
    ["PAID", PaymentSessionStatus.CAPTURED],
    ["SETTLED", PaymentSessionStatus.CAPTURED],
    ["EXPIRED", PaymentSessionStatus.CANCELED],
    ["PENDING", PaymentSessionStatus.PENDING],
  ]

  it.each(cases)("invoice %s -> %s", async (invoiceStatus, expected) => {
    mockInvoiceOnce({ status: invoiceStatus })
    const { service } = makeService()
    const res = await service.getPaymentStatus({
      data: { invoice_id: "inv_123" },
    } as any)
    expect(res.status).toBe(expected)
  })

  it("throws when invoice id is missing", async () => {
    const { service } = makeService()
    await expect(
      service.getPaymentStatus({ data: {} } as any)
    ).rejects.toThrow(MedusaError)
  })
})

// ── P2: webhook token verification + action selection ────────────────────────

describe("getWebhookActionAndData", () => {
  function payload(
    token: string | undefined,
    body: Record<string, unknown>
  ) {
    return {
      headers: token !== undefined ? { "x-callback-token": token } : {},
      data: body,
    } as any
  }

  it("rejects when callbackToken is not configured", async () => {
    const { service } = makeService({ callbackToken: undefined as any })
    const res = await service.getWebhookActionAndData(
      payload(CALLBACK_TOKEN, { external_id: "sess_123", status: "PAID" })
    )
    expect(res.action).toBe(PaymentActions.NOT_SUPPORTED)
  })

  it("rejects an invalid token", async () => {
    const { service } = makeService()
    const res = await service.getWebhookActionAndData(
      payload("wrong_token", { external_id: "sess_123", status: "PAID" })
    )
    expect(res.action).toBe(PaymentActions.NOT_SUPPORTED)
  })

  it("rejects a token of differing length (timing-safe length guard)", async () => {
    const { service } = makeService()
    const res = await service.getWebhookActionAndData(
      payload(CALLBACK_TOKEN + "extra", {
        external_id: "sess_123",
        status: "PAID",
      })
    )
    expect(res.action).toBe(PaymentActions.NOT_SUPPORTED)
  })

  it("maps a valid PAID callback to SUCCESSFUL with session id and amount", async () => {
    const { service } = makeService()
    const res = await service.getWebhookActionAndData(
      payload(CALLBACK_TOKEN, {
        external_id: "sess_123",
        status: "PAID",
        paid_amount: 10000,
      })
    )
    expect(res.action).toBe(PaymentActions.SUCCESSFUL)
    expect(res.data?.session_id).toBe("sess_123")
    expect(Number(res.data?.amount)).toBe(10000)
  })

  it("maps SETTLED to SUCCESSFUL", async () => {
    const { service } = makeService()
    const res = await service.getWebhookActionAndData(
      payload(CALLBACK_TOKEN, {
        external_id: "sess_123",
        status: "SETTLED",
        amount: 10000,
      })
    )
    expect(res.action).toBe(PaymentActions.SUCCESSFUL)
  })

  it("maps EXPIRED to CANCELED", async () => {
    const { service } = makeService()
    const res = await service.getWebhookActionAndData(
      payload(CALLBACK_TOKEN, {
        external_id: "sess_123",
        status: "EXPIRED",
        amount: 10000,
      })
    )
    expect(res.action).toBe(PaymentActions.CANCELED)
  })

  it("treats other statuses as NOT_SUPPORTED", async () => {
    const { service } = makeService()
    const res = await service.getWebhookActionAndData(
      payload(CALLBACK_TOKEN, { external_id: "sess_123", status: "PENDING" })
    )
    expect(res.action).toBe(PaymentActions.NOT_SUPPORTED)
  })
})
