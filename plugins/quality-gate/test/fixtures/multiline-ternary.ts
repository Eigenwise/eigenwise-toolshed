type Summary = { n: number };

const describe = (s: Summary, pad = 0): string => String(s.n + pad);

export const view = (flag: boolean) => (summary: Summary) => ({
  label: flag
    ? describe(summary)
    : null,
  count: summary.n,
});
