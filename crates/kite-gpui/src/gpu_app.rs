//! Presented native deck. A snapshot schedules one paint. A clean grid does not.

use gpui::prelude::*;
use gpui::{
    div, px, rgb, App, Bounds, Context, SharedString, TitlebarOptions, Window, WindowBounds,
    WindowOptions, size,
};
use gpui_platform::application;
use tokio::sync::mpsc::unbounded_channel;

use crate::headless::{DeckEvent, LaunchArgs, PanePaint};
use crate::ondemand::{self, OnDemandPanel};
use crate::theme::{self, ShellMode};

struct LiveView {
    workspace: SharedString,
    mode: ShellMode,
    status: SharedString,
    sessions: Vec<String>,
    panes: Vec<PanePaint>,
}

impl LiveView {
    fn new(workspace: SharedString) -> Self {
        Self {
            workspace,
            mode: ShellMode::Agent,
            status: SharedString::from("connecting to kite-core"),
            sessions: Vec::new(),
            panes: Vec::new(),
        }
    }

    fn apply(&mut self, event: DeckEvent) -> bool {
        match event {
            DeckEvent::Paint(state) => {
                self.sessions = state.sessions;
                self.panes = state.panes;
                true
            }
            DeckEvent::Status(text) => {
                let quit = text == "hold complete";
                self.status = SharedString::from(text);
                !quit
            }
        }
    }
}

impl Render for LiveView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let indicator = theme::stadium_indicator_x(self.mode);
        let view = cx.entity().downgrade();
        div()
            .flex()
            .flex_col()
            .size_full()
            .bg(rgb(0x0e1116))
            .text_color(rgb(0xe6edf3))
            .child(self.title_bar(indicator, view))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .overflow_hidden()
                    .child(self.sidebar())
                    .child(self.terminal_grid()),
            )
            .child(self.composer())
    }
}

impl LiveView {
    fn title_bar(&self, indicator_x: f32, view: gpui::WeakEntity<Self>) -> impl IntoElement {
        div()
            .h(px(theme::STADIUM_HEIGHT))
            .px(px(12.0))
            .flex()
            .items_center()
            .gap(px(8.0))
            .child(self.stadium(indicator_x))
            .child(div().flex_1().text_sm().child(self.status.clone()))
            .child(ondemand_button("ondemand-settings", "Settings", OnDemandPanel::Settings, view.clone()))
            .child(ondemand_button("ondemand-browser", "Browser", OnDemandPanel::Browser, view.clone()))
            .child(ondemand_button("ondemand-account", "Account", OnDemandPanel::Account, view))
    }

    fn stadium(&self, indicator_x: f32) -> impl IntoElement {
        div()
            .h(px(theme::STADIUM_HEIGHT))
            .px(px(theme::STADIUM_PADDING))
            .rounded(px(theme::STADIUM_RADIUS))
            .bg(rgb(0x090a0d))
            .border_1()
            .border_color(rgb(0xffffff).opacity(0.07))
            .flex()
            .items_center()
            .gap(px(theme::STADIUM_GAP))
            .child(mode_item("Agent", self.mode == ShellMode::Agent))
            .child(mode_item("Code", self.mode == ShellMode::Code))
            .child(mode_item("Thread", self.mode == ShellMode::Thread))
            .child(
                div()
                    .absolute()
                    .left(px(indicator_x))
                    .top(px(theme::STADIUM_PADDING))
                    .h(px(theme::STADIUM_ITEM_HEIGHT))
                    .w(px(theme::STADIUM_ITEM_MIN_WIDTH))
                    .rounded(px(theme::RADIUS_PILL))
                    .bg(rgb(0x3d8bfd)),
            )
    }

    fn sidebar(&self) -> impl IntoElement {
        let mut column = div()
            .w(px(220.0))
            .h_full()
            .p(px(8.0))
            .flex()
            .flex_col()
            .gap(px(4.0))
            .child(
                div()
                    .h(px(theme::HEIGHT_COMPACT))
                    .px(px(8.0))
                    .rounded(px(theme::RADIUS_CONTROL))
                    .bg(rgb(0x161b22))
                    .flex()
                    .items_center()
                    .child(self.workspace.clone()),
            );
        if self.sessions.is_empty() {
            column = column.child(div().text_sm().child("no sessions"));
        } else {
            for session in &self.sessions {
                column = column.child(
                    div()
                        .h(px(theme::HEIGHT_COMPACT))
                        .px(px(8.0))
                        .rounded(px(theme::RADIUS_CONTROL))
                        .text_sm()
                        .flex()
                        .items_center()
                        .child(session.clone()),
                );
            }
        }
        column
    }

    fn terminal_grid(&self) -> impl IntoElement {
        let mut row = div().flex().flex_1().gap(px(8.0)).p(px(8.0)).overflow_hidden();
        if self.panes.is_empty() {
            return row.child(div().text_sm().child("waiting for kite-core"));
        }
        for pane in &self.panes {
            row = row.child(pane_card(pane));
        }
        row
    }

    fn composer(&self) -> impl IntoElement {
        div()
            .h(px(theme::HEIGHT_HERO))
            .m(px(8.0))
            .px(px(12.0))
            .rounded(px(theme::RADIUS_CARD))
            .bg(rgb(0x161b22))
            .flex()
            .items_center()
            .child("Prompt")
    }
}

fn pane_card(pane: &PanePaint) -> impl IntoElement {
    let mut body = div()
        .flex()
        .flex_col()
        .flex_1()
        .rounded(px(theme::RADIUS_CARD))
        .border_1()
        .border_color(rgb(0x2a313c))
        .bg(rgb(0x0e1116))
        .overflow_hidden()
        .p(px(8.0))
        .child(
            div()
                .h(px(theme::HEIGHT_DENSE))
                .text_sm()
                .child(pane.title.clone()),
        );
    let shown = pane.lines.iter().filter(|line| !line.is_empty()).take(36);
    for line in shown {
        body = body.child(div().h(px(16.0)).text_xs().child(line.clone()));
    }
    body
}

fn mode_item(label: &'static str, active: bool) -> impl IntoElement {
    let color = if active { rgb(0xffffff) } else { rgb(0x838891) };
    div()
        .h(px(theme::STADIUM_ITEM_HEIGHT))
        .min_w(px(theme::STADIUM_ITEM_MIN_WIDTH))
        .px(px(theme::STADIUM_ITEM_PAD_X))
        .rounded(px(theme::RADIUS_PILL))
        .text_color(color)
        .flex()
        .items_center()
        .justify_center()
        .child(label)
}

fn ondemand_button(
    id: &'static str,
    label: &'static str,
    panel: OnDemandPanel,
    view: gpui::WeakEntity<LiveView>,
) -> impl IntoElement {
    div()
        .id(id)
        .h(px(theme::HEIGHT_COMPACT))
        .px(px(8.0))
        .rounded(px(theme::RADIUS_CONTROL))
        .bg(rgb(0x161b22))
        .text_sm()
        .flex()
        .items_center()
        .child(label)
        .on_click(move |_event, _window, cx| {
            let status = match ondemand::spawn_panel(panel) {
                Ok(()) => format!("{label} opened"),
                Err(err) => err,
            };
            view.update(cx, |this, cx| {
                this.status = SharedString::from(status);
                cx.notify();
            })
            .ok();
        })
}

pub fn run(args: LaunchArgs) {
    let (tx, rx) = unbounded_channel::<DeckEvent>();
    let io_args = args.clone();
    let hold_seconds = args.hold_seconds;
    std::thread::Builder::new()
        .name("kite-core-io".into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio runtime");
            let tx_loop = tx.clone();
            let result = runtime.block_on(crate::headless::drive(io_args, move |event| {
                let _ = tx_loop.send(event);
            }));
            if let Err(err) = result {
                let _ = tx.send(DeckEvent::Status(err));
            } else if hold_seconds > 0 {
                let _ = tx.send(DeckEvent::Status("hold complete".into()));
            }
        })
        .expect("kite-core io thread");

    let workspace = if args.workspace.is_empty() {
        SharedString::from("Kite")
    } else {
        SharedString::from(args.workspace.clone())
    };
    let mut rx_slot = Some(rx);
    application().run(move |cx: &mut App| {
        let view = cx.new(|_| LiveView::new(workspace.clone()));
        let weak = view.downgrade();
        if let Some(mut incoming) = rx_slot.take() {
            cx.spawn(async move |cx| {
                while let Some(message) = incoming.recv().await {
                    if matches!(&message, DeckEvent::Status(text) if text == "hold complete") {
                        cx.update(|app| app.quit());
                        break;
                    }
                    weak.update(cx, |view, cx| {
                        if view.apply(message) {
                            cx.notify();
                        }
                    })
                    .ok();
                }
            })
            .detach();
        }

        let bounds = Bounds::centered(None, size(px(1100.0), px(720.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(SharedString::from("Kite")),
                    appears_transparent: false,
                    traffic_light_position: None,
                }),
                ..Default::default()
            },
            move |_, _| view,
        )
        .expect("open kite-gpui window");
        cx.activate(true);
    });
}
