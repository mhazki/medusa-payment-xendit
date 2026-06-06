# medusa-payment-xendit

A [Xendit](https://www.xendit.co/) payment provider for **Medusa v2**, built on Xendit's
**Invoice API** (hosted checkout). Customer is redirected to a Xendit-hosted invoice page; a
webhook backstop creates the order server-side even if the customer never returns to your store.

Verified against Medusa **2.15.3** in Xendit **test mode** with IDR (see
[Amounts & currency](#amounts--currency)).

> Not affiliated with or endorsed by Xendit. "Xendit" is a trademark of its owner; this is a
> community plugin named per Medusa's `medusa-payment-*` convention.

---

## Install

```bash
npm install medusa-payment-xendit
```

## Configure

Register it as a payment provider in `medusa-config.ts` under `Modules.PAYMENT`:

```ts
import { Modules } from "@medusajs/framework/utils"

module.exports = defineConfig({
  modules: [
    {
      key: Modules.PAYMENT,
      resolve: "@medusajs/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-xendit",
            id: "xendit",
            options: {
              secretKey: process.env.XENDIT_SECRET_KEY,       // required
              callbackToken: process.env.XENDIT_CALLBACK_TOKEN, // strongly recommended
              // invoiceDuration: 86400, // optional, seconds (default 24h)
              // baseUrl: "https://api.xendit.co", // optional, override for mocks
            },
          },
        ],
      },
    },
  ],
})
```

| Option | Required | Default | Notes |
|---|---|---|---|
| `secretKey` | yes | — | Xendit secret API key (server-side). Use a test-mode key until verified. |
| `callbackToken` | recommended | — | Webhook verification token from the Xendit dashboard. **Missing it disables the webhook backstop** (the provider warns at boot but does not crash). |
| `invoiceDuration` | no | `86400` | Invoice lifetime in seconds before auto-expiry. |
| `baseUrl` | no | `https://api.xendit.co` | Override only for testing/mocks. |

`validateOptions` throws if `secretKey` is missing. `callbackToken` is deliberately *not* required
so a misconfigured env can't take down backend boot — webhooks are simply rejected until it's set.

## Webhook setup

> ⚠️ **The single thing that costs everyone hours.** The provider id is `pp_xendit_<id>`, but the
> webhook route param is **`xendit_<id>` with NO `pp_` prefix** — Medusa prepends `pp_` itself.

With `id: "xendit"` (as above), the provider id is `pp_xendit_xendit` and the webhook URL is:

```
https://<your-backend>/hooks/payment/xendit_xendit
```

In the **Xendit dashboard → Settings → Webhooks**, set the **Invoices** callback URL (the
"Invoice paid" event) to that URL. Copy the **webhook verification token** shown there into
`XENDIT_CALLBACK_TOKEN`. Xendit sends it as the `x-callback-token` header on every callback; the
provider verifies it with a constant-time comparison and rejects mismatches.

Handled webhook statuses: `PAID`/`SETTLED` → payment successful (order created); `EXPIRED` →
canceled; anything else → ignored.

## Storefront recipe

A payment provider can't ship storefront UI — the redirect button and return page are app-specific.
Below is the pattern, lifted from a working Next.js Medusa storefront. Two pieces:

**1. On "Pay", create the session with redirect URLs, then send the customer to `invoice_url`:**

```tsx
// in your payment step's submit handler
if (isXendit(selectedPaymentMethod)) {
  let invoiceUrl = checkActiveSession
    ? (activeSession?.data?.invoice_url as string | undefined)
    : undefined

  if (!invoiceUrl) {
    const resp = await initiatePaymentSession(cart, {
      provider_id: selectedPaymentMethod,
      data: {
        success_redirect_url: `${window.location.origin}/${countryCode}/checkout/payment-callback?cart_id=${cart.id}`,
        failure_redirect_url: `${window.location.origin}/${countryCode}/checkout?step=payment&xendit=failed`,
      },
    })
    invoiceUrl = resp.payment_collection?.payment_sessions
      ?.find((s) => isXendit(s.provider_id))
      ?.data?.invoice_url as string | undefined
  }

  if (!invoiceUrl) throw new Error("Could not get payment URL. Please try again.")
  window.location.href = invoiceUrl
  return
}

// helper
export const isXendit = (providerId?: string) => providerId?.startsWith("pp_xendit")
```

The `success_redirect_url` / `failure_redirect_url` you pass in `data` are forwarded to Xendit's
invoice and used for the post-payment redirect.

**2. A return page that completes the cart in an action context — NOT during server render:**

```tsx
"use client"
// /checkout/payment-callback — Xendit returns the customer here on success.
export default function PaymentCallbackClient({ cartId }: { cartId?: string }) {
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    // placeOrder is a Server Action that redirects on success. It MUST run in an
    // action context (this effect), never during server render — revalidateTag /
    // cookie writes / redirect all throw during render.
    placeOrder(cartId).catch(() => {/* webhook backstop will finish it */})
  }, [cartId])
  return <p>Confirming your payment…</p>
}
```

If completion can't finish on the return page (payment still settling, or the customer closed the
tab), the **webhook backstop** creates the order server-side. The two paths are idempotent —
Medusa's payment workflow guards against double cart completion.

## Amounts & currency

Amounts are converted **per currency** using each currency's decimal precision (from Medusa's
`defaultCurrencies`). Zero-decimal currencies — IDR, JPY, VND — are sent as whole major units
(`Rp 10.000` → `10000`, no ×100); two-decimal currencies — USD, PHP, etc. — keep their cents
(`$10.50` → `10.5`). Unknown currency codes fall back to two decimals.

Note that Xendit invoice amounts are major-unit values (not the smallest unit), so this provider
sends e.g. `10.5` for USD rather than `1050`. Only IDR has been verified end-to-end; if you use
another currency, confirm the unit handling against a Xendit test-mode invoice first.

## Refunds

Xendit's Invoice API has **no programmatic refund endpoint**. `refundPayment` records the refund in
Medusa (order totals/status, refund email) but does **not** move money — issue the actual refund
manually via the Xendit dashboard.

## Tested Medusa versions

- Medusa `2.15.3` (Xendit test mode, end to end: redirect happy path + webhook backstop).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, scripts, and
conventions. Release notes live in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT — see [LICENSE](./LICENSE).
