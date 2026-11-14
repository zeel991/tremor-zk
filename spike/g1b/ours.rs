use ultrahonk_no_std::{verify, ProofType};
fn main() {
    let d = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/");
    let rd = |p: &str| std::fs::read(format!("{d}{p}")).unwrap();
    let pubs_of = |b: Vec<u8>| -> Vec<[u8; 32]> { b.chunks(32).map(|c| c.try_into().unwrap()).collect() };
    // 1. crate's own v5 ZK test vector (sanity)
    let r = verify::<()>(&rd("zk/vk"), &ProofType::ZK(rd("zk/proof").into()), &pubs_of(rd("zk/pubs")));
    println!("upstream zk vector: {:?}", r.is_ok());
    // 2. our ReceiptProof DKIM proof
    let (vk, proof, pubs) = (rd("ours/vk"), rd("ours/proof"), pubs_of(rd("ours/pubs")));
    let t = std::time::Instant::now();
    let r = verify::<()>(&vk, &ProofType::ZK(proof.clone().into()), &pubs);
    println!("ours ZK: {:?} in {:?}", r, t.elapsed());
    // 3. negatives: tampered public input, tampered proof byte, wrong flavor
    let mut bad = pubs.clone(); bad[0][31] ^= 1;
    println!("ours tampered pub rejected: {}", verify::<()>(&vk, &ProofType::ZK(proof.clone().into()), &bad).is_err());
    let mut bp = proof.clone(); let n = bp.len(); bp[n - 40] ^= 1;
    println!("ours tampered proof rejected: {}", verify::<()>(&vk, &ProofType::ZK(bp.into()), &pubs).is_err());
    println!("ours as Plain rejected: {}", verify::<()>(&vk, &ProofType::Plain(proof.into()), &pubs).is_err());
}
