import { NavLink, Outlet, useParams } from "react-router";

const TABS = [
  { to: "preferences", label: "Preferences" },
  { to: "choices", label: "Choices" },
  { to: "live", label: "Live Trip" },
];

export function TripShell() {
  const { publicId } = useParams();
  return (
    <div className="app">
      <div className="bubbles" aria-hidden="true" />
      <header className="glass header">
        <h1>Road trip</h1>
        <p className="muted">Trip {publicId}</p>
        <nav className="tabs" aria-label="Trip views">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => `pill${isActive ? " pill-active" : ""}`}>
              {t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
