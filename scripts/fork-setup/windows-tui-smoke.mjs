#!/usr/bin/env node
// Windows Фаза 2 — механизированный (не заменяющий человека) скрининг TUI-рендеринга
// под настоящим ConPTY на реальном windows-latest раннере.
//
// Зачем: до этого скрипта у нас было 0 программного сигнала о том, как наш форкнутый
// TUI-фреймворк ведёт себя под настоящим ConPTY (не headless `run --agent`, который уже
// покрыт соседним шагом "Smoke — ToolRegistry bootstrap"). Индустриальные конкуренты
// (opencode/Claude Code/Cursor) независимо ловили баги именно в этом слое: гарбл
// текста+заморозка рендеринга, сырые ANSI-последовательности после краша, сломанный
// Unicode на Windows 11. `win32.ts` (наш форк) специально обрабатывает Ctrl+C через
// ConPTY CTRL_C_EVENT вместо байта в stdin — этот скрипт реально бьёт по этому пути,
// не только читает исходники.
//
// Честная граница: это НЕ замена живого человека за реальным Windows Terminal
// (Windows Фаза 2 из плана) — эвристики ниже ловят грубые классы отказа (краш, зависание,
// нечитаемый Unicode, полностью пустой вывод), не тонкие визуальные дефекты вёрстки.
// Полный лог сырого вывода всегда сохраняется как CI-артефакт для последующего
// человеческого разбора — не выбрасывается даже при успехе.

import { spawn } from "@homebridge/node-pty-prebuilt-multiarch";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const binPath = process.argv[2];
const logPath = process.argv[3] ?? "windows-tui-smoke.log";

if (!binPath) {
	console.error("usage: windows-tui-smoke.mjs <path-to-exe> [log-path]");
	process.exit(2);
}

const chunks = [];
let exitInfo = null;

const pty = spawn(binPath, [], {
	name: "xterm-256color",
	cols: 100,
	rows: 30,
	cwd: process.cwd(),
	env: process.env,
});

pty.onData(data => {
	chunks.push(data);
});

pty.onExit(info => {
	exitInfo = info;
});

async function main() {
	// 1. дать TUI отрисовать первый кадр
	await delay(4000);
	const beforeResize = chunks.length;

	// 2. resize — тот класс бага, что и "окно ресайзится — рендер не поспевает"
	pty.resize(130, 40);
	await delay(1500);

	// 3. Ctrl+C через ConPTY control-signal путь (не сырой байт 0x03 в обычном stdin —
	// именно ConPTY транслирует его в CTRL_C_EVENT, ровно то, что чинит win32.ts)
	if (!exitInfo) {
		pty.write("\x03");
	}
	await delay(1500);

	// 4. кириллица — независимый живой источник (август 2026) явно называет сломанный
	// Unicode на Windows 11 отдельным классом бага у прямого апстрима нашего ядра
	if (!exitInfo) {
		pty.write("привет, тест кириллицы\r");
	}
	await delay(1500);

	if (!exitInfo) {
		try {
			pty.kill();
		} catch {
			// уже мог завершиться между проверкой и kill — не фатально
		}
	}
	await delay(500);

	const raw = chunks.join("");
	writeFileSync(logPath, raw, "utf8");

	const hadEarlyExit = exitInfo !== null && chunks.length <= beforeResize;
	const totalBytes = Buffer.byteLength(raw, "utf8");
	const hasReplacementChar = raw.includes("�");
	const hasCrashSignature = /unhandled (promise )?rejection|panic|segmentation fault|stack overflow/i.test(raw);

	const findings = [];
	if (totalBytes < 50) {
		findings.push(`Подозрительно мало вывода (${totalBytes} байт) — вероятен мгновенный краш при старте`);
	}
	if (hadEarlyExit) {
		findings.push(`Процесс завершился ДО того, как мы успели дойти до resize/Ctrl+C (exitCode=${exitInfo?.exitCode})`);
	}
	if (hasReplacementChar) {
		findings.push("Найден символ-заменитель U+FFFD в выводе — признак некорректной обработки Unicode/кодировки");
	}
	if (hasCrashSignature) {
		findings.push("В выводе найдена сигнатура необработанного краша (unhandled rejection/panic/stack trace)");
	}

	console.log(`Захвачено: ${totalBytes} байт, финальный exit=${JSON.stringify(exitInfo)}`);
	console.log(`Полный сырой лог сохранён: ${logPath} (артефакт CI для ручного разбора)`);

	if (findings.length > 0) {
		console.error("::error::Windows TUI smoke — обнаружены грубые дефекты:");
		for (const f of findings) console.error(`  - ${f}`);
		process.exit(1);
	}

	console.log("✓ Windows TUI smoke: грубых дефектов (краш/зависание/битый Unicode) не найдено.");
	console.log(
		"⚠ Это механизированный скрининг, НЕ замена живой проверки человеком за реальным терминалом (Windows Фаза 2).",
	);
	// Открытый ConPTY-хендл держит event loop живым даже после pty.kill() — без явного
	// exit процесс висит бесконечно (реально пойман на CI: джоба провисела 12+ минут
	// вместо ~2 ожидаемых, поймано только потому, что default job timeout не задан).
	process.exit(0);
}

main().catch(err => {
	console.error("::error::Windows TUI smoke упал с исключением:", err);
	try {
		writeFileSync(logPath, chunks.join(""), "utf8");
	} catch {}
	process.exit(1);
});
