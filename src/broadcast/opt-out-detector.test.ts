import { describe, it, expect } from 'vitest';

import {
  detectOptOut,
  normalizeBody,
  confirmationMessage,
} from './opt-out-detector.js';

describe('normalizeBody', () => {
  it('trims, uppercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeBody('  Pare, por favor! ')).toBe('PARE POR FAVOR');
  });

  it('strips Portuguese diacritics', () => {
    expect(normalizeBody('não, pare!')).toBe('NAO PARE');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(normalizeBody('   ')).toBe('');
  });
});

// ── High-confidence bare-word opt-outs ────────────────────────────────────

describe('detectOptOut — bare-word (confidence 1.0)', () => {
  it('detects STOP', () => {
    const r = detectOptOut('STOP');
    expect(r.isOptOut).toBe(true);
    expect(r.keyword).toBe('STOP');
    expect(r.language).toBe('en');
    expect(r.confidence).toBe(1.0);
  });

  it('detects PARE (pt-BR)', () => {
    const r = detectOptOut('PARE');
    expect(r.isOptOut).toBe(true);
    expect(r.language).toBe('pt-BR');
  });

  it('detects SAIR (pt-BR)', () => {
    const r = detectOptOut('sair');
    expect(r.isOptOut).toBe(true);
    expect(r.keyword).toBe('SAIR');
    expect(r.language).toBe('pt-BR');
  });

  it('detects UNSUBSCRIBE', () => {
    const r = detectOptOut('unsubscribe');
    expect(r.isOptOut).toBe(true);
    expect(r.language).toBe('en');
  });

  it('detects DESCADASTRAR with punctuation', () => {
    const r = detectOptOut('DESCADASTRAR!');
    expect(r.isOptOut).toBe(true);
    expect(r.keyword).toBe('DESCADASTRAR');
  });

  it('detects BAJA (es)', () => {
    const r = detectOptOut('baja');
    expect(r.isOptOut).toBe(true);
    expect(r.language).toBe('es');
  });
});

// ── Short messages with keyword (confidence 0.85) ────────────────────────

describe('detectOptOut — short messages (confidence ~0.85)', () => {
  it('detects "por favor pare"', () => {
    const r = detectOptOut('por favor pare');
    expect(r.isOptOut).toBe(true);
    expect(r.keyword).toBe('PARE');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('detects "stop sending me messages" at 4 tokens', () => {
    const r = detectOptOut('stop sending me messages');
    expect(r.isOptOut).toBe(true);
  });

  it('detects "sair da lista"', () => {
    const r = detectOptOut('sair da lista');
    expect(r.isOptOut).toBe(true);
    expect(r.keyword).toBe('SAIR');
  });
});

// ── False-positive suppression ────────────────────────────────────────────

describe('detectOptOut — false-positive suppression', () => {
  it('does not match "stop the war" (5+ tokens)', () => {
    const r = detectOptOut('please help us stop the war');
    expect(r.isOptOut).toBe(false);
  });

  it('does not match "para você mais tarde" (preposition ambiguity)', () => {
    const r = detectOptOut('enviar para você mais tarde');
    expect(r.isOptOut).toBe(false);
  });

  it('does not match "cancel the reservation I made"', () => {
    const r = detectOptOut('cancel the reservation I made');
    expect(r.isOptOut).toBe(false);
  });

  it('does not match "remove it from the cart please"', () => {
    const r = detectOptOut('remove it from the cart please');
    expect(r.isOptOut).toBe(false);
  });

  it('does not match a general customer message', () => {
    const r = detectOptOut('Quanto custa morar em Cork?');
    expect(r.isOptOut).toBe(false);
    expect(r.confidence).toBe(0);
  });

  it('ambiguous "PARA" alone is treated as opt-out (bare-word wins)', () => {
    // Portuguese "para" can be preposition, but bare-word matches the es
    // opt-out keyword at confidence 1.0. Intentional: users who send a
    // single word "para" on SMS/WhatsApp in this context almost always
    // mean to stop.
    const r = detectOptOut('para');
    expect(r.isOptOut).toBe(true);
  });

  it('ambiguous "PARA você" (2 tokens) still trips — acceptable false-positive floor', () => {
    const r = detectOptOut('para você');
    expect(r.isOptOut).toBe(true);
  });

  it('ambiguous "PARA" in ≥ 3-token messages no longer trips', () => {
    const r = detectOptOut('enviar para amanha');
    expect(r.isOptOut).toBe(false);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe('detectOptOut — edge cases', () => {
  it('handles empty input', () => {
    expect(detectOptOut('').isOptOut).toBe(false);
    // @ts-expect-error — runtime guard
    expect(detectOptOut(null).isOptOut).toBe(false);
  });

  it('handles whitespace-only input', () => {
    expect(detectOptOut('   ').isOptOut).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(detectOptOut('Stop').isOptOut).toBe(true);
    expect(detectOptOut('PaRe').isOptOut).toBe(true);
  });

  it('handles extra whitespace', () => {
    expect(detectOptOut('   STOP   ').isOptOut).toBe(true);
  });
});

// ── Language resolution ───────────────────────────────────────────────────

describe('detectOptOut — language picked matches keyword origin', () => {
  it('STOP → en', () => {
    expect(detectOptOut('STOP').language).toBe('en');
  });
  it('PARE → pt-BR', () => {
    expect(detectOptOut('PARE').language).toBe('pt-BR');
  });
  it('BAJA → es', () => {
    expect(detectOptOut('BAJA').language).toBe('es');
  });
});

// ── confirmationMessage ──────────────────────────────────────────────────

describe('confirmationMessage', () => {
  it('pt-BR string is Portuguese', () => {
    const msg = confirmationMessage('pt-BR');
    expect(msg).toMatch(/descadastrado/i);
    expect(msg).toMatch(/ENTRAR/);
  });

  it('es string is Spanish', () => {
    const msg = confirmationMessage('es');
    expect(msg).toMatch(/baja/i);
    expect(msg).toMatch(/ALTA/);
  });

  it('en string is English', () => {
    const msg = confirmationMessage('en');
    expect(msg).toMatch(/unsubscribed/i);
    expect(msg).toMatch(/JOIN/);
  });

  it('null falls back to English', () => {
    expect(confirmationMessage(null)).toMatch(/unsubscribed/i);
  });
});
