// ReceiptProof: prove a merchant DKIM-signed receipt states `amount` for `template`, without
// revealing the email. Public outputs are the 9 fields of SPEC 19.1, in order.
use zkemail::{
    dkim::RSAPubkey, headers::{body_hash::get_body_hash, constrain_header_field, email_address::get_email_address},
    KEY_LIMBS_2048, partial_hash::partial_sha256_var_end, Sequence, blinded_nullifier,
};
use rplib::{amount::parse_amount, commit::to_commit, date::{DATE_WINDOW, parse_date}, sig::assert_sig_lt_modulus, templates};

global MAX_HEADER: u32 = 1408;
global MAX_BODY: u32 = 1280;
global MAX_DATE_FIELD: u32 = 64;

fn main(
    header: BoundedVec<u8, MAX_HEADER>,
    body: BoundedVec<u8, MAX_BODY>,
    pubkey: RSAPubkey<KEY_LIMBS_2048>,
    signature: [Field; KEY_LIMBS_2048],
    body_hash_index: u32,
    dkim_header_sequence: Sequence,
    partial_body_hash: [u32; 8],
    partial_body_real_length: u64,
    date_sequence: Sequence,
    to_header_sequence: Sequence,
    to_address_sequence: Sequence,
    template_id: u32,
    amount_start: u32,
    amount_len: u32,
    salt: Field,
    recipient: Field,
    vault_id: Field,
) -> pub [Field; 9] {
    // 1. DKIM signature over the canonicalised header, with s < n (nullifier uniqueness).
    let _ = pubkey.verify_dkim_signature(header, signature);
    assert_sig_lt_modulus::<KEY_LIMBS_2048, 2048>(pubkey.modulus, pubkey.redc, signature);

    // 2-3. Signed body hash == SHA256(hidden prefix state || in-circuit remainder).
    let signed_body_hash = get_body_hash(header, dkim_header_sequence, body_hash_index);
    let computed = partial_sha256_var_end(partial_body_hash, body.storage(), body.len() as u64, partial_body_real_length);
    assert(signed_body_hash == computed, "body hash mismatch");

    // 4. Root of trust.
    let pubkey_hash = pubkey.hash()[0];

    // 5. Salted nullifier: the merchant cannot recompute it.
    let nullifier = blinded_nullifier(signature, salt);

    // 6. Date header -> Unix seconds.
    constrain_header_field::<MAX_HEADER, MAX_DATE_FIELD, 4>(header, date_sequence, "date".as_bytes());
    let value_start = date_sequence.index + 5;
    let value_len = date_sequence.length - 5;
    let mut w: [u8; DATE_WINDOW] = [0; DATE_WINDOW];
    for i in 0..DATE_WINDOW {
        if i < value_len {
            w[i] = header.get_unchecked(value_start + i);
        }
    }
    let sent_at = parse_date(w, value_len);

    // 7. To: header -> salted inbox commitment.
    let to_addr = get_email_address(header, to_header_sequence, to_address_sequence, "to".as_bytes());
    let to_c = to_commit(to_addr, salt);

    // 8. Template: anchor bytes directly before the amount, inside the signed body.
    let t = templates::lookup(template_id);
    templates::assert_anchor(body, t, amount_start);
    let amount_minor = parse_amount(body, amount_start, amount_len);

    // 9. recipient / vault_id are bound by being public outputs.
    [
        pubkey_hash, nullifier, template_id as Field, amount_minor as Field, t.currency as Field,
        sent_at as Field, to_c, recipient, vault_id,
    ]
}
