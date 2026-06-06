import {
  AbstractPaymentProvider,
  BigNumber,
  defaultCurrencies,
  MedusaError,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  BigNumberInput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  XenditInvoice,
  XenditOptions,
  XenditSessionData,
  XenditWebhookBody,
} from "./types"
import crypto from "crypto"

type InjectedDependencies = {
  logger: Logger
}

const DEFAULT_BASE_URL = "https://api.xendit.co"
const DEFAULT_INVOICE_DURATION = 24 * 60 * 60 // 24h in seconds

class XenditProviderService extends AbstractPaymentProvider<XenditOptions> {
  static identifier = "xendit"

  protected readonly logger_: Logger
  protected readonly options_: XenditOptions

  static validateOptions(options: Record<string, unknown>): void {
    if (!options.secretKey) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Xendit payment provider requires the `secretKey` option."
      )
    }
    // callbackToken is intentionally not required here: a missing webhook token
    // should disable webhook verification, not crash backend boot. See the
    // constructor warning and getWebhookActionAndData's guard.
  }

  constructor(container: InjectedDependencies, options: XenditOptions) {
    super(container, options)
    this.logger_ = container.logger
    this.options_ = options

    if (!options.callbackToken) {
      this.logger_.warn(
        "Xendit: XENDIT_CALLBACK_TOKEN is not set. Webhook callbacks will be rejected, so the 'paid but browser closed' backstop is INACTIVE. Set it before relying on webhooks or going live."
      )
    }
  }

  // ── Xendit API client ───────────────────────────────────────────────────

  private get baseUrl(): string {
    return this.options_.baseUrl || DEFAULT_BASE_URL
  }

  // Xendit uses HTTP Basic auth: the secret key as username, empty password.
  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.options_.secretKey}:`).toString("base64")}`
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Xendit ${method} ${path} failed (${res.status}): ${text}`
      )
    }
    return (await res.json()) as T
  }

  // `idempotencyKey` lets Xendit dedupe retried creates: a repeated call with
  // the same key returns the original invoice instead of charging twice.
  private createInvoice(
    body: Record<string, unknown>,
    idempotencyKey?: string
  ): Promise<XenditInvoice> {
    return this.request<XenditInvoice>(
      "POST",
      "/v2/invoices",
      body,
      idempotencyKey ? { "X-IDEMPOTENCY-KEY": idempotencyKey } : undefined
    )
  }

  private getInvoice(id: string): Promise<XenditInvoice> {
    return this.request<XenditInvoice>("GET", `/v2/invoices/${id}`)
  }

  // Expire (cancel) a still-open invoice. Safe to call on an already-settled
  // invoice — Xendit returns the invoice unchanged.
  private expireInvoice(id: string): Promise<XenditInvoice> {
    return this.request<XenditInvoice>("POST", `/invoices/${id}/expire!`)
  }

  // ── status mapping ────────────────────────────────────────────────────────

  // A Xendit invoice is single-step: once PAID/SETTLED the funds are captured,
  // so we surface CAPTURED rather than AUTHORIZED.
  private toSessionStatus(status: string): PaymentSessionStatus {
    switch (status) {
      case "PAID":
      case "SETTLED":
        return PaymentSessionStatus.CAPTURED
      case "EXPIRED":
        return PaymentSessionStatus.CANCELED
      default:
        return PaymentSessionStatus.PENDING
    }
  }

  // ── amount conversion ──────────────────────────────────────────────────────

  // Medusa hands amounts as decimal major units (e.g. 10.5 USD, 10000 IDR).
  // Xendit's invoice `amount` is also a major-unit number, but must respect the
  // currency's precision: zero-decimal currencies (IDR, JPY, VND) take whole
  // numbers; two-decimal currencies (USD, PHP) keep cents. We round to that
  // precision rather than blindly to an integer (which would drop cents).
  // Unknown currencies fall back to 2 decimals, the global default.
  private toXenditAmount(
    amount: BigNumberInput,
    currencyCode: string
  ): number {
    const digits =
      defaultCurrencies[currencyCode.toUpperCase() as keyof typeof defaultCurrencies]
        ?.decimal_digits ?? 2
    const factor = 10 ** digits
    return Math.round(Number(amount) * factor) / factor
  }

  // ── provider interface ─────────────────────────────────────────────────────

  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, data, context } = input

    const xenditAmount = this.toXenditAmount(amount, currency_code)

    // Medusa passes the payment session id in `data.session_id`. We use it as
    // the invoice's external_id so the webhook can map back to the session.
    const sessionId = (data?.session_id as string | undefined) ?? ""

    const invoice = await this.createInvoice(
      {
        external_id: sessionId,
        amount: xenditAmount,
        currency: currency_code.toUpperCase(),
        payer_email: context?.customer?.email,
        description: (data?.description as string | undefined) ?? undefined,
        invoice_duration:
          this.options_.invoiceDuration ?? DEFAULT_INVOICE_DURATION,
        success_redirect_url: data?.success_redirect_url as string | undefined,
        failure_redirect_url: data?.failure_redirect_url as string | undefined,
      },
      context?.idempotency_key
    )

    const sessionData: XenditSessionData = {
      invoice_id: invoice.id,
      invoice_url: invoice.invoice_url,
      external_id: invoice.external_id,
      status: invoice.status,
      amount: invoice.amount,
      currency: invoice.currency,
    }

    return {
      id: invoice.id,
      data: sessionData as unknown as Record<string, unknown>,
      status: this.toSessionStatus(invoice.status),
    }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const invoiceId = (input.data as XenditSessionData | undefined)?.invoice_id
    if (!invoiceId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Missing Xendit invoice id while getting payment status."
      )
    }
    const invoice = await this.getInvoice(invoiceId)
    return {
      status: this.toSessionStatus(invoice.status),
      data: { ...(input.data as object), status: invoice.status },
    }
  }

  // Called during cart completion. We re-check the real invoice status with
  // Xendit rather than trusting the redirect, then let Medusa create the order.
  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    return this.getPaymentStatus(input as GetPaymentStatusInput)
  }

  // Invoices capture on payment, so there's nothing to capture server-side.
  // We confirm the invoice is actually paid before returning success.
  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    const data = input.data as XenditSessionData | undefined
    if (!data?.invoice_id) {
      return { data: input.data }
    }
    const invoice = await this.getInvoice(data.invoice_id)
    return { data: { ...data, status: invoice.status } }
  }

  // Nothing to actively cancel for an invoice payment: an unpaid invoice
  // auto-expires after `invoice_duration`, and a paid one can't be expired
  // (refund via the Xendit dashboard instead). Medusa calls this when cleaning
  // up payment sessions, so we just acknowledge it without a futile API call.
  async cancelPayment(
    input: CancelPaymentInput
  ): Promise<CancelPaymentOutput> {
    return { data: input.data }
  }

  async deletePayment(
    input: DeletePaymentInput
  ): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input)
  }

  // Invoice amounts are immutable. If the cart total changed, expire the stale
  // invoice and create a fresh one so the customer is charged the right amount.
  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const data = input.data as XenditSessionData | undefined
    const newAmount = this.toXenditAmount(input.amount, input.currency_code)

    if (data?.invoice_id && data.amount === newAmount) {
      return { status: this.toSessionStatus(data.status), data: input.data }
    }

    if (data?.invoice_id) {
      await this.expireInvoice(data.invoice_id).catch((e) =>
        this.logger_.warn(
          `Xendit: failed to expire stale invoice ${data.invoice_id}: ${
            (e as Error).message
          }`
        )
      )
    }

    // Re-creating with the original idempotency key would make Xendit return the
    // now-expired invoice (wrong amount). Suffix the key with the new amount so
    // the fresh invoice is created, while a retry of *this* update stays idempotent.
    const recreateInput = {
      ...input,
      context: {
        ...input.context,
        idempotency_key: input.context?.idempotency_key
          ? `${input.context.idempotency_key}:${newAmount}`
          : undefined,
      },
    }

    const initiated = await this.initiatePayment(
      recreateInput as InitiatePaymentInput
    )
    return { status: initiated.status, data: initiated.data }
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const data = input.data as XenditSessionData | undefined
    if (!data?.invoice_id) {
      return { data: input.data }
    }
    const invoice = await this.getInvoice(data.invoice_id)
    return { data: invoice as unknown as Record<string, unknown> }
  }

  // Xendit Invoice API has no programmatic refund endpoint. This method records
  // the refund in Medusa (order totals/status, refund email) but does NOT move
  // money — issue the actual refund manually via the Xendit dashboard.
  async refundPayment(
    input: RefundPaymentInput
  ): Promise<RefundPaymentOutput> {
    this.logger_.info(
      `Xendit: refund recorded for amount ${input.amount}. Issue the actual refund manually via the Xendit dashboard.`
    )
    return { data: input.data }
  }

  // Backstop for when the customer pays but never returns to the storefront.
  // The built-in /hooks/payment/:provider route hands the raw callback here.
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    if (!this.options_.callbackToken) {
      this.logger_.warn(
        "Xendit webhook rejected: XENDIT_CALLBACK_TOKEN is not configured."
      )
      return { action: PaymentActions.NOT_SUPPORTED }
    }
    // Constant-time compare so a remote attacker can't byte-probe the token
    // via response timing (it's the sole webhook auth). Length-mismatch is
    // rejected before timingSafeEqual (which requires equal-length buffers).
    const token = payload.headers["x-callback-token"]
    const tokenBuf = Buffer.from(typeof token === "string" ? token : "")
    const expectedBuf = Buffer.from(this.options_.callbackToken)
    const tokenValid =
      tokenBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(tokenBuf, expectedBuf)
    if (!tokenValid) {
      this.logger_.warn("Xendit webhook rejected: invalid x-callback-token")
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    const body = payload.data as unknown as XenditWebhookBody
    const sessionId = body.external_id
    const amount = Number(body.paid_amount ?? body.amount)

    switch (body.status) {
      case "PAID":
      case "SETTLED":
        return {
          action: PaymentActions.SUCCESSFUL,
          data: { session_id: sessionId, amount: new BigNumber(amount) },
        }
      case "EXPIRED":
        return {
          action: PaymentActions.CANCELED,
          data: { session_id: sessionId, amount: new BigNumber(amount) },
        }
      default:
        return { action: PaymentActions.NOT_SUPPORTED }
    }
  }
}

export default XenditProviderService
