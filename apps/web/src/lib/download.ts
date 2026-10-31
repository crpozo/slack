import { isDesktopApp } from "./desktop";
import { openExternal } from "./external";
import { saveFile } from "./upload";

/**
 * Downloads a file (Phase 47): the browser saves it under its name, nothing
 * opens. From the desktop app, the system browser saves it.
 */
export function downloadAttachment(
  file: { key: string; name: string },
  notify: (message: string) => void,
): Promise<void> {
  return saveFile(file, notify, isDesktopApp() ? openExternal : undefined);
}
