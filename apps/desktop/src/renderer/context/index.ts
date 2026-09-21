/**
 * Importing this module registers the default and built-in type-specific sections.
 * To add sections for a new object type: create `sections/<type>.tsx` that calls
 * `contextRegistry.register('<type>', [...])` and import it here (see docs/architecture/UI.md).
 */
import './default-sections.js';
import './sections.js';

export { contextRegistry, ContextRegistry, type ContextSection, type ContextSectionProps } from './registry.js';
export { DEFAULT_SECTIONS } from './default-sections.js';
export { TYPE_SECTIONS } from './sections.js';
export { displayName } from './props.js';
