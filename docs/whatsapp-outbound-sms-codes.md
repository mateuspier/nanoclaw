# WhatsApp outbound + SMS verification codes

Both active businesses (biz-ie-01 Sou da Irlanda, biz-br-01 MiauPop) are configured to:

1. **Send WhatsApp outbound** to arbitrary recipients (broadcasts, first-touch messages, digests).
2. **Receive SMS verification codes** from third-party services (WhatsApp Business, Stripe, Meta, PayPal, etc.), with a prominent alert surfaced on Telegram rather than buried in the conversation log.

The code for both is shipped on this branch; only the outbound WhatsApp path requires external (Twilio + Meta) approval before real sends work.

## What shipped in code

| File | Role |
|---|---|
| `src/channels/messaging/outbound-twilio.ts` | `sendOutbound({ config, message, transport })`. Resolves From/To with the `whatsapp:` prefix, posts to Twilio's Messages API, throws typed `OutboundMessagingError` with codes `channel-disabled` / `no-phone` / `invalid-recipient` / `body-empty` / `twilio-api`. |
| `src/channels/messaging/sms-code-detector.ts` | `detectVerificationCode(body)` returns `{ code, confidence, service, signals }`. `formatCodeAlert(...)` produces a Telegram-HTML alert string. |
| `data/businesses.json` | `whatsapp: true` flipped for biz-ie-01 and biz-br-01. biz-cn-01 remains `whatsapp: false`. |
| Tests | 36 vitest cases (18 outbound + 18 detector). `npx tsc --noEmit` clean. |

## What you still need to do (outside the repo)

### A. Enable WhatsApp Business on each Twilio number

WhatsApp can't be sent from a Twilio number until Meta has approved the sender. Steps:

1. **Create a WhatsApp Sender** in Twilio Console → Messaging → Senders → WhatsApp. Choose "Twilio phone number" and pick `+12762623230` (biz-ie-01) or `+12762509968` (biz-br-01).
2. **Business verification** — link a verified Meta Business Manager account. If you don't have one: create `business.facebook.com`, verify with a utility bill / DNS record. Takes ~24 h for Meta to approve.
3. **Submit for WhatsApp Business approval**. Meta reviews the business profile + phone number. Typical turnaround: 1–3 business days.
4. **Register approved message templates.** For *marketing* outbound (broadcasts to people who haven't messaged you first), Meta requires each template be approved. Keep templates in `docs/whatsapp-templates/<name>.yaml` and submit via Twilio Console.
5. **For testing right now** — use the [Twilio Sandbox](https://console.twilio.com/us1/develop/sms/whatsapp/sandbox). The sandbox works instantly but only delivers to numbers that have sent `join <your-code>` to the sandbox number. Fine for internal tests.

**Until Meta approves the sender**, `sendOutbound` will work in code but Twilio's API will return 63007 ("Channel not found for sender"). Don't panic; that's expected.

### B. Verify SMS code relay is wired

The detector is shipped. Wiring it into `src/channels/twilio.ts` (post-`parseUrlEncoded` in the webhook handler) is the last 10-line patch:

```ts
import {
  detectVerificationCode,
  formatCodeAlert,
} from './messaging/sms-code-detector.js';

// Inside the SMS webhook handler, right after parsing the inbound message:
if (!isWhatsApp) {
  const detection = detectVerificationCode(msg.Body);
  if (detection.confidence >= 0.5 && detection.code) {
    const alertText = formatCodeAlert({
      businessSlug: slug,
      businessName: this.slugToName.get(slug) ?? slug,
      fromNumber: senderPhone,
      body: msg.Body,
      detection,
    });
    postToAlertsChannel(alertText);
  }
}
```

Leaving the actual edit for a reviewed commit since it touches the live webhook hot path.

### C. Using the outbound primitive

```ts
import { sendOutbound, createTwilioTransport } from './channels/messaging/outbound-twilio.js';
import businesses from '../data/businesses.json';

const transport = createTwilioTransport(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

await sendOutbound({
  config: businesses.businesses['biz-ie-01'].channels.twilio,
  message: {
    businessSlug: 'biz-ie-01',
    channel: 'whatsapp',
    toPhone: '+353851234567',      // E.164, no whatsapp: prefix
    body: 'Olá! Primeira edição do Cork Weekly: 3 apartamentos novos em Douglas...',
  },
  transport,
});
```

For broadcasts, wrap this in the `broadcast` skill (not built yet — item 11 on the roadmap). For now you can do one-off sends from a script.

## What the user experience looks like

### Inbound SMS verification code — example

When Twilio's number receives this SMS from, say, WhatsApp Business:

```
<#> WhatsApp: your code is 123-456
You can also tap this link to verify your phone: ...
```

Telegram's alerts channel gets a prominent message:

```
🔐 SMS verification code — [biz-ie-01] Sou da Irlanda
from +18888888888 · service: WhatsApp

code: 123456  confidence: 0.95

WhatsApp: your code is 123-456
You can also tap this link to verify your phone: ...
```

That way: signing up for WhatsApp Business (or Stripe, PayPal, Meta Ads, etc.) using the business number surfaces the code in ~2 seconds and can't be missed alongside customer conversations.

### Outbound WhatsApp — first send

Once Meta approves the sender (step A), you can send:

```bash
# From your local machine or the server, with TWILIO_* env vars set:
npx tsx -e '
import { sendOutbound, createTwilioTransport } from "./src/channels/messaging/outbound-twilio.js";
import businesses from "./data/businesses.json" with { type: "json" };
const transport = createTwilioTransport(
  process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN,
);
await sendOutbound({
  config: businesses.businesses["biz-ie-01"].channels.twilio,
  message: {
    businessSlug: "biz-ie-01",
    channel: "whatsapp",
    toPhone: "+353851234567",
    body: "Test message from NanoClaw outbound.",
  },
  transport,
});
'
```

If you get a 63007 back, the sender isn't approved yet. If you get a 2xx + `sid`, it's live.

## Ops + policy reminders

- **Opt-in is mandatory** on WhatsApp. Sending marketing to someone who hasn't opted in gets the sender banned; Meta enforces this aggressively. The broadcast skill (roadmap item 11) will track opt-in per contact in the `contacts` table.
- **Session vs template** — a "session" message can be sent freely within 24 h of the user's last inbound message. After 24 h, you need an approved **template** ("cork-weekly-digest", "miaupop-drop-alert"). Design templates to be renderable with user-specific variables.
- **SMS vs WhatsApp cost** — WhatsApp conversation fees are category-priced (marketing > utility > authentication > service). See Twilio's pricing page; keep the ratio visible on `/custos`.
- **biz-cn-01 (Genius)** — WhatsApp is not enabled. WhatsApp is banned in China; if you ever want to message CN recipients, use WeChat + the `wechat` config block (not yet wired in code).

## Related roadmap items

- **Broadcast skill + contacts CRM** — the outbound primitive needed to scale from one-off sends to audience-level cadence. See `_live/roadmap-2026-q2.md` item 11.
- **Circuit-breaker wiring for `twilio.sms` + `twilio.whatsapp`** — shipped module on `feat/response-cache` branch; wrap `sendOutbound` once that branch merges.
