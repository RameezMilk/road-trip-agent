export function Choices() {
  return (
    <section className="glass panel">
      <h2>Choices</h2>
      <p>Two grounded options per category, each with Like / Pass / Must-have.</p>
      <div className="choice-actions" aria-hidden="true">
        <span className="pill">Like</span>
        <span className="pill">Pass</span>
        <span className="pill pill-green">Must-have</span>
      </div>
      <p className="notice">Not built yet — waiting on the Photon capability test.</p>
    </section>
  );
}
