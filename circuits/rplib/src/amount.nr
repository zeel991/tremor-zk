// Amount parser on raw (signed) body bytes.
// Accepts digits with optional ',' separators and an optional '.' followed by exactly 2 digits.
// The byte after the amount must not be a digit, ',' or '.', so the prover can't cut a number short
// to claim a smaller-looking prefix or extend it.

pub global MAX_AMOUNT_CHARS: u32 = 16;

pub fn parse_amount<let N: u32>(body: BoundedVec<u8, N>, start: u32, len: u32) -> u64 {
    assert((len >= 1) & (len <= MAX_AMOUNT_CHARS), "amount: bad length");
    assert(start + len < body.len(), "amount: outside signed body");
    let first = body.get_unchecked(start);
    assert((first >= 48) & (first <= 57), "amount: must start with a digit");
    let mut int_part: u64 = 0;
    let mut frac: u64 = 0;
    let mut frac_digits: u32 = 0;
    let mut seen_dot = false;
    for i in 0..MAX_AMOUNT_CHARS {
        if i < len {
            let c = body.get_unchecked(start + i);
            let is_digit = (c >= 48) & (c <= 57);
            assert(is_digit | (c == 44) | (c == 46), "amount: bad character");
            if c == 46 {
                assert(!seen_dot, "amount: two decimal points");
                seen_dot = true;
            } else if is_digit {
                if seen_dot {
                    frac = frac * 10 + ((c - 48) as u64);
                    frac_digits += 1;
                } else {
                    int_part = int_part * 10 + ((c - 48) as u64);
                }
            } else {
                assert(!seen_dot, "amount: separator after decimal point");
            }
        }
    }
    let t = body.get_unchecked(start + len);
    assert(!(((t >= 48) & (t <= 57)) | (t == 44) | (t == 46)), "amount: not terminated");
    if seen_dot {
        assert(frac_digits == 2, "amount: need exactly 2 decimals");
    }
    let minor = int_part * 100 + frac;
    assert(minor < 1000000000000, "amount: too large");
    minor
}
