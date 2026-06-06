# Contributing to medusa-payment-xendit

Thanks for your interest in improving this provider. It's a community plugin
(not affiliated with Xendit or Medusa), and contributions — bug reports, docs,
tests, and code — are welcome.

## Getting set up

Requires **Node.js 20+**.

```bash
git clone https://github.com/mhazki/medusa-payment-xendit.git
cd medusa-payment-xendit
npm install
```

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Type-check and compile `src/` → `dist/` with `tsc`. |
| `npm run dev` | Same, in watch mode. |
| `npm test` | Run the Jest test suite. |

Before opening a PR, make sure **both** `npm run build` and `npm test` pass —
CI runs exactly these on Node 20.x and 22.x.

## Project layout

The provider is intentionally small — three source files:

- `src/service.ts` — `XenditProviderService`: the Xendit Invoice API client
  (create / get / expire via `fetch`), amount conversion, status mapping, the
  full Medusa payment-provider interface, and `getWebhookActionAndData` with
  timing-safe `x-callback-token` verification.
- `src/types.ts` — `XenditOptions` plus the invoice / webhook / session-data types.
- `src/index.ts` — the `ModuleProvider(Modules.PAYMENT, …)` export.

Tests live in `src/__tests__/`. The Xendit HTTP client is mocked via
`global.fetch`; tests don't make real network calls and need no credentials.

## Tests

Please add or update tests for any behavior change. Existing coverage includes
amount conversion per currency, idempotency-key handling, status mapping,
options validation, and webhook token verification / action selection — use
`src/__tests__/service.test.ts` as a pattern.

The build emits to `dist/` and tests are excluded from it (`tsconfig.json`
`exclude` + `files: ["dist"]`), so test files never ship in the published package.

## Coding conventions

- TypeScript, `strict` mode. No new runtime dependencies — the provider relies
  only on Node built-ins (`fetch`, `crypto`) and Medusa peer dependencies.
- Match the surrounding style: explanatory comments for non-obvious behavior
  (the webhook path quirk, idempotency-on-update, timing-safe compare), and
  keep amounts/currency handling currency-aware rather than IDR-specific.

## Gotchas worth knowing

- **Webhook path has no `pp_` prefix.** The provider id is `pp_xendit_<id>`, but
  the webhook route is `/hooks/payment/xendit_<id>` — Medusa prepends `pp_` to the
  route param itself.
- **`expireInvoice` uses `/invoices/{id}/expire!`** (note the `!` and no `/v2`),
  unlike create/get which are `/v2/invoices`. This matches Xendit's API.
- **Storefront return-page completion must run in an action context**, never
  during server render (`revalidateTag` / cookie writes / `redirect` throw there).
  See the README storefront recipe.

## Submitting changes

1. Branch off `main`.
2. Make your change with tests; keep commits focused.
3. Ensure `npm run build` and `npm test` pass.
4. Open a PR against `main` describing the change and the reasoning.

## Reporting bugs

Open an issue at
<https://github.com/mhazki/medusa-payment-xendit/issues> with your Medusa and
plugin versions, the currency involved, and (for webhook issues) whether
`callbackToken` is configured. Never paste secret keys or live callback tokens.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
