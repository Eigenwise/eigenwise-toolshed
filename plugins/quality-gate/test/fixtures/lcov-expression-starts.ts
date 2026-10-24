export function paren(values) {
  return values.map((value) => (
    ((value + 1))
  ));
}

export function declared() {
  const value =
    42;
  return value;
}

export function uninit() {
  let later;
  later = 42;
  return later;
}
