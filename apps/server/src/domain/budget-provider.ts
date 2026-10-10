/**
 * Future-only boundary for a Capital One Nessie sandbox adapter (trip-fund budgets, expense categories).
 * Not part of the MVP: no credentials, network calls, accounts or payment UI. User-entered budgets work
 * without it, and sandbox data must never be presented as real banking.
 */
export type BudgetResult = { status: "not_implemented" };

export interface BudgetProvider {
  getTripFund(tripId: string): Promise<BudgetResult>;
}

export const nessieBudgetProvider: BudgetProvider = {
  getTripFund: async () => ({ status: "not_implemented" }),
};
