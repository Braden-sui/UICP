// WHY: Instruct the MSVC linker to delay-load comctl32.dll so that tests and the compute harness
// can start on hosts where v6 is unavailable. The Rust side provides a failure hook and a
// TaskDialogIndirect loader/stub so missing exports don't crash the process at startup.
// INVARIANT: This object must be linked into test/harness builds and link with delayimp.
// ERROR: E-UICP-0101 should never occur at compile time; file presence ensures build succeeds.

#ifdef _MSC_VER
#  pragma comment(linker, "/delayload:comctl32.dll")
#  pragma comment(lib, "comctl32.lib")
#endif

// Export a symbol that Rust references to force the object to be linked.
// The function has no side effects; its presence pulls in the linker pragmas above.
void uicp_force_comctl32_delayload(void) {}
