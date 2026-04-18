import { describe, it, expect } from 'vitest';

import {
  detectWaitlistConfirmation,
  waitlistAddedMessage,
} from './waitlist-detector.js';

describe('detectWaitlistConfirmation — bare-word (confidence 1.0)', () => {
  it('detects AVISAR (pt-BR)', () => {
    const r = detectWaitlistConfirmation('AVISAR');
    expect(r.isConfirmation).toBe(true);
    expect(r.language).toBe('pt-BR');
    expect(r.confidence).toBe(1.0);
  });

  it('detects lowercase "avise"', () => {
    const r = detectWaitlistConfirmation('avise');
    expect(r.isConfirmation).toBe(true);
    expect(r.keyword).toBe('AVISE');
  });

  it('detects NOTIFY (en)', () => {
    const r = detectWaitlistConfirmation('notify');
    expect(r.isConfirmation).toBe(true);
    expect(r.language).toBe('en');
  });

  it('detects APUNTAR (es)', () => {
    const r = detectWaitlistConfirmation('APUNTAR');
    expect(r.isConfirmation).toBe(true);
    expect(r.language).toBe('es');
  });

  it('detects with punctuation', () => {
    const r = detectWaitlistConfirmation('AVISAR!!!');
    expect(r.isConfirmation).toBe(true);
  });
});

describe('detectWaitlistConfirmation — short phrases (confidence ~0.85)', () => {
  it('detects "avisar sim"', () => {
    const r = detectWaitlistConfirmation('avisar sim');
    expect(r.isConfirmation).toBe(true);
  });

  it('detects "quero avisar"', () => {
    const r = detectWaitlistConfirmation('quero avisar');
    expect(r.isConfirmation).toBe(true);
  });

  it('detects "please notify me" at 3 tokens', () => {
    const r = detectWaitlistConfirmation('please notify me');
    expect(r.isConfirmation).toBe(true);
    expect(r.keyword).toBe('NOTIFY');
  });
});

describe('detectWaitlistConfirmation — false positives suppressed', () => {
  it('does NOT match a generic "sim"', () => {
    const r = detectWaitlistConfirmation('sim');
    expect(r.isConfirmation).toBe(false);
  });

  it('does NOT match a generic "yes"', () => {
    const r = detectWaitlistConfirmation('yes');
    expect(r.isConfirmation).toBe(false);
  });

  it('does NOT match "quero saber quando sai"', () => {
    const r = detectWaitlistConfirmation('quero saber quando sai o filme');
    expect(r.isConfirmation).toBe(false);
  });

  it('does NOT match a long message even with keyword embedded', () => {
    const r = detectWaitlistConfirmation(
      'pode avisar quando tiver algum acontecimento novo em Cork por favor',
    );
    expect(r.isConfirmation).toBe(false);
  });

  it('does NOT match general customer questions', () => {
    const r = detectWaitlistConfirmation('qual o horario da loja?');
    expect(r.isConfirmation).toBe(false);
    expect(r.confidence).toBe(0);
  });
});

describe('detectWaitlistConfirmation — edges', () => {
  it('handles empty input', () => {
    expect(detectWaitlistConfirmation('').isConfirmation).toBe(false);
    // @ts-expect-error runtime guard
    expect(detectWaitlistConfirmation(null).isConfirmation).toBe(false);
  });

  it('strips accents', () => {
    const r = detectWaitlistConfirmation('avísãr'); // junk accents, still matches AVISAR
    expect(r.isConfirmation).toBe(true);
  });
});

describe('waitlistAddedMessage', () => {
  it('produces a pt-BR confirmation', () => {
    const msg = waitlistAddedMessage('pt-BR', { businessName: 'MiauPop' });
    expect(msg).toMatch(/avisar/i);
    expect(msg).toContain('MiauPop');
  });

  it('produces an es confirmation', () => {
    const msg = waitlistAddedMessage('es', {
      businessName: 'Sou da Irlanda',
      productLabel: 'lista de espera',
    });
    expect(msg).toMatch(/apuntamos/i);
    expect(msg).toContain('Sou da Irlanda');
  });

  it('produces an en confirmation', () => {
    const msg = waitlistAddedMessage('en', { businessName: 'MiauPop' });
    expect(msg).toMatch(/waitlist/i);
  });

  it('falls back to english when language is null', () => {
    const msg = waitlistAddedMessage(null, { businessName: 'MiauPop' });
    expect(msg).toMatch(/waitlist/i);
  });

  it('honors a custom product label', () => {
    const msg = waitlistAddedMessage('pt-BR', {
      businessName: 'MiauPop',
      productLabel: 'drops do PopMart',
    });
    expect(msg).toContain('drops do PopMart');
  });
});
