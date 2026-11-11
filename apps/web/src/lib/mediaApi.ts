import type {
  ChannelFilesPage,
  ChannelLinksPage,
  ChannelMediaWindow,
  ChannelPins,
} from "@mindfultech/shared";
import { request } from "./tasksApi";

// Phase 38: a conversation's files, links and pinned messages (the messages Lambda).
const at = (channelId: string, what: string, cursor?: string | null) =>
  `/channels/${encodeURIComponent(channelId)}/${what}${
    cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
  }`;

export const mediaApi = {
  files: (channelId: string, cursor?: string | null) =>
    request<ChannelFilesPage>("GET", at(channelId, "files", cursor)),
  links: (channelId: string, cursor?: string | null) =>
    request<ChannelLinksPage>("GET", at(channelId, "links", cursor)),
  pins: (channelId: string) => request<ChannelPins>("GET", at(channelId, "pins")),
  /** Phase 61: the gallery around an image (its message's `imageAt`, and its key). */
  media: (channelId: string, around: string, key: string) =>
    request<ChannelMediaWindow>(
      "GET",
      `/channels/${encodeURIComponent(channelId)}/media?around=${encodeURIComponent(
        around,
      )}&key=${encodeURIComponent(key)}`,
    ),
};
