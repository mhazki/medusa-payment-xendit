export type XenditOptions = {
  // Xendit secret API key (server-side). Use a test-mode key until verified.
  secretKey: string
  // Verification token from the Xendit dashboard's webhook settings. Sent by
  // Xendit as the `x-callback-token` header on every callback.
  callbackToken: string
  // Invoice lifetime in seconds before it auto-expires. Defaults to 24h.
  invoiceDuration?: number
  // Base URL for the Xendit API. Override only for testing/mocks.
  baseUrl?: string
}

export type XenditInvoiceStatus = "PENDING" | "PAID" | "SETTLED" | "EXPIRED"

// Subset of the Create/Get Invoice response we rely on.
export type XenditInvoice = {
  id: string
  external_id: string
  status: XenditInvoiceStatus
  amount: number
  invoice_url: string
  currency: string
  payer_email?: string
  paid_amount?: number
}

// Subset of the invoice webhook callback body.
export type XenditWebhookBody = {
  id: string
  external_id: string
  status: XenditInvoiceStatus
  amount: number
  paid_amount?: number
  currency?: string
}

// Shape we persist in the Medusa payment session/payment `data` field.
export type XenditSessionData = {
  invoice_id: string
  invoice_url: string
  external_id: string
  status: XenditInvoiceStatus
  amount: number
  currency: string
}
