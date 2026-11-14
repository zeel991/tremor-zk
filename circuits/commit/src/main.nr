// Computes to_commit for registration with exactly the circuit's code path (SPEC 19.1).
use rplib::commit::{MAX_ADDR_LEN, to_commit};

fn main(addr: BoundedVec<u8, MAX_ADDR_LEN>, salt: Field) -> pub Field {
    to_commit(addr, salt)
}
