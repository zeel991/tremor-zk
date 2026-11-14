use bignum::{params::BigNumParams, RuntimeBigNum};

/// Constrain signature < modulus. Without this, s + n (if it fits in the limbs) also
/// passes RSA verification and would give the same email a second nullifier.
pub fn assert_sig_lt_modulus<let N: u32, let BITS: u32>(
    modulus: [Field; N],
    redc: [Field; N],
    signature: [Field; N],
) {
    let params: BigNumParams<N, BITS> = BigNumParams::new(false, to_u128(modulus), to_u128(redc));
    let s: RuntimeBigNum<N, BITS> = RuntimeBigNum::from_array(params, to_u128(signature));
    s.validate_in_field();
}

fn to_u128<let N: u32>(x: [Field; N]) -> [u128; N] {
    let mut out: [u128; N] = [0; N];
    for i in 0..N {
        out[i] = x[i] as u128;
    }
    out
}
