import { describe, it, expect } from 'vitest';

import {
  detectVerificationCode,
  formatCodeAlert,
} from './sms-code-detector.js';

describe('detectVerificationCode', () => {
  // High-confidence: service + verification phrase + digit group + short
  it('detects a WhatsApp verification code', () => {
    const r = detectVerificationCode(
      'WhatsApp: your code is 123-456. Do not share.',
    );
    expect(r.code).toBe('123456');
    expect(r.service).toBe('WhatsApp');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects a Stripe PIN', () => {
    const r = detectVerificationCode(
      'Your Stripe verification code is 847291.',
    );
    expect(r.code).toBe('847291');
    expect(r.service).toBe('Stripe');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects a Portuguese-BR code phrase', () => {
    const r = detectVerificationCode('Seu código de verificação é 4821.');
    expect(r.code).toBe('4821');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects an OTP', () => {
    const r = detectVerificationCode('Your OTP: 90281');
    expect(r.code).toBe('90281');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('detects with service hint only (no explicit phrase)', () => {
    const r = detectVerificationCode('Meta 583024');
    // Not a strong verification phrase, but short + digits + service → medium
    expect(r.code).toBe('583024');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.service).toBe('Meta');
  });

  it('handles 4-digit codes', () => {
    const r = detectVerificationCode('Your code: 4821');
    expect(r.code).toBe('4821');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('handles 8-digit codes', () => {
    const r = detectVerificationCode('Your one-time passcode is 12345678.');
    expect(r.code).toBe('12345678');
  });

  // Anti-signals: should NOT match
  it('rejects tracking numbers', () => {
    const r = detectVerificationCode(
      'Your shipment tracking: 123456789 arrives Monday.',
    );
    expect(r.code).toBeNull();
    expect(r.confidence).toBeLessThan(0.5);
  });

  it('rejects payment confirmations', () => {
    const r = detectVerificationCode(
      'Payment of R$ 1234 confirmed. Invoice 784512.',
    );
    expect(r.code).toBeNull();
  });

  it('rejects plain customer messages', () => {
    const r = detectVerificationCode('Quanto custa morar em Cork?');
    expect(r.code).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('rejects short replies', () => {
    const r = detectVerificationCode('ok');
    expect(r.code).toBeNull();
  });

  // Edge cases
  it('handles empty / nullish input', () => {
    expect(detectVerificationCode('').code).toBeNull();
    // @ts-expect-error — testing runtime guard
    expect(detectVerificationCode(null).code).toBeNull();
  });

  it('rejects long phone-number-looking digits', () => {
    const r = detectVerificationCode('Call 12345678901 to confirm.');
    // 11-digit phone number should not be a code
    expect(r.code).toBeNull();
  });

  it('surfaces signals for log tuning', () => {
    const r = detectVerificationCode('WhatsApp code: 123456');
    expect(r.signals).toEqual(
      expect.arrayContaining([
        'verification-phrase',
        'digits:6',
        'service:whatsapp',
      ]),
    );
  });
});

describe('formatCodeAlert', () => {
  it('produces a Telegram-formatted alert with code and metadata', () => {
    const out = formatCodeAlert({
      businessSlug: 'biz-ie-01',
      businessName: 'Sou da Irlanda',
      fromNumber: '+12345550000',
      body: 'WhatsApp: your code is 123456.',
      detection: {
        code: '123456',
        confidence: 0.95,
        service: 'WhatsApp',
        signals: ['verification-phrase', 'digits:6'],
      },
    });
    expect(out).toContain('🔐');
    expect(out).toContain('biz-ie-01');
    expect(out).toContain('Sou da Irlanda');
    expect(out).toContain('<code>123456</code>');
    expect(out).toContain('<b>WhatsApp</b>');
  });

  it('uses the weaker icon for medium-confidence detections', () => {
    const out = formatCodeAlert({
      businessSlug: 'biz-br-01',
      businessName: 'MiauPop',
      fromNumber: '+1000',
      body: 'Your OTP: 9281',
      detection: {
        code: '9281',
        confidence: 0.6,
        service: null,
        signals: ['digits:4'],
      },
    });
    expect(out).toContain('🔎');
    expect(out).not.toContain('🔐');
  });

  it('escapes HTML-sensitive characters in sender and body', () => {
    const out = formatCodeAlert({
      businessSlug: 'biz-ie-01',
      businessName: 'Sou da Irlanda',
      fromNumber: '<script>',
      body: 'Your code is <1234>',
      detection: { code: '1234', confidence: 0.9, service: null, signals: [] },
    });
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;1234&gt;');
  });

  it('truncates very long bodies', () => {
    const longBody = 'a'.repeat(800);
    const out = formatCodeAlert({
      businessSlug: 'b',
      businessName: 'B',
      fromNumber: '+1',
      body: longBody,
      detection: { code: '1234', confidence: 0.9, service: null, signals: [] },
    });
    const preserved = out.match(/a+/)?.[0] ?? '';
    expect(preserved.length).toBeLessThanOrEqual(500);
  });
});
