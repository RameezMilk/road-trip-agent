import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { MarkerLegend } from "../components/MarkerLegend";

type Load = { state: "loading" } | { state: "unavailable"; detail: string } | { state: "error"; detail: string };

export function LiveTrip() {
  const { publicId = "" } = useParams();
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/trips/${encodeURIComponent(publicId)}/state`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        setLoad({ state: "unavailable", detail: body.detail ?? `HTTP ${res.status}` });
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted) setLoad({ state: "error", detail: String(err) });
      });
    return () => ctrl.abort();
  }, [publicId]);

  return (
    <>
      <section className="glass panel">
        <h2>Live Trip</h2>
        <div className="map-placeholder" role="img" aria-label="Map placeholder">
          Google map with the route and stops appears here.
        </div>
        <p className="notice" aria-live="polite">
          {load.state === "loading" ? "Checking trip state…" : load.detail}
        </p>
      </section>
      <section className="glass panel">
        <h3>Legend</h3>
        <MarkerLegend />
      </section>
    </>
  );
}
