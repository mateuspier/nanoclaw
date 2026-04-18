import { describe, it, expect, vi } from 'vitest';

import {
  resolveSender,
  resolveRecipient,
  sendOutbound,
  OutboundMessagingError,
  TwilioTransport,
} from './outbound-twilio.js';

// ── resolveSender ────────────────────────────────────────────────────────

describe('resolveSender', () => {
  it('returns the raw phone for SMS', () => {
    expect(
      resolveSender(
        { phone_number: '+12762509968', sms: true, whatsapp: false },
        'sms',
      ),
    ).toEqual({ fromValue: '+12762509968' });
  });

  it('adds whatsapp: prefix for WhatsApp', () => {
    expect(
      resolveSender(
        { phone_number: '+12762509968', sms: true, whatsapp: true },
        'whatsapp',
      ),
    ).toEqual({ fromValue: 'whatsapp:+12762509968' });
  });

  it('throws when the business has no phone', () => {
    expect(() => resolveSender({ phone_number: null }, 'sms')).toThrow(
      OutboundMessagingError,
    );
    expect(() => resolveSender(undefined, 'sms')).toThrow(
      OutboundMessagingError,
    );
  });

  it('throws when SMS is explicitly disabled', () => {
    expect(() =>
      resolveSender({ phone_number: '+1', sms: false, whatsapp: false }, 'sms'),
    ).toThrow(/sms is disabled/i);
  });

  it('throws when WhatsApp is not explicitly enabled (default deny)', () => {
    expect(() => resolveSender({ phone_number: '+1' }, 'whatsapp')).toThrow(
      /whatsapp is disabled/i,
    );
    expect(() =>
      resolveSender({ phone_number: '+1', whatsapp: false }, 'whatsapp'),
    ).toThrow(/whatsapp is disabled/i);
  });
});

// ── resolveRecipient ──────────────────────────────────────────────────────

describe('resolveRecipient', () => {
  it('accepts E.164 and returns it for SMS', () => {
    expect(resolveRecipient('+353851234567', 'sms')).toBe('+353851234567');
  });

  it('prefixes whatsapp: for WhatsApp', () => {
    expect(resolveRecipient('+353851234567', 'whatsapp')).toBe(
      'whatsapp:+353851234567',
    );
  });

  it('rejects missing country code', () => {
    expect(() => resolveRecipient('5551234', 'sms')).toThrow(
      OutboundMessagingError,
    );
  });

  it('rejects pre-prefixed input (must be E.164)', () => {
    expect(() => resolveRecipient('whatsapp:+123', 'whatsapp')).toThrow(
      /channel prefix/i,
    );
  });

  it('rejects numbers starting with +0', () => {
    expect(() => resolveRecipient('+0123456789', 'sms')).toThrow(/E.164/);
  });

  it('trims whitespace', () => {
    expect(resolveRecipient('  +12762509968  ', 'sms')).toBe('+12762509968');
  });
});

// ── sendOutbound ──────────────────────────────────────────────────────────

function stubTransport(response: {
  status: number;
  text: string;
}): TwilioTransport {
  return { post: vi.fn().mockResolvedValue(response) } as TwilioTransport;
}

describe('sendOutbound', () => {
  const validConfig = {
    phone_number: '+12762623230',
    sms: true,
    whatsapp: true,
  };

  it('sends an SMS with correct From/To/Body', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ status: 201, text: '{"sid":"SM_abc"}' });
    const result = await sendOutbound({
      config: validConfig,
      message: {
        businessSlug: 'biz-ie-01',
        channel: 'sms',
        toPhone: '+353851234567',
        body: 'Olá! Teste.',
      },
      transport: { post },
    });

    expect(result.sid).toBe('SM_abc');
    expect(result.sentFrom).toBe('+12762623230');
    expect(result.sentTo).toBe('+353851234567');

    // Inspect the form body passed to the transport.
    const form = post.mock.calls[0][0] as URLSearchParams;
    expect(form.get('From')).toBe('+12762623230');
    expect(form.get('To')).toBe('+353851234567');
    expect(form.get('Body')).toBe('Olá! Teste.');
  });

  it('sends a WhatsApp message with whatsapp: prefix on both ends', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ status: 201, text: '{"sid":"SM_wa"}' });
    const result = await sendOutbound({
      config: validConfig,
      message: {
        businessSlug: 'biz-ie-01',
        channel: 'whatsapp',
        toPhone: '+353851234567',
        body: 'Oi via WhatsApp',
      },
      transport: { post },
    });

    expect(result.sentFrom).toBe('whatsapp:+12762623230');
    expect(result.sentTo).toBe('whatsapp:+353851234567');

    const form = post.mock.calls[0][0] as URLSearchParams;
    expect(form.get('From')).toBe('whatsapp:+12762623230');
    expect(form.get('To')).toBe('whatsapp:+353851234567');
  });

  it('throws body-empty for empty or whitespace-only bodies', async () => {
    await expect(
      sendOutbound({
        config: validConfig,
        message: {
          businessSlug: 'x',
          channel: 'sms',
          toPhone: '+1234567890',
          body: '   ',
        },
        transport: stubTransport({ status: 201, text: '{}' }),
      }),
    ).rejects.toMatchObject({ code: 'body-empty' });
  });

  it('refuses WhatsApp when the business has whatsapp: false', async () => {
    await expect(
      sendOutbound({
        config: { phone_number: '+1', sms: true, whatsapp: false },
        message: {
          businessSlug: 'x',
          channel: 'whatsapp',
          toPhone: '+12762509968',
          body: 'x',
        },
        transport: stubTransport({ status: 201, text: '{}' }),
      }),
    ).rejects.toMatchObject({ code: 'channel-disabled' });
  });

  it('surfaces Twilio 4xx with the API message', async () => {
    const post = vi.fn().mockResolvedValue({
      status: 400,
      text: '{"message":"Invalid \'To\' Phone Number"}',
    });
    await expect(
      sendOutbound({
        config: validConfig,
        message: {
          businessSlug: 'x',
          channel: 'sms',
          toPhone: '+19999999999',
          body: 'x',
        },
        transport: { post },
      }),
    ).rejects.toThrow(/Twilio API 400.*Invalid 'To'/);
  });

  it('surfaces twilio-api code on failure', async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ status: 503, text: 'Service Unavailable' });
    try {
      await sendOutbound({
        config: validConfig,
        message: {
          businessSlug: 'x',
          channel: 'sms',
          toPhone: '+12762509968',
          body: 'x',
        },
        transport: { post },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OutboundMessagingError);
      const e = err as OutboundMessagingError;
      expect(e.code).toBe('twilio-api');
      expect(e.status).toBe(503);
    }
  });

  it('does not call the transport when recipient is invalid', async () => {
    const post = vi.fn();
    await expect(
      sendOutbound({
        config: validConfig,
        message: {
          businessSlug: 'x',
          channel: 'sms',
          toPhone: 'not-a-number',
          body: 'x',
        },
        transport: { post },
      }),
    ).rejects.toMatchObject({ code: 'invalid-recipient' });
    expect(post).not.toHaveBeenCalled();
  });
});
