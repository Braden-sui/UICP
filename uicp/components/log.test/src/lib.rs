#[allow(warnings)]
mod bindings;

use bindings::exports::uicp::task_log_test::task::Guest as TaskGuest;
use bindings::wasi::logging::logging;

struct Component;

impl TaskGuest for Component {
    fn run(_job: String) {
        let _ = logging::log(logging::Level::Info, "log.test", "hello from guest");
        let _ = logging::log(logging::Level::Warn, "log.test", "be careful");
    }
}

bindings::__export_entry_impl!(Component with_types_in bindings);
