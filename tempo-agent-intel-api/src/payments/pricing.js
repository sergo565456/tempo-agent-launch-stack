export const DEPTH_PRICES_USD = {
  quick: '0.01',
  standard: '0.05',
  deep: '0.25',
};

export function getPriceUsd(depth = 'standard', pricesUsd = DEPTH_PRICES_USD) {
  return pricesUsd[depth] || pricesUsd.standard || DEPTH_PRICES_USD.standard;
}

export function usdToTokenBaseUnits(amountUsd, decimals = 6) {
  const normalized = normalizeDecimalString(amountUsd);
  const [whole, rawFraction = ''] = normalized.split('.');
  const fraction = rawFraction.padEnd(decimals, '0').slice(0, decimals);
  const base = BigInt(whole) * (10n ** BigInt(decimals));
  return (base + BigInt(fraction || '0')).toString();
}

function normalizeDecimalString(value) {
  const normalized = String(value || '').trim();
  if (!/^\d+(\.\d{1,18})?$/.test(normalized)) {
    throw new Error(`Invalid decimal amount: ${value}`);
  }
  return normalized;
}
