/** SPEC §19.3 templates compiled into the circuit. Category is the agent's policy key. */
export type Category = "transport" | "meals" | "shopping" | "test";

export interface Template {
  id: number;
  merchant: string;
  currency: number;
  category: Category;
}

export const TEMPLATES: Record<number, Template> = {
  1: { id: 1, merchant: "Uber (India)", currency: 356, category: "transport" },
  2: { id: 2, merchant: "Swiggy", currency: 356, category: "meals" },
  3: { id: 3, merchant: "Zomato", currency: 356, category: "meals" },
  4: { id: 4, merchant: "Amazon.in", currency: 356, category: "shopping" },
  100: { id: 100, merchant: "ReceiptProof Test Merchant", currency: 356, category: "test" },
  101: { id: 101, merchant: "ReceiptProof Test Merchant USD", currency: 840, category: "test" },
};

export const SUPPORTED_CURRENCIES = new Set([356, 840]);

export function templateById(id: bigint | number): Template | undefined {
  const n = Number(id);
  return Number.isSafeInteger(n) ? TEMPLATES[n] : undefined;
}
