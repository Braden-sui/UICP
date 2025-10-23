import { assembleQuickJS } from "../lib/assembler.mjs";
import fs from "node:fs/promises";
import path from "node:path";

// Create a temporary entry file that attempts dynamic import and DOM sinks
const tmpDir = path.join(process.cwd(), "tmp", "assembler-tests");
await fs.mkdir(tmpDir, { recursive: true });
const entry = path.join(tmpDir, "entry.ts");
await fs.writeFile(entry, `
export default {
  init(){ return '{}' },
  render(){
    // dynamic import should be blocked in bundle
    // @ts-ignore
    import('fs');
    // DOM sinks should be replaced
    document.write('x');
    const el = { innerHTML: '' } as any;
    el.innerHTML = '<x>';
    return '<div/>'
  },
  onEvent(){ return '{}' }
}
`);

const { code } = await assembleQuickJS({ entry, printJson: true });
const text = JSON.parse(code);

if (!/Dynamic import blocked/.test(text)) throw new Error("dynamic import was not blocked");
if (!/document\.write blocked/.test(text)) throw new Error("document.write was not blocked");
if (!/innerHTML assignment blocked/.test(text)) throw new Error("innerHTML was not blocked");

console.log("assembler enforcement tests passed");


