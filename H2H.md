# Host to host: your own payment page

In [INTEGRATION.md](INTEGRATION.md) the payer pays on NovaroPay's hosted page.
In **host to host (H2H)** you show the UPI details on **your own** page or in
your app, and NovaroPay never shows the payer anything. Everything else stays
the same: keys, `Idempotency-Key`, `PSP-Version`, webhooks, `novaro listen`,
magic UTRs and going live. Do steps 1–2.3 of INTEGRATION.md first, then come
back here.

The example shop does both flows. On its home page, **Pay with UPI (our own
page, host to host)** takes the H2H path: `createOrder(…, "h2h")`, `payPage()`
and `confirmUtr()` in `src/server.mjs`. The run below used the production API
in test mode.

## 1. Create the payment without `checkout`

```sh
curl https://api.novaro.ink/payments \
  -H "Authorization: Bearer $NOVARO_API_KEY" \
  -H "PSP-Version: 2026-11-04.acacia" \
  -H "Idempotency-Key: ord_8812:create-payment" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 49900,
    "currency": "INR",
    "payment_method_data": { "type": "upi" },
    "merchant_reference": "ord_8812",
    "customer": { "id": "cus_4921" }
  }'
```

The answer is `201`, with `"channel": "h2h"`, `"checkout": null` and the
details in `next_action` (this is a real answer, shortened):

```json
"status": "awaiting_payer",
"amount": 49900,
"amount_payable": 49900,
"expires_at": 1794079607,
"next_action": {
  "type": "upi_display_details",
  "upi_display_details": {
    "vpa": "test.005@psp",
    "amount": 49900,
    "reference_code": "T5FB3",
    "upi_uri": "upi://pay?pa=test.005@psp&pn=Test%20Wallet%20005&am=499.00&cu=INR&tn=T5FB3",
    "qr_code": {
      "data": "upi://pay?…",
      "image_url_svg": "https://<your checkout domain>/c/…/qr.svg",
      "image_url_png": "https://<your checkout domain>/c/…/qr.png"
    },
    "app_links": [
      { "app": "paytm",   "url": "paytmmp://cash_wallet?…" },
      { "app": "phonepe", "url": "phonepe://native?…" }
    ],
    "hosted_instructions_url": "https://<your checkout domain>/c/…"
  }
},
"confirmation_fields": [ { "name": "utr", "pattern": "^[0-9]{12}$" } ]
```

## 2. Show the details to the payer

| Show | From | Note |
| --- | --- | --- |
| Amount to pay | `upi_display_details.amount` (paise) | This is `amount_payable`, and it can be a few paise **more or less** than your `amount`. Show this one: a payer who pays your round amount pays the wrong sum. |
| QR code | `qr_code.image_url_svg` / `image_url_png`, or render `qr_code.data` yourself | The image URLs work only while the payment waits for the payer; afterwards they answer `410`. Do not cache them. |
| UPI ID | `vpa`, with a Copy button | |
| Note | `reference_code` | The payer puts it in the transfer's note. |
| "Open UPI app" button | `upi_uri` | Any UPI app opens it on a phone. |
| "Open Paytm" / "Open PhonePe" | `app_links[]` | They open the app with the amount and the note locked. The list can be empty: show only the buttons it has. |
| Time left | `expires_at` | |
| A form for the UTR | `confirmation_fields` | 12 digits in India. See step 3. |

**Read the payment again every time you show the page.** While it waits for
the payer, its VPA and amount may change; the `reference_code` stays. Money
sent to earlier details still pays it. `payPage()` in the example reads
`GET /payments/{id}` on every open. Create a new payment for every attempt to
pay: do not show one payment's details for another.

If you would rather not draw the page yourself for some payers,
`hosted_instructions_url` is our page with the same details. It does not
send the payer back to you.

## 3. Pass on the payer's UTR (optional, recommended)

When the payer says they paid, they can type the 12-digit UTR their UPI app
shows. Send it on:

```sh
curl https://api.novaro.ink/payments/pay_in_…/confirmations \
  -H "Authorization: Bearer $NOVARO_API_KEY" \
  -H "PSP-Version: 2026-11-04.acacia" \
  -H "Idempotency-Key: ord_8812:confirm:412345678901" \
  -H "Content-Type: application/json" \
  -d '{ "utr": "412345678901" }'
```

- `200` with the payment, now `processing`. That is not proof: the payment
  succeeds when the money is found, and fails if it is not found within 24
  hours.
- We match payments without a UTR too, from the money that arrives. The UTR
  makes it faster and settles doubtful cases.
- `400 parameter_invalid` means it is not 12 digits. Show the message by the
  field.
- `409 reference_already_used` means that UTR already confirmed or paid
  another payment.
- `409 payment_final` means the payment already succeeded or failed.
- In test mode, the [magic UTRs](INTEGRATION.md#24-create-a-payment-and-send-the-payer-to-the-hosted-page)
  take the payment to the status you choose: `000000000001` succeeds at once.

## 4. Learn the result and deliver

The same as with the hosted page:

- **Deliver on `payment.succeeded`** (the webhook), or on a
  `GET /payments/{id}` that says `succeeded`, whichever comes first, once.
  Credit `amount_credited`.
- While the payer waits on your page, poll `GET /payments/{id}` every few
  seconds, or push the webhook's result to the page. Stop polling when the
  status is final.
- `expired` is not final in practice: a late payment can still succeed.
  Keep the order open until `succeeded` or `failed`.

## What the run on production showed

`ord_6a6e871d` was paid through the example shop's own page, in test mode:

| Step | Result |
| --- | --- |
| `POST /payments` without `checkout` | `201`, `channel: h2h`, our page showed ₹512.34, UPI ID `test.006@psp`, note `CQTKY`, a QR code, and Open Paytm, Open PhonePe and Open a UPI app |
| UTR `123` | `400`, the page showed "not a valid UTR" |
| UTR `000000000001` | `200`, payment `processing`, then `succeeded` |
| Webhooks | `payment.created`, `payment.processing` and `payment.succeeded`, every signature valid |
| The order | `succeeded`, credited ₹512.34, delivered once |
| QR image | `200` while waiting, `410` once the payment was final |

## Hosted page or H2H?

| | Hosted page | H2H |
| --- | --- | --- |
| Who draws the payment screen | NovaroPay, on your checkout domain, in your brand | you |
| Code on your side | a redirect and the way back | the page, the UTR form, polling |
| The UTR form | on the page | yours, then `POST /payments/{id}/confirmations` |
| Details changing while the payer waits | the page follows them | you read the payment again |
| Works in your app without a WebView | no | yes |
