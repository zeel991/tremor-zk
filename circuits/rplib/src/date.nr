// RFC 5322 date parser: "[Ddd, ]D[D] Mon YYYY HH:MM:SS (+|-)HHMM" or a "GMT"/"UTC" zone.
// Input is a fixed window starting at the first byte of the field value, plus the value length.

pub global DATE_WINDOW: u32 = 48;

global MONTHS: [[u8; 3]; 12] = [
    [74, 97, 110], [70, 101, 98], [77, 97, 114], [65, 112, 114], [77, 97, 121], [74, 117, 110],
    [74, 117, 108], [65, 117, 103], [83, 101, 112], [79, 99, 116], [78, 111, 118], [68, 101, 99],
];

fn digit(b: u8) -> u64 {
    assert((b >= 48) & (b <= 57), "date: expected digit");
    (b - 48) as u64
}

fn two(w: [u8; DATE_WINDOW], i: u32) -> u64 {
    digit(w[i]) * 10 + digit(w[i + 1])
}

/// Days since 1970-01-01 (Howard Hinnant's days_from_civil), valid for 2000..2099.
pub fn days_from_civil(y_in: u64, m: u64, d: u64) -> u64 {
    let y = if m <= 2 { y_in - 1 } else { y_in };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Returns Unix seconds. `value_len` = number of value bytes available in `w` (bounds check).
pub fn parse_date(w: [u8; DATE_WINDOW], value_len: u32) -> u64 {
    // optional leading space (simple canonicalisation)
    let s = if w[0] == 32 { 1 } else { 0 };
    // optional "Ddd, "
    let o = if w[s + 3] == 44 {
        assert(w[s + 4] == 32, "date: bad weekday");
        s + 5
    } else {
        s
    };
    // day: 1 or 2 digits
    let one_digit_day = w[o + 1] == 32;
    let day = if one_digit_day { digit(w[o]) } else { two(w, o) };
    let o2 = if one_digit_day { o + 2 } else { o + 3 };
    // month
    let mut month: u64 = 0;
    for k in 0..12 {
        let n = MONTHS[k];
        if (w[o2] == n[0]) & (w[o2 + 1] == n[1]) & (w[o2 + 2] == n[2]) {
            month = (k + 1) as u64;
        }
    }
    assert(month != 0, "date: bad month");
    assert(w[o2 + 3] == 32, "date: expected space after month");
    let o3 = o2 + 4;
    let year = two(w, o3) * 100 + two(w, o3 + 2);
    assert(w[o3 + 4] == 32, "date: expected space after year");
    let o4 = o3 + 5;
    let hh = two(w, o4);
    assert(w[o4 + 2] == 58, "date: expected ':'");
    let mm = two(w, o4 + 3);
    assert(w[o4 + 5] == 58, "date: expected ':'");
    let ss = two(w, o4 + 6);
    assert(w[o4 + 8] == 32, "date: expected space before zone");
    let o5 = o4 + 9;

    assert((year >= 2000) & (year <= 2099), "date: year out of range");
    assert((day >= 1) & (day <= 31), "date: day out of range");
    assert(hh < 24, "date: hour out of range");
    assert(mm < 60, "date: minute out of range");
    assert(ss < 61, "date: second out of range");

    let local = days_from_civil(year, month, day) * 86400 + hh * 3600 + mm * 60 + ss;
    let z = w[o5];
    let mut result: u64 = 0;
    if (z == 43) | (z == 45) {
        assert(o5 + 5 <= value_len, "date: zone outside header field");
        let zh = two(w, o5 + 1);
        let zm = two(w, o5 + 3);
        assert((zh < 24) & (zm < 60), "date: bad zone");
        let off = zh * 3600 + zm * 60;
        // local = UTC + offset  =>  UTC = local - offset
        result = if z == 43 { local - off } else { local + off };
    } else {
        // "GMT" or "UTC"
        assert(o5 + 3 <= value_len, "date: zone outside header field");
        let gmt = (z == 71) & (w[o5 + 1] == 77) & (w[o5 + 2] == 84);
        let utc = (z == 85) & (w[o5 + 1] == 84) & (w[o5 + 2] == 67);
        assert(gmt | utc, "date: bad zone");
        result = local;
    }
    result
}

#[test]
fn test_days() {
    assert(days_from_civil(1970, 1, 1) == 0);
    assert(days_from_civil(2026, 11, 15) == 20772);
    assert(days_from_civil(2000, 3, 1) == 11017);
}
