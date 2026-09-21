// Registers the asset stub hooks (see asset-stub-hooks.mjs) for the node:test runner.
import { register } from 'node:module';

register('./asset-stub-hooks.mjs', import.meta.url);
