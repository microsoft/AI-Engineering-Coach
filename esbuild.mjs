/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const isWatch = process.argv.includes("--watch");

// Bundle the extension host
const extensionBuild = esbuild.build({
	entryPoints: ["src/extension.ts"],
	bundle: true,
	platform: "node",
	target: "es2022",
	format: "cjs",
	outfile: "dist/extension.js",
	sourcemap: true,
	external: ["vscode", "better-sqlite3"],
});

// Bundle the warm-up worker (runs off the extension host thread)
const workerBuild = esbuild.build({
	entryPoints: ["src/core/warm-up-worker.ts"],
	bundle: true,
	platform: "node",
	target: "es2022",
	format: "cjs",
	outfile: "dist/warm-up-worker.js",
	sourcemap: true,
	external: ["vscode", "better-sqlite3"],
});

// Bundle the parse worker (runs the full parse pipeline off the extension host thread)
const parseWorkerBuild = esbuild.build({
	entryPoints: ["src/core/parse-worker.ts"],
	bundle: true,
	platform: "node",
	target: "es2022",
	format: "cjs",
	outfile: "dist/parse-worker.js",
	sourcemap: true,
	external: ["vscode", "better-sqlite3"],
});

// Bundle the cache write worker (writes cache data to disk off the main thread)
const cacheWriteWorkerBuild = esbuild.build({
	entryPoints: ["src/core/cache-write-worker.ts"],
	bundle: true,
	platform: "node",
	target: "es2022",
	format: "cjs",
	outfile: "dist/cache-write-worker.js",
	sourcemap: true,
	external: ["vscode", "better-sqlite3"],
});

// Bundle the webview script
const webviewBuild = esbuild.build({
	entryPoints: ["src/webview/app.ts"],
	bundle: true,
	platform: "browser",
	target: "es2022",
	format: "iife",
	outfile: "dist/webview/app.js",
	sourcemap: true,
});

await Promise.all([
	extensionBuild,
	workerBuild,
	parseWorkerBuild,
	cacheWriteWorkerBuild,
	webviewBuild,
]);

// Copy static webview assets
const webviewDist = "dist/webview";
fs.mkdirSync(webviewDist, { recursive: true });

// Copy rule markdown files to dist/rules/
const rulesSrc = "src/core/rules";
const rulesDist = "dist/rules";
fs.mkdirSync(rulesDist, { recursive: true });
if (fs.existsSync(rulesSrc)) {
	for (const file of fs
		.readdirSync(rulesSrc)
		.filter((f) => f.endsWith(".md"))) {
		fs.copyFileSync(path.join(rulesSrc, file), path.join(rulesDist, file));
	}
}

// Copy metric definition files to dist/metrics/
const metricsSrc = "src/core/metrics";
const metricsDist = "dist/metrics";
fs.mkdirSync(metricsDist, { recursive: true });
if (fs.existsSync(metricsSrc)) {
	for (const file of fs
		.readdirSync(metricsSrc)
		.filter((f) => f.endsWith(".metric.md"))) {
		fs.copyFileSync(path.join(metricsSrc, file), path.join(metricsDist, file));
	}
}

const cssSources = [
	"src/webview/styles.css",
	"src/webview/styles-pages.css",
	"src/webview/styles-skills.css",
	"src/webview/styles-learning.css",
];

function bundleCss() {
	const bundledCss = cssSources
		.map((source) => fs.readFileSync(source, "utf-8").trimEnd())
		.join("\n\n");
	fs.writeFileSync(path.join(webviewDist, "styles.css"), `${bundledCss}\n`);
}

bundleCss();

// Copy sidebar CSS separately (sidebar is its own webview)
fs.copyFileSync(
	"src/webview/styles-sidebar.css",
	path.join(webviewDist, "sidebar.css"),
);

console.log("Build complete.");

if (isWatch) {
	const ctx1 = await esbuild.context({
		entryPoints: ["src/extension.ts"],
		bundle: true,
		platform: "node",
		target: "es2022",
		format: "cjs",
		outfile: "dist/extension.js",
		sourcemap: true,
		external: ["vscode", "better-sqlite3"],
	});
	const ctx2 = await esbuild.context({
		entryPoints: ["src/core/warm-up-worker.ts"],
		bundle: true,
		platform: "node",
		target: "es2022",
		format: "cjs",
		outfile: "dist/warm-up-worker.js",
		sourcemap: true,
		external: ["vscode", "better-sqlite3"],
	});
	const ctx3 = await esbuild.context({
		entryPoints: ["src/core/parse-worker.ts"],
		bundle: true,
		platform: "node",
		target: "es2022",
		format: "cjs",
		outfile: "dist/parse-worker.js",
		sourcemap: true,
		external: ["vscode", "better-sqlite3"],
	});
	const ctx5 = await esbuild.context({
		entryPoints: ["src/core/cache-write-worker.ts"],
		bundle: true,
		platform: "node",
		target: "es2022",
		format: "cjs",
		outfile: "dist/cache-write-worker.js",
		sourcemap: true,
		external: ["vscode", "better-sqlite3"],
	});
	const ctx4 = await esbuild.context({
		entryPoints: ["src/webview/app.ts"],
		bundle: true,
		platform: "browser",
		target: "es2022",
		format: "iife",
		outfile: "dist/webview/app.js",
		sourcemap: true,
	});
	await Promise.all([
		ctx1.watch(),
		ctx2.watch(),
		ctx3.watch(),
		ctx4.watch(),
		ctx5.watch(),
	]);
	for (const source of cssSources) {
		fs.watch(source, () => {
			try {
				bundleCss();
				console.log(`CSS rebuilt (${source} changed)`);
			} catch (err) {
				console.error("CSS rebuild failed:", err);
			}
		});
	}
	console.log("Watching for changes...");
}
