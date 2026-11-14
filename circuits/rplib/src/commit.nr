use poseidon::poseidon2::Poseidon2;

/// Max inbox address length bound into `to_commit` (4 fields x 31 bytes).
pub global MAX_ADDR_LEN: u32 = 124;

/// to_commit = Poseidon2([pack31(lower(addr)) x4, len, salt]) (SPEC 19.1).
/// Lower-casing happens here so `Alice@X.com` and `alice@x.com` commit identically.
pub fn to_commit<let N: u32>(addr: BoundedVec<u8, N>, salt: Field) -> Field {
    let len = addr.len();
    assert(len > 0, "empty address");
    assert(len <= MAX_ADDR_LEN, "address too long");
    let mut packed: [Field; 4] = [0; 4];
    for i in 0..MAX_ADDR_LEN {
        let mut b: u8 = 0;
        if i < len {
            b = addr.get_unchecked(i);
            if (b >= 65) & (b <= 90) {
                b = b + 32;
            }
        }
        let e = i / 31;
        packed[e] = packed[e] * 256 + (b as Field);
    }
    Poseidon2::hash([packed[0], packed[1], packed[2], packed[3], len as Field, salt], 6)
}
