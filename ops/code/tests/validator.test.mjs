import { validateJsSource } from "../lib/validator.mjs";

function expectThrow(fn) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error("Expected validation to throw");
}

// Dangerous patterns should fail
expectThrow(() => validateJsSource({ code: "eval('alert(1)')", filename: "x.js" }));
expectThrow(() => validateJsSource({ code: "new Function('return 1')", filename: "y.js" }));
expectThrow(() => validateJsSource({ code: "el.innerHTML = '<x>'", filename: "z.js" }));

// Safe code should pass
validateJsSource({ code: "export default { init(){return '{}'}, render(){return '<div/>'}, onEvent(){return '{}'} }", filename: "ok.js" });

console.log("validator tests passed");

