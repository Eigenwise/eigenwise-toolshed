type Card = { name: string; setCode: string; position: number };

const viewOf = (card: Card | undefined): Card | null =>
  card === undefined
    ? null
    : {
        name: card.name,
        setCode: String(card.setCode),
        position: card.position,
      };

const pick = (kind: string, a: Card, b: Card): Card =>
  kind === "a"
    ? a
    : kind === "b"
    ? b
    : a;
