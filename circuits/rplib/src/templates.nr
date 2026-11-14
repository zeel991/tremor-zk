// Merchant templates compiled into the circuit (SPEC 19.3).
// An anchor is the exact RAW body bytes (as signed, quoted-printable left encoded) that must sit
// immediately before the amount. Matching raw bytes is sound: the body hash covers them as-is.
// A soft line break inside the anchor just makes the proof fail (no false positives).

pub global MAX_ANCHOR: u32 = 32;
pub global NUM_TEMPLATES: u32 = 6;

pub struct Template {
    pub id: u32,
    pub currency: u32,
    pub anchor: [u8; MAX_ANCHOR],
    pub anchor_len: u32,
}

// "Amount paid: INR "
global A_TEST_INR: [u8; MAX_ANCHOR] = [65, 109, 111, 117, 110, 116, 32, 112, 97, 105, 100, 58, 32, 73, 78, 82, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// "Amount paid: USD "
global A_TEST_USD: [u8; MAX_ANCHOR] = [65, 109, 111, 117, 110, 116, 32, 112, 97, 105, 100, 58, 32, 85, 83, 68, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// Real-merchant anchors below are PLACEHOLDERS until G4 (real .eml). [VERIFY]
// Uber: "Total =E2=82=B9" (QP-encoded rupee sign)
global A_UBER: [u8; MAX_ANCHOR] = [84, 111, 116, 97, 108, 32, 61, 69, 50, 61, 56, 50, 61, 66, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// Swiggy: "Grand Total =E2=82=B9"
global A_SWIGGY: [u8; MAX_ANCHOR] = [71, 114, 97, 110, 100, 32, 84, 111, 116, 97, 108, 32, 61, 69, 50, 61, 56, 50, 61, 66, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// Zomato: "Total paid =E2=82=B9"
global A_ZOMATO: [u8; MAX_ANCHOR] = [84, 111, 116, 97, 108, 32, 112, 97, 105, 100, 32, 61, 69, 50, 61, 56, 50, 61, 66, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
// Amazon.in: "Order Total: =E2=82=B9"
global A_AMAZON: [u8; MAX_ANCHOR] = [79, 114, 100, 101, 114, 32, 84, 111, 116, 97, 108, 58, 32, 61, 69, 50, 61, 56, 50, 61, 66, 57, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

pub global TEMPLATES: [Template; NUM_TEMPLATES] = [
    Template { id: 1, currency: 356, anchor: A_UBER, anchor_len: 15 },
    Template { id: 2, currency: 356, anchor: A_SWIGGY, anchor_len: 21 },
    Template { id: 3, currency: 356, anchor: A_ZOMATO, anchor_len: 20 },
    Template { id: 4, currency: 356, anchor: A_AMAZON, anchor_len: 22 },
    Template { id: 100, currency: 356, anchor: A_TEST_INR, anchor_len: 17 },
    Template { id: 101, currency: 840, anchor: A_TEST_USD, anchor_len: 17 },
];

pub fn lookup(template_id: u32) -> Template {
    let mut found = false;
    let mut t = TEMPLATES[0];
    for i in 0..NUM_TEMPLATES {
        if TEMPLATES[i].id == template_id {
            found = true;
            t = TEMPLATES[i];
        }
    }
    assert(found, "unknown template");
    t
}

/// Assert body[amount_start - anchor_len .. amount_start] == anchor.
pub fn assert_anchor<let N: u32>(body: BoundedVec<u8, N>, t: Template, amount_start: u32) {
    assert(amount_start >= t.anchor_len, "anchor: out of bounds");
    let base = amount_start - t.anchor_len;
    for k in 0..MAX_ANCHOR {
        if k < t.anchor_len {
            assert(body.get_unchecked(base + k) == t.anchor[k], "anchor mismatch");
        }
    }
}
