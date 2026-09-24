/**
 * The path rule for a file inside a granted folder is the SDK's (`@worldview/provider-sdk`,
 * `local-files.ts`, ADR-003 amendment 2026-09-23): the connectors apply it when a definition
 * is validated and before every read; the host applies it again against the real file
 * system. Re-exported here so the file connectors read as they were written.
 */
export { MAX_FILE_PATH_LENGTH, checkRelativePath, extensionOf, type PathVerdict } from '@worldview/provider-sdk';
