export const fakeClock = (initial = '2026-01-01T00:00:00.000Z') => {
  let current = Date.parse(initial);
  return {
    now: () => new Date(current),
    advance: (milliseconds: number) => { current += milliseconds; },
  };
};

