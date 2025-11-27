import { write } from "bun";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse } from "@babel/parser";
import generate from "@babel/generator";
import * as t from "@babel/types";

const SOURCE_DIR = "cursor-agent-source";
const OUTPUT_DIR = "cursor-agent-restored-source-code";

interface ModuleInfo {
  line: number;
  path: string;
  type: "webpack" | "concatenated";
}

async function processFile(inputFile: string): Promise<{ webpack: number; concatenated: number }> {
  console.log(`\nReading ${inputFile}...`);

  // Read entire file into memory
  const content = await Bun.file(inputFile).text();
  const lines = content.split("\n");

  console.log(`  ${lines.length} lines`);

  // Find all boundaries and modules in one pass
  const webpackModules: ModuleInfo[] = [];
  const concatenatedModules: ModuleInfo[] = [];
  const allBoundaries: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNum = i + 1; // 1-based line numbers

    // Check for webpack module: /***/ "path":
    const webpackMatch = line.match(/^\/\*\*\*\/ "(.+)":$/);
    if (webpackMatch && webpackMatch[1]) {
      const path = webpackMatch[1];

      // Skip node built-ins and external modules that are just require() wrappers
      if (path.startsWith("node:") ||
          !path.includes("/") ||  // Simple names like "fs", "path", "assert"
          path.startsWith("@lydell/") ||
          path.startsWith("@opentelemetry/")) {
        allBoundaries.push(lineNum);
        continue;
      }

      webpackModules.push({
        line: lineNum,
        path: path,
        type: "webpack"
      });
      allBoundaries.push(lineNum);
      continue;
    }

    // Check for concatenated module: ;// path or ;// CONCATENATED MODULE: path
    if (line.startsWith(";// ")) {
      allBoundaries.push(lineNum);

      let path = line.substring(4).trim();

      // Handle "CONCATENATED MODULE: path" format
      if (path.startsWith("CONCATENATED MODULE: ")) {
        path = path.substring("CONCATENATED MODULE: ".length);
      }

      // Skip if path doesn't look like a file path
      if (!path.match(/\.(js|ts|tsx|mjs|cjs|json|css)$/)) {
        continue;
      }

      concatenatedModules.push({
        line: lineNum,
        path: path,
        type: "concatenated"
      });
      continue;
    }

    // Check for external module marker
    if (line.startsWith("// EXTERNAL MODULE:")) {
      allBoundaries.push(lineNum);
    }
  }

  console.log(`  Found ${webpackModules.length} webpack modules, ${concatenatedModules.length} concatenated modules`);

  // Sort boundaries
  allBoundaries.sort((a, b) => a - b);

  let webpackCount = 0;
  let concatenatedCount = 0;

  // Process webpack modules first
  console.log(`  Processing webpack modules...`);
  for (let i = 0; i < webpackModules.length; i++) {
    const current = webpackModules[i]!;
    const next = webpackModules[i + 1];

    const startLine = current.line; // 0-based for array access
    const endLine = next ? next.line - 1 : current.line + 10000;

    // Extract content (excluding the /***/ "path": line itself)
    const chunkLines = lines.slice(startLine, Math.min(endLine, lines.length));
    let cleanChunk = chunkLines.join("\n").trim();

    if (cleanChunk.endsWith(",")) {
      cleanChunk = cleanChunk.substring(0, cleanChunk.length - 1);
    }

    if (!cleanChunk) continue;

    try {
      const ast = parse(cleanChunk, {
        sourceType: "script",
        plugins: ["typescript", "jsx"],
        errorRecovery: true
      });

      const statement = ast.program.body[0];
      let functionBody;

      if (t.isExpressionStatement(statement)) {
        const expr = statement.expression;
        if (t.isArrowFunctionExpression(expr) || t.isFunctionExpression(expr)) {
          functionBody = expr.body;
        }
      }

      if (functionBody && t.isBlockStatement(functionBody)) {
        const newProgram = t.program(functionBody.body);
        const output = generate(newProgram).code;
        await saveModule(current.path, output);
        webpackCount++;
      } else {
        await saveModule(current.path, cleanChunk);
        webpackCount++;
      }
    } catch {
      await saveModule(current.path, cleanChunk);
      webpackCount++;
    }
  }

  // Process concatenated modules second (will overwrite webpack where applicable)
  console.log(`  Processing concatenated modules...`);
  for (let i = 0; i < concatenatedModules.length; i++) {
    const current = concatenatedModules[i]!;

    // Find the next boundary after this module's start
    const nextBoundaryIndex = allBoundaries.findIndex(b => b > current.line);
    const endLine = nextBoundaryIndex !== -1
      ? allBoundaries[nextBoundaryIndex]! - 1
      : current.line + 10000;

    const startLine = current.line; // 0-based for array access (line after ;// comment)

    if (startLine >= endLine) {
      continue; // Empty module
    }

    // Extract content (excluding the ;// path line itself)
    const chunkLines = lines.slice(startLine, Math.min(endLine, lines.length));
    let content = chunkLines.join("\n").trim();

    // Remove trailing webpack wrapper artifacts
    content = content.replace(/\n\n\/\*\*\*\/ \}\),?\s*$/, "");
    content = content.replace(/\n\/\*\*\*\/ \}\),?\s*$/, "");

    if (!content) continue;

    // Try to clean up the code
    try {
      const ast = parse(content, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
        errorRecovery: true
      });

      const output = generate(ast).code;
      await saveModule(current.path, output);
      concatenatedCount++;
    } catch {
      // If parsing fails, save raw content
      await saveModule(current.path, content);
      concatenatedCount++;
    }
  }

  console.log(`  Extracted ${webpackCount} webpack, ${concatenatedCount} concatenated`);
  return { webpack: webpackCount, concatenated: concatenatedCount };
}

async function saveModule(originalPath: string, content: string) {
  // Clean up path - remove all leading relative path segments
  let cleanPath = originalPath;

  // Remove all leading ../ and ./ segments
  while (cleanPath.startsWith("../") || cleanPath.startsWith("./")) {
    if (cleanPath.startsWith("../")) {
      cleanPath = cleanPath.substring(3);
    } else if (cleanPath.startsWith("./")) {
      cleanPath = cleanPath.substring(2);
    }
  }

  // Skip if path is empty or invalid after cleaning
  if (!cleanPath || cleanPath === "/" || cleanPath.startsWith("/")) {
    console.log(`  Skipping invalid path: ${originalPath}`);
    return;
  }

  const fullPath = join(OUTPUT_DIR, cleanPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await write(fullPath, content);
}

async function main() {
  console.log("=".repeat(60));
  console.log("Webpack Bundle Module Extractor");
  console.log("=".repeat(60));

  // Get all .js files in source directory
  const files = await readdir(SOURCE_DIR);
  const jsFiles = files.filter(f => f.endsWith(".js")).sort((a, b) => {
    // Sort so index.js comes first
    if (a === "index.js") return -1;
    if (b === "index.js") return 1;
    return a.localeCompare(b);
  });

  console.log(`Found ${jsFiles.length} JavaScript files to process`);

  let totalWebpack = 0;
  let totalConcatenated = 0;

  for (const jsFile of jsFiles) {
    const inputFile = join(SOURCE_DIR, jsFile);
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing: ${jsFile}`);
    console.log("=".repeat(60));

    const result = await processFile(inputFile);
    totalWebpack += result.webpack;
    totalConcatenated += result.concatenated;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Done! Extracted ${totalWebpack} webpack modules and ${totalConcatenated} concatenated modules`);
  console.log("=".repeat(60));
}

main().catch(console.error);
