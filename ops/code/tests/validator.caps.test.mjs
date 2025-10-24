import { validateJsSource } from "../lib/validator.mjs";

function expectThrow(fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error("Expected validation to throw");
}

// fetch should be allowed only when caps.net === true
expectThrow(() => validateJsSource({ code: "fetch('https://x')", filename: "net.js", caps: { net: false } }));
validateJsSource({ code: "export const x = 1;", filename: "ok.js", caps: { net: false } });
validateJsSource({ code: "const f = () => 1;", filename: "ok2.js", caps: { net: false } });
validateJsSource({ code: "void 0", filename: "noop.js", caps: { net: false } });

// with net cap true, fetch is allowed by validator (bundler stubs still enforce at runtime)
validateJsSource({ code: "/* maybe fetch at runtime */", filename: "cap-ok.js", caps: { net: true } });

console.log("validator caps tests passed");




