/**
 * Twilio outbound messaging — agnostic to SMS vs WhatsApp.
 *
 * Wraps the Twilio Messages API so NanoClaw can send to arbitrary recipients
 * (broadcasts, first-touch messages, verification replies) on a chosen
 * channel, not only as a reply to the last inbound sender.
 *
 * Separate from `sendMessage(jid, text)` in the TwilioChannel (which is a
 * REPLY-to-last-sender primitive). This module is for OUTBOUND-INITIATED
 * traffic.
 *
 * Callers resolve the business's "From" number from businesses.json via
 * `resolveSender()` and the channel's whatsapp/sms toggle gates which modes
 * are allowed.
 */
import https from 'https';

export interface BusinessTwilioConfig {
  phone_number: string | null;
  phone_sid?: string | null;
  sms?: boolean;
  whatsapp?: boolean;
}

export interface OutboundMessage {
  /** Business slug, e.g. "biz-ie-01". */
  businessSlug: string;
  /** Channel to send on. Only 'sms' and 'whatsapp' are supported today. */
  channel: 'sms' | 'whatsapp';
  /** E.164 recipient number, e.g. "+353851234567". No "whatsapp:" prefix. */
  toPhone: string;
  /** Message body. Caller is responsible for length + template approval. */
  body: string;
}

export interface OutboundResult {
  sid: string;
  /** The URL-encoded body we actually POSTed — useful for audit logging. */
  sentFrom: string;
  sentTo: string;
}

export class OutboundMessagingError extends Error {
  constructor(
    public readonly code:
      | 'channel-disabled'
      | 'no-phone'
      | 'invalid-recipient'
      | 'body-empty'
      | 'twilio-api',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'OutboundMessagingError';
  }
}

/**
 * Resolve the "From" number + channel prefix for an outbound send.
 *
 * @param config the business's `channels.twilio` block from businesses.json
 * @param channel 'sms' | 'whatsapp'
 * @returns `{ fromValue }` ready to pass to Twilio's From field
 *          (e.g. "+12762509968" or "whatsapp:+12762509968")
 * @throws OutboundMessagingError when the channel is disabled in config
 */
export function resolveSender(
  config: BusinessTwilioConfig | undefined,
  channel: 'sms' | 'whatsapp',
): { fromValue: string } {
  if (!config || !config.phone_number) {
    throw new OutboundMessagingError(
      'no-phone',
      'no Twilio phone configured for this business',
    );
  }
  if (channel === 'sms' && config.sms === false) {
    throw new OutboundMessagingError(
      'channel-disabled',
      'sms is disabled for this business',
    );
  }
  if (channel === 'whatsapp' && config.whatsapp !== true) {
    throw new OutboundMessagingError(
      'channel-disabled',
      'whatsapp is disabled for this business (flip whatsapp:true in businesses.json and complete Twilio sender registration)',
    );
  }
  const fromValue =
    channel === 'whatsapp'
      ? `whatsapp:${config.phone_number}`
      : config.phone_number;
  return { fromValue };
}

/**
 * Resolve the "To" value. Validates E.164 shape and adds the channel prefix.
 */
export function resolveRecipient(
  toPhone: string,
  channel: 'sms' | 'whatsapp',
): string {
  if (!toPhone || typeof toPhone !== 'string') {
    throw new OutboundMessagingError(
      'invalid-recipient',
      'recipient phone is empty',
    );
  }
  const trimmed = toPhone.trim();
  if (trimmed.startsWith('whatsapp:')) {
    throw new OutboundMessagingError(
      'invalid-recipient',
      'pass the recipient as E.164 (+...) — channel prefix is applied internally',
    );
  }
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
    throw new OutboundMessagingError(
      'invalid-recipient',
      `recipient must be E.164 (e.g. +12765550000), got ${trimmed}`,
    );
  }
  return channel === 'whatsapp' ? `whatsapp:${trimmed}` : trimmed;
}

// ── HTTP transport ────────────────────────────────────────────────────────

/**
 * Minimal Twilio Messages API client. Keep-alive, 10-socket pool.
 *
 * Injected so tests (and circuit-breaker wiring) can substitute a stub.
 */
export interface TwilioTransport {
  post(body: URLSearchParams): Promise<{ status: number; text: string }>;
}

export function createTwilioTransport(
  accountSid: string,
  authToken: string,
): TwilioTransport {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 10 });
  return {
    post(body) {
      const payload = body.toString();
      return new Promise((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.twilio.com',
            path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
            method: 'POST',
            auth: `${accountSid}:${authToken}`,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Content-Length': Buffer.byteLength(payload),
            },
            agent,
          },
          (res) => {
            let text = '';
            res.on('data', (chunk: Buffer) => (text += chunk.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
          },
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    },
  };
}

// ── Send ──────────────────────────────────────────────────────────────────

/**
 * Send an outbound message on the given channel to the given recipient.
 *
 * Pure orchestration: resolve sender + recipient, POST to Twilio, surface a
 * typed error on failure. Caller chooses whether to wrap this in a
 * circuit-breaker / response-cache store / retry policy.
 */
export async function sendOutbound(params: {
  config: BusinessTwilioConfig | undefined;
  message: OutboundMessage;
  transport: TwilioTransport;
}): Promise<OutboundResult> {
  const { config, message, transport } = params;

  if (!message.body || message.body.trim().length === 0) {
    throw new OutboundMessagingError('body-empty', 'message body is empty');
  }

  const { fromValue } = resolveSender(config, message.channel);
  const toValue = resolveRecipient(message.toPhone, message.channel);

  const form = new URLSearchParams({
    From: fromValue,
    To: toValue,
    Body: message.body,
  });

  const { status, text } = await transport.post(form);
  if (status >= 400) {
    let twilioMessage = text;
    try {
      const parsed = JSON.parse(text);
      twilioMessage = parsed?.message ?? text;
    } catch {
      // keep raw text
    }
    throw new OutboundMessagingError(
      'twilio-api',
      `Twilio API ${status}: ${twilioMessage}`,
      status,
    );
  }

  let sid = '';
  try {
    const parsed = JSON.parse(text);
    sid = typeof parsed?.sid === 'string' ? parsed.sid : '';
  } catch {
    // Body wasn't JSON but status was 2xx — odd but not fatal.
  }

  return { sid, sentFrom: fromValue, sentTo: toValue };
}
