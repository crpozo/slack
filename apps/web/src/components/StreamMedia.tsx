import { useEffect, useRef } from "react";

/** `<video>`/`<audio>` bound to a MediaStream (React can't set `srcObject` as a prop). */
export function StreamMedia({
  stream,
  kind,
  muted = false,
  className,
  label,
}: Readonly<{
  stream: MediaStream | null;
  kind: "video" | "audio";
  muted?: boolean;
  className?: string;
  label?: string;
}>) {
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.srcObject === stream) return;
    el.srcObject = stream;
    if (stream) void el.play().catch(() => {}); // autoplay may need a gesture; we had one
  }, [stream]);
  if (kind === "audio") return <audio ref={ref} autoPlay className="hidden" />;
  return (
    <video ref={ref} autoPlay playsInline muted={muted} className={className} aria-label={label}>
      <track kind="captions" />
    </video>
  );
}
