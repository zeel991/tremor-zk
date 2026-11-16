// Mirror of circuits/rplib/src/templates.nr (SPEC 19.3). Anchors are raw signed body bytes.
export const TEMPLATES = {
  1: { name: 'Uber', currency: 356, anchor: 'Total =E2=82=B9', verified: false },
  2: { name: 'Swiggy', currency: 356, anchor: 'Grand Total =E2=82=B9', verified: false },
  3: { name: 'Zomato', currency: 356, anchor: 'Total paid =E2=82=B9', verified: false },
  4: { name: 'Amazon.in', currency: 356, anchor: 'Order Total: =E2=82=B9', verified: false },
  100: { name: 'Tremor Test Merchant', currency: 356, anchor: 'Amount paid: INR ', verified: true },
  101: { name: 'Tremor Test Merchant (USD)', currency: 840, anchor: 'Amount paid: USD ', verified: true },
};
