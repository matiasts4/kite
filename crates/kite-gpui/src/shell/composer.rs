//! Agent composer. Prompt throw drives Channel 0 `agent.dispatch`.

use serde_json::{json, Value};

use crate::theme;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TelemetrySample {
    pub working_set_bytes: u64,
    pub private_bytes: u64,
    pub cpu_percent: f32,
    pub panes: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PromptThrow {
    pub from_x: f32,
    pub from_y: f32,
    pub to_x: f32,
    pub to_y: f32,
    pub t: f32,
}

impl PromptThrow {
    pub fn step(&mut self, dt_ms: f32) {
        self.t = (self.t + dt_ms / 180.0).clamp(0.0, 1.0);
    }

    pub fn position(&self) -> (f32, f32) {
        let eased = 1.0 - (1.0 - self.t) * (1.0 - self.t);
        (
            self.from_x + (self.to_x - self.from_x) * eased,
            self.from_y + (self.to_y - self.from_y) * eased,
        )
    }

    pub fn done(&self) -> bool {
        self.t >= 1.0
    }
}

#[derive(Clone, Debug)]
pub struct Composer {
    pub draft: String,
    pub targets: Vec<String>,
    pub height: f32,
    pub radius: f32,
    pub flight: Option<PromptThrow>,
}

impl Composer {
    pub fn new() -> Self {
        Self {
            draft: String::new(),
            targets: Vec::new(),
            height: theme::HEIGHT_HERO,
            radius: theme::RADIUS_CARD,
            flight: None,
        }
    }

    pub fn set_targets(&mut self, targets: impl IntoIterator<Item = impl Into<String>>) {
        self.targets = targets.into_iter().map(Into::into).collect();
    }

    pub fn throw_at(&mut self, target: (f32, f32)) {
        self.flight = Some(PromptThrow {
            from_x: 24.0,
            from_y: 0.0,
            to_x: target.0,
            to_y: target.1,
            t: 0.0,
        });
    }

    pub fn dispatch_params(&self) -> Value {
        json!({
            "action": "send",
            "address": self.targets.join(","),
            "body": self.draft,
            "allowQueue": true,
        })
    }

    pub fn run_params(&self, engine: &str) -> Value {
        json!({
            "action": "run",
            "engine": engine,
            "task": self.draft,
            "pane": true,
        })
    }
}

impl Default for Composer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composer_is_a_hero_control_and_dispatch_targets_the_selected_panes() {
        let mut composer = Composer::new();
        assert_eq!(composer.height, 38.0);
        assert_eq!(composer.radius, 12.0);
        composer.draft = "run the tests".into();
        composer.set_targets(["s1", "s2"]);
        let params = composer.dispatch_params();
        assert_eq!(params["action"], "send");
        assert_eq!(params["address"], "s1,s2");
        assert_eq!(params["body"], "run the tests");
        composer.throw_at((120.0, 40.0));
        let flight = composer.flight.as_mut().unwrap();
        flight.step(180.0);
        assert!(flight.done());
        let (x, y) = flight.position();
        assert!((x - 120.0).abs() < 0.1);
        assert!((y - 40.0).abs() < 0.1);
    }
}
