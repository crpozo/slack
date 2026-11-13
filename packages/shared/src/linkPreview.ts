// ---------------------------------------------------------------------------
// Link previews (Phase 63): a message with a link shows the page's title,
// description and picture under it, as chat apps do. The server reads the
// page (`GET /link-preview?url=…`); the browser never does.
// ---------------------------------------------------------------------------

export interface LinkPreview {
  /** The link the preview is for, as it was asked. */
  url: string;
  /** The page's own title ("Claude (@claudeai) on X"). */
  title: string;
  description?: string;
  /** Its picture (https), when it has one. */
  image?: string;
  /** The site's name, or its host ("x.com"). */
  site: string;
}

/** `GET /link-preview`: `null` when the page has nothing to show or can't be read. */
export interface LinkPreviewResponse {
  preview: LinkPreview | null;
}

export const LINK_PREVIEW_MAX_URL = 2_000;
