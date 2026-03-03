import { readFileSync } from "node:fs";

const files = process.argv.slice(2);

if (files.length === 0) {
  console.error("No JSON files provided for strict validation.");
  process.exit(1);
}

const failures = [];

for (const filePath of files) {
  try {
    const source = readFileSync(filePath, "utf8");
    JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${filePath}: ${message}`);
  }
}

if (failures.length > 0) {
  console.error("Strict JSON validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`Strict JSON validation passed for ${files.length} file(s).`);
