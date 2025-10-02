import readline from "readline";
import { existsSync, readFileSync, writeFileSync } from "fs";

export function println(msg = "") {
  process.stdout.write(String(msg) + "\n");
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

export async function prompt(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(`${question} `, resolve));
}

export async function promptNumber(question: string, def?: number): Promise<number> {
  while (true) {
    const hint = def != null ? ` [${def}]` : "";
    const ans = (await prompt(`${question}${hint}`)).trim();
    if (!ans && def != null) return def;
    const n = Number(ans);
    if (!Number.isNaN(n) && n >= 0) return n;
    println("Please enter a valid number.");
  }
}

export async function promptSelect<T extends string>(question: string, options: { label: string; value: T }[]): Promise<T> {
  println(question);
  options.forEach((opt, i) => println(`${i + 1}) ${opt.label}`));
  while (true) {
    const ans = (await prompt("Enter choice number:"))?.trim();
    const idx = Number(ans) - 1;
    if (!Number.isNaN(idx) && idx >= 0 && idx < options.length) {
      return options[idx].value;
    }
    println("Invalid selection. Try again.");
  }
}

export function readJsonFile<T = any>(path: string): T | null {
  if (!existsSync(path)) return null;
  const txt = readFileSync(path, "utf8");
  if (!txt.trim()) return {} as any;
  return JSON.parse(txt) as T;
}

export function writeJsonFile(path: string, data: any) {
  const json = JSON.stringify(data, null, 2);
  writeFileSync(path, json + "\n", "utf8");
}

export function onExit(cb: () => void) {
  process.on("SIGINT", () => {
    println("\nExiting...");
    try { cb(); } catch {}
    rl.close();
    process.exit(0);
  });
}
