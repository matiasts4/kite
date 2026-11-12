//! Compact session list. Rows are 28px, the control radius is 8px.

use crate::core_client::LiveSession;
use crate::theme;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionRow {
    pub session_id: String,
    pub title: String,
    pub cwd: String,
    pub workspace_id: Option<String>,
    pub exited: bool,
    pub selected: bool,
}

#[derive(Clone, Debug)]
pub struct Sidebar {
    pub workspace: String,
    pub rows: Vec<SessionRow>,
    pub row_height: f32,
    pub radius: f32,
    pub filter: String,
}

impl Sidebar {
    pub fn new(workspace: impl Into<String>) -> Self {
        Self {
            workspace: workspace.into(),
            rows: Vec::new(),
            row_height: theme::HEIGHT_COMPACT,
            radius: theme::RADIUS_CONTROL,
            filter: String::new(),
        }
    }

    pub fn replace_sessions(&mut self, sessions: &[LiveSession]) {
        let selected = self
            .rows
            .iter()
            .find(|row| row.selected)
            .map(|row| row.session_id.clone());
        self.rows = sessions
            .iter()
            .filter(|session| self.matches(session))
            .map(|session| SessionRow {
                session_id: session.session_id.clone(),
                title: session.engine.clone(),
                cwd: session.cwd.clone(),
                workspace_id: session.workspace_id.clone(),
                exited: session.exited,
                selected: selected.as_deref() == Some(session.session_id.as_str()),
            })
            .collect();
    }

    fn matches(&self, session: &LiveSession) -> bool {
        if !self.workspace.is_empty() {
            if let Some(workspace) = session.workspace_id.as_deref() {
                if workspace != self.workspace {
                    return false;
                }
            }
        }
        if self.filter.is_empty() {
            return true;
        }
        let needle = self.filter.to_ascii_lowercase();
        session.session_id.to_ascii_lowercase().contains(&needle)
            || session.cwd.to_ascii_lowercase().contains(&needle)
            || session.engine.to_ascii_lowercase().contains(&needle)
    }

    pub fn select(&mut self, session_id: &str) {
        for row in &mut self.rows {
            row.selected = row.session_id == session_id;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_compact_and_filter_by_workspace() {
        let mut sidebar = Sidebar::new("ws");
        assert_eq!(sidebar.row_height, 28.0);
        assert_eq!(sidebar.radius, 8.0);
        sidebar.replace_sessions(&[
            LiveSession {
                session_id: "a".into(),
                workspace_id: Some("ws".into()),
                engine: "powershell".into(),
                cwd: "E:/kite".into(),
                ..empty()
            },
            LiveSession {
                session_id: "b".into(),
                workspace_id: Some("other".into()),
                engine: "bash".into(),
                ..empty()
            },
        ]);
        assert_eq!(sidebar.rows.len(), 1);
        assert_eq!(sidebar.rows[0].session_id, "a");
    }

    fn empty() -> LiveSession {
        LiveSession {
            session_id: String::new(),
            channel_id: None,
            workspace_id: None,
            pane_id: None,
            engine: String::new(),
            cwd: String::new(),
            root_pid: 0,
            cols: 0,
            rows: 0,
            exited: false,
            exit_code: None,
            spawned_at_unix_ms: 0,
        }
    }
}
