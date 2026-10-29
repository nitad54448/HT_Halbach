use halbach_instruments::protocol::*;
#[test]
fn overrange_and_nonfinite_rejected() {
    for s in ["NaN", "inf", "9.9E37", "bad"] {
        assert!(number(s).is_err());
    }
    assert_eq!(number("-2.5e-6").unwrap(), -2.5e-6);
}
#[test]
fn register_formats() {
    assert_eq!(register("#B1000").unwrap(), 8);
    assert_eq!(register("#H0D").unwrap(), 13);
    assert_eq!(register("#Q10").unwrap(), 8);
}
#[test]
fn endpoints() {
    for s in [
        "192.168.1.2",
        "192.168.1.2:50000",
        "TCPIP0::192.168.1.2::50000::SOCKET",
    ] {
        assert_eq!(ametek_endpoint(s).unwrap(), ("192.168.1.2".into(), 50000));
    }
    assert!(ametek_endpoint("GPIB0::8::INSTR").is_err());
}
