import type { MarkerKind } from "@rta/contracts";

export interface MarkerStyle {
  label: string;
  icon: string;
  /** CSS custom property holding the marker hue; labels and icons carry meaning without color. */
  colorVar: string;
}

// Record<MarkerKind, …> makes a missing kind a compile error when the enum grows.
export const MARKER_STYLES: Record<MarkerKind, MarkerStyle> = {
  restaurant: { label: "Restaurant", icon: "🍽️", colorVar: "--marker-restaurant" },
  rest: { label: "Rest stop", icon: "🚻", colorVar: "--marker-rest" },
  hotel: { label: "Hotel", icon: "🏨", colorVar: "--marker-hotel" },
  scenic: { label: "Scenic", icon: "🏞️", colorVar: "--marker-scenic" },
  attraction: { label: "Attraction", icon: "🎟️", colorVar: "--marker-attraction" },
  charging: { label: "Charging", icon: "⚡", colorVar: "--marker-charging" },
};

export const ENDPOINT_STYLES = {
  origin: { label: "Start", icon: "🏠" },
  destination: { label: "Destination", icon: "🏁" },
} as const;
