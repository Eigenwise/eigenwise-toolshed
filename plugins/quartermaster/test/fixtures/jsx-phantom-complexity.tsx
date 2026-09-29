// Minimised from the report that opened GitHub issue #239. lizard 1.24.0's TSX reader abandons an opening tag the
// moment an attribute is not `name="text"` or `name={expr}` -- here `data-testid` -- and re-emits the
// `{` of the `value={...}` attribute it had already matched. That unbalanced brace keeps `SaleField`
// open to the end of the file, so `SaleField` is charged with the module-level decisions below it and
// `SaleTotals` is never reported at all.
//
// Hand counts: SaleField 1 (no decision), packsLabel 2 (one ternary), SaleTotals 3 (a ternary and an
// `&&`). Nothing in this file is over the CRAP ceiling.
import styles from "./sale.module.css";

interface SaleFieldProps {
  readonly value: string;
  readonly total: number;
}

const SaleField = (props: SaleFieldProps) => (
  <label className={styles.label}>
    <input className={styles.input} value={props.value} data-testid="sale-packs" />
  </label>
);

const totalClass = styles.total || styles.label;
const emptyHint = totalClass.length > 0 ? "" : "no sale yet";

const packsLabel = (props: SaleFieldProps): string => (props.total > 0 ? "packs" : "none");

const SaleTotals = (props: SaleFieldProps) => (
  <p className={styles.total}>
    {props.total > 0 ? props.total : 0} {props.value && packsLabel(props)}
  </p>
);

export { SaleField, SaleTotals, packsLabel };
