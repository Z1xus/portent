const useColor = Bun.env["NO_COLOR"] === undefined
  && Bun.env["TERM"] !== "dumb"
  && (Bun.env["FORCE_COLOR"] !== undefined || process.stdout.isTTY);

const colors = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  reset: "\x1b[0m",
} as const;

type Color = keyof typeof colors;

export function color(value: string, name: Color): string {
  return useColor ? `${colors[name]}${value}${colors.reset}` : value;
}

export function title(value: string): string {
  return color(value, "bold");
}

export function section(value: string): void {
  console.log(`\n${title(value)}`);
}

export function item(label: string, value: string): string {
  return `${color(label, "dim")}=${value}`;
}

export function pass(message: string): void {
  console.log(`  ${color("OK", "green")}    ${message}`);
}

export function fail(message: string): void {
  console.log(`  ${color("FAIL", "red")}  ${message}`);
}

export function warn(message: string): void {
  console.log(`  ${color("WARN", "yellow")}  ${message}`);
}

export function info(message: string): void {
  console.log(`  ${color("INFO", "blue")}  ${message}`);
}

export function yesNo(value: boolean): string {
  return value ? color("yes", "green") : color("no", "yellow");
}

export function status(value: "matched" | "missed"): string {
  return value === "matched" ? color("matched", "green") : color("missed", "yellow");
}
