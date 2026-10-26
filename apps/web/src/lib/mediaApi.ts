import type { ChannelFilesPage, ChannelLinksPage, ChannelPins } from "@mindfultech/shared";
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
};
