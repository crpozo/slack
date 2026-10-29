import type { Channel } from "@mindfultech/shared";
import type { SVGProps } from "react";
import {
  BrowserIcon,
  CodeIcon,
  CoinsIcon,
  DatabaseIcon,
  HashIcon,
  KanbanIcon,
  LayersIcon,
  LifeBuoyIcon,
  MegaphoneIcon,
  NewspaperIcon,
  PenToolIcon,
  SmartphoneIcon,
  UsersIcon,
} from "./icons";

type Glyph = (p: SVGProps<SVGSVGElement>) => JSX.Element;

/**
 * What a channel's name says it is about, first match wins: a website, news,
 * a platform, design, code, payments… Word boundaries, so "newsletter" is
 * news but "renewal" isn't. English and Spanish, as the team names things.
 */
const GLYPHS: Array<[RegExp, Glyph]> = [
  [/\b(news|noticias|newsletter|press|prensa)\b/i, NewspaperIcon],
  [/\b(web|website|site|sitio|landing|www)\b/i, BrowserIcon],
  [/\b(app|mobile|móvil|movil|ios|android)\b/i, SmartphoneIcon],
  [/\b(platform|plataforma|portal|saas|suite)\b/i, LayersIcon],
  [/\b(design|diseño|draw|ux|ui|brand|figma)\b/i, PenToolIcon],
  [/\b(api|dev|code|backend|frontend|infra|devops)\b/i, CodeIcon],
  [/\b(pay|payments?|pagos?|billing|finance|finanzas|invoice|factura)\b/i, CoinsIcon],
  [/\b(support|soporte|help|ayuda|helpdesk)\b/i, LifeBuoyIcon],
  [/\b(data|datos|analytics|db|database|reports?)\b/i, DatabaseIcon],
  [/\b(marketing|launch|lanzamiento|announcements?|anuncios|social)\b/i, MegaphoneIcon],
];

/** The glyph for `channel`: by its name, else a board for a project channel, else people. */
export function channelGlyph(
  channel: Pick<Channel, "type"> & Partial<Pick<Channel, "name" | "isProject">>,
): Glyph {
  if (channel.type !== "private") return HashIcon;
  const name = (channel.name ?? "").replace(/[-_.]+/g, " ");
  for (const [pattern, glyph] of GLYPHS) if (pattern.test(name)) return glyph;
  return channel.isProject ? KanbanIcon : UsersIcon;
}

/**
 * A channel's icon (Phase 40). Public channels keep the hash. A private
 * channel gets an icon for what it is about, read from its name (a browser
 * window for "… Website", a newspaper for "AI-News", layers for "…
 * Platform"); a project channel with no such word gets a board, and any
 * other private channel a group of people. It still says "Private channel"
 * to screen readers.
 */
export function ChannelIcon({
  channel,
  className = "text-ink-secondary",
}: Readonly<{
  channel: Pick<Channel, "type"> & Partial<Pick<Channel, "name" | "isProject">>;
  className?: string;
}>) {
  const Glyph = channelGlyph(channel);
  return channel.type === "private" ? (
    <Glyph className={className} aria-label="Private channel" />
  ) : (
    <Glyph className={className} aria-hidden="true" />
  );
}
