use crate::lossless::compact_lossless;
use crate::pipeline::ContentKind;

pub fn filter_search(output: &str) -> Option<(&'static str, String)> {
    let folded = compact_lossless(output, ContentKind::Grep);
    Some(("search", folded))
}

pub fn filter_listing(output: &str) -> Option<(&'static str, String)> {
    let folded = compact_lossless(output, ContentKind::Paths);
    if folded.len() < output.len() {
        return Some(("listing", folded));
    }
    let clean = compact_lossless(output, ContentKind::Text);
    Some(("listing", clean))
}
