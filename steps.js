/**
 * Stable step / expected ids shared by case structuring and legacy figure
 * paths. Display numbering is ignored for identity; repeated identical
 * sentences keep distinct ids in order of appearance.
 */
import crypto from 'node:crypto';

export const stepKey = (text) => String(text ?? '')
	.replace(/^(?:S\d+(?:[-.]\d+)*\.?|\d+[.、)])\s*/, '')
	.replace(/\s+/g, ' ')
	.trim();

export const stepDigest = (text) => crypto.createHash('sha1').update(stepKey(text)).digest('hex').slice(0, 10);

export function stepIds(texts, prefix = 's-') {
	const seen = new Map();
	const used = new Set();
	return (texts || []).map((text) => {
		const key = stepKey(text);
		const occurrence = (seen.get(key) || 0) + 1;
		seen.set(key, occurrence);
		const base = prefix + stepDigest(text);
		let id = occurrence > 1 ? `${base}-${occurrence}` : base;
		let next = occurrence;
		while (used.has(id)) {
			next += 1;
			id = `${base}-${next}`;
		}
		used.add(id);
		return id;
	});
}
