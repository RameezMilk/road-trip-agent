import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate } from "react-router";
import { RouterProvider } from "react-router/dom";
import { TripShell } from "./components/TripShell";
import "./styles.css";
import { Choices } from "./views/Choices";
import { LiveTrip } from "./views/LiveTrip";
import { NotFound } from "./views/NotFound";
import { Preferences } from "./views/Preferences";

// Each GC card opens one of these views. URLs carry only the public trip id — never private values.
const router = createBrowserRouter([
  {
    path: "/trip/:publicId",
    element: <TripShell />,
    children: [
      { index: true, element: <Navigate to="live" replace /> },
      { path: "preferences", element: <Preferences /> },
      { path: "choices", element: <Choices /> },
      { path: "live", element: <LiveTrip /> },
    ],
  },
  { path: "*", element: <NotFound /> },
]);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
