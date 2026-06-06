# Changelog

All notable changes to `medusa-payment-xendit` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — unreleased

Initial release: a Medusa v2 payment provider for Xendit's **Invoice API**
(hosted checkout), with a webhook backstop that creates the order server-side
even if the customer never returns to the storefront.

### Added

- **Invoice payment provider** (`XenditProviderService`) implementing the Medusa
  v2 payment provider interface: initiate / authorize / capture / cancel / delete /
  update / retrieve / get-status, backed by the Xendit Invoice API (create, get,
  expire) over `fetch` with HTTP Basic auth.
- **Currency-aware amounts** — amounts are converted using each currency's decimal
  precision (Medusa's `defaultCurrencies`): zero-decimal currencies (IDR, JPY, VND)
  are sent as whole major units, two-decimal currencies (USD, PHP, …) keep their
  cents, and unknown currency codes fall back to two decimals.
- **Idempotency keys** — `context.idempotency_key` is sent as `X-IDEMPOTENCY-KEY`
  on invoice creation so retried creates dedupe. `updatePayment` suffixes the key
  with the new amount on re-create so Xendit doesn't return the stale, expired
  invoice.
- **Webhook backstop** (`getWebhookActionAndData`) with constant-time
  `x-callback-token` verification (length-guarded `crypto.timingSafeEqual`):
  `PAID`/`SETTLED` → successful, `EXPIRED` → canceled, anything else ignored.
- **Amount-change handling** — `updatePayment` expires the stale invoice and
  creates a fresh one when the cart total changes (invoice amounts are immutable).
- **Refunds, record-only** — `refundPayment` records the refund in Medusa but does
  not move money (the Invoice API has no refund endpoint); issue the actual refund
  via the Xendit dashboard.
- **Boot-safe options validation** — `validateOptions` requires `secretKey`;
  `callbackToken` is intentionally optional (a missing webhook token disables the
  backstop and warns, rather than crashing backend boot).
- **Configuration options**: `secretKey` (required), `callbackToken` (recommended),
  `invoiceDuration` (default 24h), `baseUrl` (override for testing/mocks).
- **Tests & CI** — 31 Jest tests (amount conversion, idempotency, status mapping,
  options validation, webhook token verification and action selection) with the
  Xendit HTTP client mocked; GitHub Actions workflow running build + test on Node
  20.x and 22.x.
- **Docs** — README (install, config, webhook setup, storefront recipe, amounts,
  refunds), `CONTRIBUTING.md`.

### Known limitations

- Xendit **Invoice API only** — no direct per-method charges.
- Refunds are **record-only** (no programmatic refund endpoint in the Invoice API).
- Verified end-to-end with **IDR** against Medusa `2.15.3` in Xendit test mode;
  other currencies should be confirmed against a test-mode invoice before use.

[0.1.0]: https://github.com/mhazki/medusa-payment-xendit/releases/tag/v0.1.0
