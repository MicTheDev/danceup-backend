// Single source of truth for DanceUp's platform processing fee. Previously drifted out of
// sync across call sites (the real fee moved 1.5% -> 0.75% -> 1.25% over time while a
// separate ticket-price gross-up calculation stayed hardcoded at an old "1% + $0.25"
// assumption) — centralizing here so there's only one place to update going forward.
export const PLATFORM_FEE_PERCENT = 1.5;

export function platformFeeCents(amountCents: number): number {
  return Math.round(amountCents * (PLATFORM_FEE_PERCENT / 100));
}

// Flat rate — Stripe subscriptions take a percentage (application_fee_percent) rather
// than a cents amount, so this mirrors platformFeeCents' rate for the subscription path.
export function platformFeePercent(): number {
  return PLATFORM_FEE_PERCENT;
}

// When passFees=true the studio nets the face price; the customer pays the gross, which
// covers both Stripe's own cut (2.9% + $0.30) and the platform's flat percentage.
export function grossUpPrice(facePrice: number): number {
  const faceCents = Math.round(facePrice * 100);
  const grossCents = Math.ceil((faceCents + 30) / (1 - 0.029 - PLATFORM_FEE_PERCENT / 100));
  return grossCents / 100;
}
