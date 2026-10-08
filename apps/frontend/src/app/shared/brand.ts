/**
 * The brand facts (spec 06): the product name wherever a user sees it, and
 * the two mascot images. One module so a rename or a new asset is one edit —
 * except `index.html` and `public/manifest.webmanifest`, which carry the name
 * and icon paths as literals because static files cannot read it. Trademark
 * rule (spec 06): "Microsoft" and "Copilot" never go in here.
 */
export const APP_NAME = 'Copycat Notebooks';

/**
 * The mascot's head alone (NBK-58): small enough to read at 24 px, so it is
 * the sidebar's mark and the empty states'. Rendered by `<app-copycat-mark>`.
 */
export const COPYCAT_MARK_SRC = '/copycat-mark.svg';

/**
 * The full scene — cat, notebook and pencil (NBK-58) — which only reads at
 * the sign-in and register pages' 96 px.
 */
export const COPYCAT_LOGO_SRC = '/copycat-logo.svg';
