import { MarkerKind } from "@rta/contracts";
import { ENDPOINT_STYLES, MARKER_STYLES } from "../markers";

export function MarkerLegend() {
  return (
    <ul className="legend" aria-label="Map legend">
      {Object.values(ENDPOINT_STYLES).map((e) => (
        <li key={e.label} className="legend-item legend-endpoint">
          <span className="orb orb-endpoint" aria-hidden="true">
            {e.icon}
          </span>
          {e.label}
        </li>
      ))}
      {MarkerKind.options.map((kind) => {
        const style = MARKER_STYLES[kind];
        return (
          <li key={kind} className="legend-item">
            <span className="orb" style={{ background: `var(${style.colorVar})` }} aria-hidden="true">
              {style.icon}
            </span>
            {style.label}
          </li>
        );
      })}
    </ul>
  );
}
