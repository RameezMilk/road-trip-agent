import type { ItineraryStop, Sustainability } from "../schemas";
import { METERS_PER_MILE } from "./geo";

/** EPA: 8,887 grams CO₂ per gallon of gasoline burned. */
export const CO2_KG_PER_GALLON = 8.887;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Fuel and CO₂ for one shared car over the route, compared with every member driving the same route alone.
 * Pure arithmetic over OSRM distance and the configured assumptions — never from the LLM.
 */
export function computeSustainability(input: {
  distanceMeters: number;
  memberCount: number;
  vehicleMpg: number;
  gasPriceUsdPerGallon: number;
  stops: ItineraryStop[];
}): Sustainability {
  const n = Math.max(1, input.memberCount);
  const gallons = input.distanceMeters / METERS_PER_MILE / input.vehicleMpg;
  const soloGallons = gallons * n;
  const visitable = input.stops.filter((s) => s.kind !== "origin" && s.kind !== "destination");
  return {
    memberCount: n,
    vehicleMpg: input.vehicleMpg,
    gasPriceUsdPerGallon: input.gasPriceUsdPerGallon,
    co2KgPerGallon: CO2_KG_PER_GALLON,
    fuelGallons: round2(gallons),
    fuelCostUsd: round2(gallons * input.gasPriceUsdPerGallon),
    soloFuelGallons: round2(soloGallons),
    gallonsSavedByCarpool: round2(soloGallons - gallons),
    usdSavedByCarpool: round2((soloGallons - gallons) * input.gasPriceUsdPerGallon),
    co2KgPerPerson: round2((gallons * CO2_KG_PER_GALLON) / n),
    co2KgPerPersonSolo: round2(gallons * CO2_KG_PER_GALLON),
    greenStops: visitable.filter((s) => s.sustainable).length,
    totalStops: visitable.length,
  };
}
