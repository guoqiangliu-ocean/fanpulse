const finiteNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function normalizeProbabilityVector(
  names: unknown[],
  rawPercentages: unknown[],
) {
  const unavailable = names.map(() => null as number | null);
  if (!names.length || names.length !== rawPercentages.length) return unavailable;
  const parsed = rawPercentages.map((value) => {
    if (value === "NA" || value === null || value === undefined || value === "") {
      return null;
    }
    const number = finiteNumber(value);
    return number !== null && number >= 0 ? number : null;
  });
  if (parsed.some((value) => value === null)) return unavailable;
  const numbers = parsed as number[];
  const total = numbers.reduce((sum, value) => sum + value, 0);
  if (numbers.every((value) => value <= 1) && total >= 0.8 && total <= 1.2) {
    return numbers;
  }
  if (
    numbers.every((value) => value <= 100) &&
    total >= 80 &&
    total <= 120
  ) {
    return numbers.map((value) => value / 100);
  }
  return unavailable;
}
