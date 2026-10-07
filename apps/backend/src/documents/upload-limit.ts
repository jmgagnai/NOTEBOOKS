/**
 * The largest file a single upload accepts (NBK-15). One named figure, not a
 * literal in the plugin registration: the batch upload in the browser
 * (NBK-14) checks the same 50 MiB before it sends anything, and the two
 * must agree.
 */
export const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;

/** The limit as a user reads it, for the 413 message and any UI copy. */
export const MAX_UPLOAD_FILE_DESCRIPTION = '50 MiB';
