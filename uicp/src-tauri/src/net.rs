use std::net::IpAddr;
use url::Url;

pub fn parse_host(u: &str) -> anyhow::Result<String> {
    Ok(
        Url::parse(u)?
            .host_str()
            .ok_or_else(|| anyhow::anyhow!("no host"))?
            .to_string(),
    )
}

pub fn is_ip_literal(h: &str) -> bool {
    h.parse::<IpAddr>().is_ok()
}

pub fn is_private_ip(h: &str) -> bool {
    if let Ok(IpAddr::V4(ip)) = h.parse() {
        let o = ip.octets();
        return o[0] == 10
            || (o[0] == 172 && (16..=31).contains(&o[1]))
            || (o[0] == 192 && o[1] == 168);
    }
    if let Ok(IpAddr::V6(ip)) = h.parse() {
        return ip.is_loopback() || ip.segments()[0] & 0xfe00 == 0xfc00;
    }
    false
}
