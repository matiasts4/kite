pub mod knowledge;
pub mod memory;
pub mod service;
pub mod skills;
pub mod starters;
pub mod types;
pub mod utils;

#[cfg(test)]
mod tests;

pub use knowledge::{
    delete_agent_knowledge_pack, list_agent_knowledge_packs, reindex_agent_knowledge_packs,
    render_knowledge_manifest_at, save_agent_knowledge_pack, search_agent_knowledge_packs,
    search_knowledge_packs_at,
};
pub use memory::{
    apply_post_turn_reflection, compile_snapshot_instructions_at, load_agent_mind_at,
    sync_agent_instructions,
};
pub use service::*;
pub use skills::{
    capture_skill_from_chat_at, check_skill_eligibility, discover_available_skills_at,
    parse_skill_frontmatter, read_linked_skill_content,
};
pub use types::*;
pub use utils::{agents_root, get_agent_home_dir};
