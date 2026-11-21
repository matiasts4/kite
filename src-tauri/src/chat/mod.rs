pub mod approval;
pub mod checkpoints;
pub mod contract;
pub mod drivers;
pub mod event_log;
pub mod kill_registry;
pub mod models;
pub mod normalize;
pub mod persistent;
pub mod provider_agents;
pub mod provider_env;
pub mod recipe;
pub mod recovery;
pub mod runtime;
pub mod session;
pub mod subagents;
pub mod swarm;
pub mod thread_index;
pub mod threads;
pub mod utils;

pub use approval::*;
pub use contract::*;
pub use drivers::*;
pub use event_log::*;
pub use models::*;
pub use normalize::*;
pub use persistent::*;
pub use provider_agents::*;
pub use provider_env::*;
pub use recipe::*;
pub use recovery::*;
pub use runtime::*;
pub use session::*;
pub use subagents::*;
pub use thread_index::*;
pub use threads::*;
pub use utils::*;

pub use crate::chat_attachments::{
    consume_staged_attachments, decode_base64, encode_base64, extract_attachment_file_paths,
    format_prompt_with_attachments, infer_mime_type, lookup_staged_attachment, parse_attachments,
    read_attachment_preview, release_staged_attachment, stage_blob_attachment,
    stage_blob_attachment_with_mime, stage_dropped_path, stage_dropped_paths,
    staged_attachment_count, StagedAttachment,
};
