import type { Channel } from "@mindfultech/shared";
import { HashIcon, LockIcon } from "./icons";

/**
 * A channel's icon, decided by who can see it and nothing else (Phase 25):
 * private channels always get the padlock, whatever else they are (a project
 * channel, one with integrations); public channels get the hash. Project
 * channels are told apart by the 📊 Board pill in their header instead.
 */
export function ChannelIcon({
  channel,
  className = "text-ink-secondary",
}: Readonly<{ channel: Pick<Channel, "type">; className?: string }>) {
  return channel.type === "private" ? (
    <LockIcon className={className} aria-label="Private channel" />
  ) : (
    <HashIcon className={className} aria-hidden="true" />
  );
}
