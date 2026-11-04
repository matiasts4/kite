//! Port trait. Policy decides whether a write is allowed. The port only moves text.

use super::types::{DispatchError, Family, PaneVisibility};

#[derive(Debug, Clone)]
pub struct StartRequest {
    pub engine: String,
    pub command: Option<String>,
    pub name: Option<String>,
    pub cwd: Option<String>,
    /// Text the process receives at birth. Not a second send.
    pub prompt: Option<String>,
    /// Start the session and do not ask the desktop for a pane.
    pub hidden: bool,
    /// The manual rides the engine's system-prompt argument. The port loads that text.
    pub manual_as_system: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    pub session_id: String,
    pub pane: PaneVisibility,
}

#[derive(Debug, Clone)]
pub struct SubmitMeta {
    pub mounted: bool,
    pub source: Option<String>,
    pub label: Option<String>,
    /// The caller already played the flight. The port must not emit a second one.
    pub presentation_emitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteRecord {
    pub family: Family,
    pub id: String,
    pub text: String,
    pub pty: bool,
    pub presentation: bool,
}

pub trait Port {
    fn submit(
        &mut self,
        family: Family,
        id: &str,
        text: &str,
        meta: &SubmitMeta,
    ) -> Result<(), DispatchError>;

    fn read(&mut self, family: Family, id: &str, lines: usize) -> Result<String, DispatchError>;

    fn stop(&mut self, family: Family, id: &str) -> Result<(), DispatchError>;

    fn start_terminal(&mut self, request: &StartRequest) -> Result<Started, DispatchError>;
}

#[derive(Debug, Default)]
pub struct FakePort {
    pub writes: Vec<WriteRecord>,
    pub stops: Vec<(Family, String)>,
    pub starts: Vec<StartRequest>,
    pub buffers: Vec<((Family, String), String)>,
    next_id: u32,
}

impl FakePort {
    pub fn pty_writes(&self) -> usize {
        self.writes.iter().filter(|w| w.pty).count()
    }
}

impl Port for FakePort {
    fn submit(
        &mut self,
        family: Family,
        id: &str,
        text: &str,
        meta: &SubmitMeta,
    ) -> Result<(), DispatchError> {
        self.writes.push(WriteRecord {
            family,
            id: id.to_string(),
            text: text.to_string(),
            pty: !meta.mounted,
            presentation: !meta.presentation_emitted,
        });
        Ok(())
    }

    fn read(&mut self, family: Family, id: &str, lines: usize) -> Result<String, DispatchError> {
        let found = self
            .buffers
            .iter()
            .rev()
            .find(|((fam, sid), _)| *fam == family && sid == id)
            .map(|(_, text)| text.clone())
            .unwrap_or_default();
        Ok(super::envelope::last_lines(&found, lines))
    }

    fn stop(&mut self, family: Family, id: &str) -> Result<(), DispatchError> {
        self.stops.push((family, id.to_string()));
        Ok(())
    }

    fn start_terminal(&mut self, request: &StartRequest) -> Result<Started, DispatchError> {
        self.next_id += 1;
        let pane = if request.hidden {
            PaneVisibility::Hidden
        } else {
            PaneVisibility::Pending
        };
        self.starts.push(request.clone());
        Ok(Started {
            session_id: format!("term-{}", self.next_id),
            pane,
        })
    }
}
