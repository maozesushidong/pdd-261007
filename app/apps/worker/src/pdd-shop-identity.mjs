export const normalizeDetectedPddShopName = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .trim();

export const canonicalDetectedPddShopName = (value) => normalizeDetectedPddShopName(value)
  .replace(/(?:林动|梦蝶|小芸)$/u, '')
  .trim();

// PDD can expose the same merchant through two labels: the small shop label
// and the larger主体/mall label.  Both are valid identity evidence, but an
// observed value must match one of the configured labels before it is trusted.
export const pddIdentityNameSet = (...values) => [...new Set(values
  .flat(Infinity)
  .map((value) => canonicalDetectedPddShopName(value))
  .filter(Boolean))];

export const pddIdentityMatches = (configuredValues, observedValues) => {
  const configured = pddIdentityNameSet(configuredValues);
  const observed = pddIdentityNameSet(observedValues);
  return configured.length > 0 && observed.some((value) => configured.includes(value));
};
