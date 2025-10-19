//! script.hello@0.1.0 component entrypoint.
//! Returns a static HTML snippet from `render` for smoke testing.

#![allow(clippy::missing_errors_doc)]

mod bindings {
    wit_bindgen::generate!(
        world: "task",
        path: "../wit/world.wit",
        exports: {
            default: Component,
        }
    );
}

use bindings::exports::uicp::applet_script::script::Guest;

struct Component;

impl Guest for Component {
    fn render(_state: String) -> Result<String, String> {
        Ok("<div>hello</div>".to_string())
    }

    fn on_event(_action: String, _payload: String, state: String) -> Result<String, String> {
        // Echo back current state as JSON for now.
        Ok(format!("{{\"next_state\": {state:?}}}"))
    }

    fn init() -> Result<String, String> {
        Ok("{}".to_string())
    }
}

