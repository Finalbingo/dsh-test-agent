/**
 * Module scope for one request: project → module → artefacts.
 *
 * The plugin serves one user, but a streamed generation and a page refresh can
 * overlap, so the scope rides on AsyncLocalStorage instead of a module-level
 * variable — every await keeps its own module.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** @param {string} moduleId @param {() => any} fn @param {object} [config] */
export function withModule(moduleId, fn, config) {
	return storage.run({ module: moduleId || 'default', config: config || null }, fn);
}

/** Run fn in an isolated child AsyncLocalStorage frame so any enterScope inside fn never mutates the caller's frame. */
export function isolateScope(fn) {
	const cur = storage.getStore();
	return storage.run({ module: cur?.module || 'default', config: cur?.config || null }, fn);
}

/** @param {{ module?: string, config?: object | null }} scope @param {() => any} fn */
export function runScope(scope, fn) {
	return storage.run({ module: scope?.module || 'default', config: scope?.config || null }, fn);
}

/** Set the module for the current request's async context (no wrapping needed). */
export function enterModule(moduleId, config) {
	storage.enterWith({ module: moduleId || 'default', config: config === undefined ? currentConfig() : (config || null) });
}

/** One call sets both: enterWith inside an awaited callee does not reach the caller. */
export function enterScope(scope) {
	enterModule(scope?.module, scope?.config);
}

export function currentModule() {
	return storage.getStore()?.module || 'default';
}

/** The project's declarative quality config: capabilities, surfaces, sources, vocabulary. */
export function enterProjectConfig(config) {
	storage.enterWith({ module: currentModule(), config: config || null });
}

export function currentConfig() {
	return storage.getStore()?.config || {};
}

/** A capability is only active when the project declares it; nothing is assumed. */
export function hasCapability(name) {
	return (currentConfig().capabilities || []).includes(name);
}

/** Project-named surfaces extend the generic ones; a project without any still has 界面/页面. */
export function surfaces() {
	return currentConfig().surfaces || [];
}

export function defaultSurface() {
	return currentConfig().default_surface || surfaces()[0] || '目标页面';
}

export function signalPrefixes() {
	return currentConfig().signal_prefixes || [];
}

/** Declared source file for a role, so nothing silently picks the first matching file. */
export function declaredSource(role) {
	return currentConfig().sources?.[role] || '';
}

/** Compile a declared term list; an empty list matches nothing rather than everything. */
export function termsPattern(list) {
	// Longest first: alternation takes the first match, so 「dock栏」 must win over 「Dock」.
	const terms = (list || []).filter(Boolean).map((term) => String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.sort((a, b) => b.length - a.length);
	return new RegExp(terms.length ? terms.join('|') : '(?!)', 'i');
}

export function configTerms(key) {
	return currentConfig()[key] || [];
}

/** The device under test, as named in the interface definition; direction is never guessed. */
export function dutNode() {
	return currentConfig().dut_node || '';
}

export function dutLabel() {
	return currentConfig().dut_label || '被测方';
}

/** Point expansion granularity: 'standard' (equivalence + boundary) or 'exhaustive' (full enum/matrix). */
export function coverageMode() {
	return currentConfig().coverage_mode === 'exhaustive' ? 'exhaustive' : 'standard';
}

/** Whether global closed-loop rules also expand on single-entry controls (always true in exhaustive mode). */
export function includeSingleEntries() {
	return currentConfig().include_single_entries === true || coverageMode() === 'exhaustive';
}

/** Pick the module for a request, falling back to the project's first module. */
export function resolveModule(projectInfo, requested) {
	const modules = Array.isArray(projectInfo?.modules) ? projectInfo.modules : [];
	if (requested) {
		const hit = modules.find((item) => item.id === requested || item.name === requested);
		if (hit) return hit.id;
		return requested;
	}
	return modules[0]?.id || 'default';
}
